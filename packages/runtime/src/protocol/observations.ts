import type {
  CheckpointRef,
  Observation,
  ObservationKind,
  ObservationRecord,
  PublicError,
  JsonValue as PublicJsonValue,
  QueueItemSnapshot,
  StimulusKind,
  ToolCallbackOutcome,
} from "@kokoro/protocol";
import { ownerObservationDiagnosticText, ownerObservationErrorText, type UiLocale } from "../i18n/index.js";
import type { JsonValue } from "../model.js";
import type {
  EventFact,
  HippocampusJobFact,
  ObservationFact,
  PersonaFact,
  QueueItemFact,
  ToolCallFact,
} from "../store/index.js";

export interface ObservationFactResolver {
  requireQueueItem(id: string): QueueItemFact;
  requireEvent(id: string): EventFact;
  requireHippocampusJob(id: string): HippocampusJobFact;
  requireToolCall(id: string): ToolCallFact;
  getPersona?(id: string): PersonaFact | undefined;
}

export interface ObservationCorrelation {
  readonly correlationId: string;
}

/**
 * Translate one immutable append-only Runtime fact into zero or more public
 * facts. A single Runtime model fact can carry several independently useful
 * public facts, hence the stable sub-cursor.
 */
export function mapObservationFact(
  fact: ObservationFact,
  resolver: ObservationFactResolver,
  correlation: ObservationCorrelation = { correlationId: `observation:${fact.sequence}` },
): ObservationRecord[] {
  const locale = resolver.getPersona?.(fact.personaId)?.uiLocale === "zh-CN" ? "zh-CN" : "en";
  const observations = observationsFor(fact, resolver, locale);
  return observations.map((observation, index) => ({
    observationId: `observation:${fact.sequence}:${index}`,
    cursor: `${fact.sequence}.${index}`,
    personaId: fact.personaId,
    runId: fact.runId,
    eventId: fact.eventId,
    occurredAt: timestamp(fact.createdAt),
    correlationId: correlation.correlationId,
    observation,
  }));
}

function observationsFor(
  fact: ObservationFact,
  resolver: ObservationFactResolver,
  locale: UiLocale,
): Observation[] {
  const payload = object(fact.payload);
  const producerProblem = producerFactProblem(fact.kind, payload);
  if (producerProblem !== null) {
    return [
      {
        kind: "diagnostic",
        severity: "error",
        code: "invalid_internal_fact",
        message: ownerObservationDiagnosticText(locale, "invalid_internal_fact"),
        details: { sourceKind: fact.kind, problem: producerProblem },
      },
    ];
  }
  switch (fact.kind) {
    case "model_request":
      return [modelInput(payload)];
    case "model_stream":
      return modelStreamObservations(payload);
    case "model_attempt_completed":
    case "model_attempt_failed":
      // Direct append-time provider/cognition/usage observations are emitted by
      // the Runtime. These storage bookkeeping facts must not duplicate them.
      return [];
    case "provider_attempt":
      return [directProviderAttempt(payload, locale)];
    case "internal_cognition":
      return [directCognition(fact, payload)];
    case "usage":
      return [directUsage(payload)];
    case "hippocampus_model_request":
      return [hippocampusModelInput(payload)];
    case "hippocampus_model_stream":
      return hippocampusStreamObservations(payload);
    case "tool_proposal":
      return [toolProposal(payload, fact.createdAt)];
    case "tool_dispatch":
      return [toolDispatch(payload, fact.createdAt, locale)];
    case "tool_outcome":
      return [toolOutcome(payload, locale)];
    case "tool_callback":
      return [toolCallback(payload, locale)];
    case "event_committed":
      return [eventCommitted(fact, payload, resolver)];
    case "publication":
      return [publication(fact, payload, resolver, locale)];
    case "hippocampus":
      return [hippocampus(fact, payload, resolver, locale)];
    case "lifecycle":
      return [lifecycle(payload)];
    case "queue": {
      const mapped = queue(payload, resolver, fact.createdAt);
      return mapped === null ? [diagnostic(fact.kind, payload, "queue_item_not_public", locale)] : [mapped];
    }
    case "diagnostic":
      return [diagnosticFromPayload(payload, locale)];
    default:
      return [diagnostic(fact.kind, payload, "internal_observation", locale)];
  }
}

/**
 * Runtime facts are trusted storage, not trusted protocol DTOs. Validate the
 * producer fields which carry causal meaning before mapping; malformed facts
 * become diagnostics instead of being guessed into dispatched/succeeded/
 * delivered states.
 */
function producerFactProblem(kind: string, payload: Record<string, JsonValue>): string | null {
  switch (kind) {
    case "model_request":
      return firstProblem([
        requiredId(payload["attemptId"], "attemptId"),
        requiredEnum(payload["role"], ["persona", "closeout", "compaction"] as const, "role"),
        requiredObject(payload["request"], "request"),
      ]);
    case "provider_attempt": {
      const state = requiredEnum(
        payload["state"],
        ["started", "completed", "retry_wait", "failed", "aborted"] as const,
        "state",
      );
      const terminalWithError =
        payload["state"] === "retry_wait" || payload["state"] === "failed" || payload["state"] === "aborted";
      return firstProblem([
        requiredId(payload["attemptId"], "attemptId"),
        requiredId(payload["turnId"], "turnId"),
        requiredPositiveCount(payload["attempt"], "attempt"),
        requiredId(payload["providerId"], "providerId"),
        requiredId(payload["modelId"], "modelId"),
        state,
        payload["state"] === "retry_wait"
          ? requiredIso(payload["retryAt"], "retryAt")
          : payload["retryAt"] === null
            ? null
            : "retryAt must be null unless state is retry_wait",
        terminalWithError && !hasCodeObject(payload["error"])
          ? "error.code is required for retry_wait/failed/aborted provider attempts"
          : !terminalWithError && payload["error"] !== null
            ? "error must be null for started/completed provider attempts"
            : null,
      ]);
    }
    case "internal_cognition":
      return firstProblem([
        requiredId(payload["attemptId"], "attemptId"),
        requiredEnum(payload["channel"], ["reasoning", "assistant"] as const, "channel"),
        typeof payload["content"] === "string" ? null : "content must be a string",
        requiredEnum(
          payload["attemptState"],
          ["streaming", "completed", "failed", "aborted"] as const,
          "attemptState",
        ),
        payload["externalMessage"] === false ? null : "externalMessage must be false",
      ]);
    case "usage":
      return firstProblem([
        requiredId(payload["attemptId"], "attemptId"),
        requiredCount(payload["inputTokens"], "inputTokens"),
        requiredCount(payload["outputTokens"], "outputTokens"),
        requiredCount(payload["cachedInputTokens"], "cachedInputTokens"),
      ]);
    case "tool_proposal":
      return firstProblem([
        requiredId(payload["attemptId"], "attemptId"),
        requiredId(payload["toolCallId"], "toolCallId"),
        requiredId(payload["toolName"], "toolName"),
        hasOwn(payload, "arguments") ? null : "arguments is required",
        requiredEpoch(payload["proposedAt"], "proposedAt"),
      ]);
    case "tool_dispatch": {
      const state = requiredEnum(payload["state"], ["blocked", "dispatched"] as const, "state");
      return firstProblem([
        requiredId(payload["toolCallId"], "toolCallId"),
        requiredId(payload["dispatchId"], "dispatchId"),
        requiredId(payload["intentId"], "intentId"),
        state,
        requiredEnum(payload["externalEffect"], ["none", "possible"] as const, "externalEffect"),
        Array.isArray(payload["authority"]) && payload["authority"].length > 0
          ? null
          : "authority decision history is required",
        payload["state"] === "blocked" && typeof payload["code"] !== "string"
          ? "code is required for a blocked dispatch"
          : null,
      ]);
    }
    case "tool_outcome": {
      const state = requiredEnum(payload["state"], ["succeeded", "failed", "unknown"] as const, "state");
      return firstProblem([
        requiredId(payload["toolCallId"], "toolCallId"),
        requiredId(payload["dispatchId"], "dispatchId"),
        state,
        requiredEnum(payload["externalEffect"], ["none", "confirmed", "unknown"] as const, "externalEffect"),
        hasOwn(payload, "result") ? null : "result is required",
        payload["state"] === "unknown" &&
        (payload["externalEffect"] !== "unknown" || payload["result"] !== null)
          ? "unknown outcome must have unknown external effect and null result"
          : null,
        payload["state"] === "failed" &&
        typeof payload["code"] !== "string" &&
        typeof object(payload["result"])["code"] !== "string"
          ? "failed outcome requires a code"
          : null,
      ]);
    }
    case "tool_callback":
      return firstProblem([
        requiredId(payload["toolCallId"], "toolCallId"),
        requiredId(payload["callbackId"], "callbackId"),
        callbackProblem(payload["outcome"]),
      ]);
    case "event_committed": {
      const checkpoint = object(payload["checkpoint"]);
      return firstProblem([
        requiredId(payload["eventId"], "eventId"),
        requiredStringArray(payload["sourceWorkItemIds"], "sourceWorkItemIds"),
        typeof payload["summary"] === "string" ? null : "summary must be a string",
        typeof payload["needsMemory"] === "boolean" ? null : "needsMemory must be a boolean",
        requiredId(checkpoint["checkpointId"], "checkpoint.checkpointId"),
        requiredId(checkpoint["commitId"], "checkpoint.commitId"),
        typeof checkpoint["summary"] === "string" ? null : "checkpoint.summary must be a string",
        requiredIso(checkpoint["createdAt"], "checkpoint.createdAt"),
        requiredIso(payload["committedAt"], "committedAt"),
      ]);
    }
    case "publication": {
      const state = requiredEnum(
        payload["state"],
        ["pending", "delivering", "delivered", "retry_wait", "failed"] as const,
        "state",
      );
      return firstProblem([
        requiredId(payload["publicationId"], "publicationId"),
        requiredId(payload["eventId"], "eventId"),
        requiredId(payload["checkpointId"], "checkpointId"),
        state,
        requiredCount(payload["attempt"], "attempt"),
        nullableIso(payload["retryAt"], "retryAt"),
        hasOwn(payload, "receipt") ? null : "receipt is required",
        payload["state"] === "failed" && !hasCodeObject(payload["error"])
          ? "failed publication requires error.code"
          : null,
      ]);
    }
    case "hippocampus": {
      const state = requiredEnum(
        payload["state"],
        ["queued", "running", "applied", "retry_wait", "failed", "conflict"] as const,
        "state",
      );
      return firstProblem([
        requiredId(payload["jobId"], "jobId"),
        requiredId(payload["eventId"], "eventId"),
        requiredId(payload["checkpointId"], "checkpointId"),
        state,
        requiredCount(payload["attempt"], "attempt"),
        nullableIso(payload["retryAt"], "retryAt"),
        (payload["state"] === "failed" || payload["state"] === "conflict") && !hasCodeObject(payload["error"])
          ? "failed/conflicted Hippocampus fact requires error.code"
          : null,
      ]);
    }
    case "lifecycle":
      return firstProblem([
        requiredEnum(
          payload["phase"],
          [
            "draft",
            "initialized",
            "ready",
            "running",
            "pausing",
            "paused",
            "stopping",
            "stopped",
            "forced",
            "crashed",
            "faulted",
            "failed",
          ] as const,
          "phase",
        ),
        nullableString(payload["runId"], "runId"),
        nullableString(payload["reason"], "reason"),
      ]);
    case "queue":
      return firstProblem([
        requiredId(payload["workItemId"], "workItemId"),
        requiredEnum(
          payload["action"],
          ["accepted", "activated", "frozen", "completed", "discarded"] as const,
          "action",
        ),
      ]);
    case "diagnostic":
      return requiredId(payload["code"], "code");
    case "hippocampus_model_request":
      return firstProblem([
        requiredId(payload["jobId"], "jobId"),
        requiredCount(payload["attempt"], "attempt"),
        requiredObject(payload["request"], "request"),
      ]);
    default:
      return null;
  }
}

function firstProblem(problems: readonly (string | null)[]): string | null {
  return problems.find((problem): problem is string => problem !== null) ?? null;
}

function requiredId(value: JsonValue | undefined, name: string): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !hasLoneSurrogate(value)
    ? null
    : `${name} must be a protocol-safe non-empty string`;
}

function requiredEnum<const T extends string>(
  value: JsonValue | undefined,
  choices: readonly T[],
  name: string,
): string | null {
  return typeof value === "string" && choices.includes(value as T) ? null : `${name} has an invalid value`;
}

function requiredObject(value: JsonValue | undefined, name: string): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? null
    : `${name} must be an object`;
}

function requiredCount(value: JsonValue | undefined, name: string): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? null
    : `${name} must be a non-negative integer`;
}

function requiredPositiveCount(value: JsonValue | undefined, name: string): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? null
    : `${name} must be a positive integer`;
}

function requiredEpoch(value: JsonValue | undefined, name: string): string | null {
  return typeof value === "number" && Number.isFinite(value) ? null : `${name} must be an epoch number`;
}

function requiredIso(value: JsonValue | undefined, name: string): string | null {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? null
    : `${name} must be an ISO timestamp`;
}

function nullableIso(value: JsonValue | undefined, name: string): string | null {
  return value === null || value === undefined ? null : requiredIso(value, name);
}

function nullableString(value: JsonValue | undefined, name: string): string | null {
  return value === null || value === undefined || typeof value === "string"
    ? null
    : `${name} must be a string or null`;
}

function requiredStringArray(value: JsonValue | undefined, name: string): string | null {
  return Array.isArray(value) && value.length > 0 && value.every((item) => requiredId(item, name) === null)
    ? null
    : `${name} must be a non-empty string array`;
}

function hasLoneSurrogate(value: string): boolean {
  return [...value].some((character) => {
    if (character.length !== 1) return false;
    const code = character.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdfff;
  });
}

function hasOwn(value: Record<string, JsonValue>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function hasCodeObject(value: JsonValue | undefined): boolean {
  return typeof object(value)["code"] === "string";
}

function callbackProblem(value: JsonValue | undefined): string | null {
  const outcome = object(value);
  if (outcome["state"] === "succeeded")
    return hasOwn(outcome, "result") ? null : "callback result is required";
  if (outcome["state"] === "failed")
    return hasCodeObject(outcome["error"]) ? null : "callback error is required";
  if (outcome["state"] === "unknown")
    return typeof outcome["reason"] === "string" ? null : "callback reason is required";
  return "callback outcome state is invalid";
}

function modelInput(payload: Record<string, JsonValue>): Extract<Observation, { kind: "model_input" }> {
  const attemptId = text(payload["attemptId"], "attempt:unknown");
  const request = object(payload["request"]);
  return {
    kind: "model_input",
    role: modelRole(payload["role"] ?? request["role"]),
    attemptId,
    content: JSON.stringify(request),
    redacted: false,
  };
}

function modelStreamObservations(payload: Record<string, JsonValue>): Observation[] {
  const stream = object(payload["stream"]);
  const attemptId = text(payload["attemptId"], "attempt:unknown");
  const type = text(stream["type"], "unknown");
  if (type === "reasoning_delta" || type === "text_delta") {
    return [
      {
        kind: "internal_cognition",
        attemptId,
        channel: type === "reasoning_delta" ? "reasoning" : "assistant",
        sequence: nonNegativeInteger(payload["attempt"], 0),
        content: text(stream["delta"], ""),
        attemptState: "streaming",
        externalMessage: false,
      },
    ];
  }
  // request_started/response_completed have dedicated append-time facts.
  return [];
}

function directProviderAttempt(
  payload: Record<string, JsonValue>,
  locale: UiLocale,
): Extract<Observation, { kind: "provider_attempt" }> {
  const state = enumValue(
    payload["state"],
    ["started", "completed", "retry_wait", "failed", "aborted"] as const,
    "failed",
  );
  const errorFact = object(payload["error"]);
  const code = textOrNull(errorFact["code"] ?? payload["code"]);
  return {
    kind: "provider_attempt",
    attemptId: text(payload["attemptId"], "attempt:unknown"),
    turnId: text(payload["turnId"], "turn:unknown"),
    attempt: nonNegativeInteger(payload["attempt"], 1),
    providerId: text(payload["providerId"], "provider:unknown"),
    modelId: text(payload["modelId"], "model:unknown"),
    state,
    retryAt: isoOrNull(payload["retryAt"]),
    error:
      state === "retry_wait" || state === "failed" || state === "aborted"
        ? publicError(code ?? state, locale, state === "retry_wait")
        : null,
  };
}

function directCognition(
  fact: ObservationFact,
  payload: Record<string, JsonValue>,
): Extract<Observation, { kind: "internal_cognition" }> {
  return {
    kind: "internal_cognition",
    attemptId: text(payload["attemptId"], "attempt:unknown"),
    channel: payload["channel"] === "reasoning" ? "reasoning" : "assistant",
    sequence: nonNegativeInteger(payload["sequence"], fact.sequence),
    content: text(payload["content"], ""),
    attemptState: enumValue(
      payload["attemptState"],
      ["streaming", "completed", "failed", "aborted"] as const,
      "completed",
    ),
    externalMessage: false,
  };
}

function directUsage(payload: Record<string, JsonValue>): Extract<Observation, { kind: "usage" }> {
  return {
    kind: "usage",
    attemptId: text(payload["attemptId"], "attempt:unknown"),
    inputTokens: nonNegativeInteger(payload["inputTokens"], 0),
    outputTokens: nonNegativeInteger(payload["outputTokens"], 0),
    cachedInputTokens: nonNegativeInteger(payload["cachedInputTokens"], 0),
  };
}

function hippocampusModelInput(
  payload: Record<string, JsonValue>,
): Extract<Observation, { kind: "model_input" }> {
  const jobId = text(payload["jobId"], "job:unknown");
  const request = object(payload["request"]);
  const attemptId = text(
    payload["attemptId"],
    `${jobId}:attempt:${nonNegativeInteger(payload["attempt"], 0)}`,
  );
  return {
    kind: "model_input",
    role: "hippocampus",
    attemptId,
    content: JSON.stringify(request),
    redacted: false,
  };
}

function hippocampusStreamObservations(payload: Record<string, JsonValue>): Observation[] {
  const jobId = text(payload["jobId"], "job:unknown");
  const attempt = nonNegativeInteger(payload["attempt"], 0);
  const stream = object(payload["stream"]);
  const type = text(stream["type"], "unknown");
  if (type !== "reasoning_delta" && type !== "text_delta") return [];
  return [
    {
      kind: "internal_cognition",
      attemptId: text(payload["attemptId"], `${jobId}:attempt:${attempt}`),
      channel: type === "reasoning_delta" ? "reasoning" : "assistant",
      sequence: attempt,
      content: text(stream["delta"], ""),
      attemptState: "streaming",
      externalMessage: false,
    },
  ];
}

function toolProposal(
  payload: Record<string, JsonValue>,
  occurredAt: number,
): Extract<Observation, { kind: "tool_proposal" }> {
  return {
    kind: "tool_proposal",
    attemptId: text(payload["attemptId"], "attempt:unknown"),
    toolCallId: text(payload["toolCallId"], "tool-call:unknown"),
    toolName: text(payload["toolName"], "unknown_tool"),
    arguments: publicJson(payload["arguments"] ?? null),
    proposedAt: timestamp(number(payload["proposedAt"], occurredAt)),
  };
}

function toolDispatch(
  payload: Record<string, JsonValue>,
  occurredAt: number,
  locale: UiLocale,
): Extract<Observation, { kind: "tool_dispatch" }> {
  const toolCallId = text(payload["toolCallId"], "tool-call:unknown");
  const state = payload["state"] === "blocked" ? "blocked" : "dispatched";
  const code = text(payload["code"], state === "blocked" ? "permission_denied" : "");
  return {
    kind: "tool_dispatch",
    toolCallId,
    dispatchId: text(payload["dispatchId"], toolCallId),
    intentId: text(payload["intentId"], toolCallId),
    state,
    checkedAt: timestamp(number(payload["checkedAt"], occurredAt)),
    externalEffect: payload["externalEffect"] === "possible" ? "possible" : "none",
    authority: authorityDecisions(payload["authority"]),
    receipt: publicJson(payload["receipt"] ?? null),
    denial: state === "blocked" ? publicError(code, locale) : null,
  };
}

function authorityDecisions(value: JsonValue | undefined): Array<{
  decisionId: string;
  stage: "proposal" | "dispatch";
  allowed: boolean;
  revision: string;
  reason: string | null;
  checkedAt: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const decision = object(item);
    return {
      decisionId: text(decision["decisionId"], `authority:${index}`),
      stage: decision["stage"] === "dispatch" ? "dispatch" : "proposal",
      allowed: decision["allowed"] === true,
      revision: text(decision["revision"], "unknown"),
      reason: textOrNull(decision["reason"]),
      checkedAt: iso(decision["checkedAt"], new Date(0).toISOString()),
    };
  });
}

function toolOutcome(
  payload: Record<string, JsonValue>,
  locale: UiLocale,
): Extract<Observation, { kind: "tool_outcome" }> {
  const toolCallId = text(payload["toolCallId"], "tool-call:unknown");
  const state = enumValue(payload["state"], ["succeeded", "failed", "unknown"] as const, "failed");
  const resultFact = object(payload["result"]);
  const code = text(
    payload["code"] ?? resultFact["code"],
    state === "unknown" ? "outcome_unknown" : "tool_failed",
  );
  return {
    kind: "tool_outcome",
    toolCallId,
    dispatchId: text(payload["dispatchId"], toolCallId),
    state,
    externalEffect:
      state === "unknown" ? "unknown" : payload["externalEffect"] === "confirmed" ? "confirmed" : "none",
    result: state === "unknown" ? null : publicJson(payload["result"] ?? null),
    error: state === "succeeded" ? null : publicError(state === "unknown" ? "outcome_unknown" : code, locale),
  };
}

function toolCallback(
  payload: Record<string, JsonValue>,
  locale: UiLocale,
): Extract<Observation, { kind: "tool_callback" }> {
  return {
    kind: "tool_callback",
    toolCallId: text(payload["toolCallId"], "tool-call:unknown"),
    callbackId: text(payload["callbackId"], "callback:unknown"),
    outcome: callbackOutcome(payload["outcome"], locale),
  };
}

function callbackOutcome(value: JsonValue | undefined, locale: UiLocale): ToolCallbackOutcome {
  const candidate = object(value);
  if (candidate["state"] === "succeeded") {
    return { state: "succeeded", result: publicJson(candidate["result"] ?? null) };
  }
  if (candidate["state"] === "failed") {
    const error = object(candidate["error"]);
    const runtimeCode = text(object(error["details"])["runtimeCode"] ?? error["code"], "tool_failed");
    return {
      state: "failed",
      error: isPublicError(error)
        ? localizedPublicError(publicJson(error) as unknown as PublicError, runtimeCode, locale)
        : publicError(runtimeCode, locale),
    };
  }
  if (candidate["state"] === "unknown") {
    return { state: "unknown", reason: text(candidate["reason"], "outcome_unknown") };
  }
  return { state: "succeeded", result: publicJson(value ?? null) };
}

function eventCommitted(
  fact: ObservationFact,
  payload: Record<string, JsonValue>,
  resolver: ObservationFactResolver,
): Extract<Observation, { kind: "event_committed" }> {
  const eventId = text(payload["eventId"], fact.eventId ?? "event:unknown");
  const event = safeResolve(() => resolver.requireEvent(eventId));
  const commit = text(
    payload["checkpointId"] ?? payload["commitId"],
    event?.checkpoint ?? "checkpoint:unknown",
  );
  const checkpoint = checkpointRef(payload["checkpoint"], {
    checkpointId: commit,
    commitId: commit,
    summary: text(payload["summary"], event?.summary ?? "Committed Event"),
    createdAt: timestamp(number(payload["committedAt"], event?.checkpointedAt ?? fact.createdAt)),
  });
  const sourceIds = stringArray(payload["sourceWorkItemIds"]);
  return {
    kind: "event_committed",
    eventId,
    sourceWorkItemIds: sourceIds.length > 0 ? sourceIds : [event?.queueItemId ?? `work:${eventId}`],
    summary: text(payload["summary"], event?.summary ?? checkpoint.summary),
    needsMemory: boolean(payload["needsMemory"], event?.memoryDecision === "maintain"),
    checkpoint,
    committedAt: timestamp(number(payload["committedAt"], event?.checkpointedAt ?? fact.createdAt)),
  };
}

function publication(
  fact: ObservationFact,
  payload: Record<string, JsonValue>,
  resolver: ObservationFactResolver,
  locale: UiLocale,
): Extract<Observation, { kind: "publication" }> {
  const eventId = text(payload["eventId"], fact.eventId ?? "event:unknown");
  const event = safeResolve(() => resolver.requireEvent(eventId));
  const state = enumValue(
    payload["state"],
    ["pending", "delivering", "delivered", "retry_wait", "failed"] as const,
    "delivered",
  );
  const runtimeCode = textOrNull(object(payload["error"])["code"] ?? payload["code"]);
  return {
    kind: "publication",
    publicationId: text(payload["publicationId"], `publication:${eventId}`),
    eventId,
    checkpointId: text(payload["checkpointId"], event?.checkpoint ?? "checkpoint:unknown"),
    state,
    attempt: nonNegativeInteger(payload["attempt"], state === "pending" ? 0 : 1),
    retryAt: isoOrNull(payload["retryAt"]),
    receipt: publicJson(payload["receipt"] ?? (state === "delivered" ? { committed: true } : null)),
    error:
      runtimeCode !== null || state === "failed"
        ? publicError(runtimeCode ?? "publication_failed", locale, state === "retry_wait")
        : null,
  };
}

function hippocampus(
  fact: ObservationFact,
  payload: Record<string, JsonValue>,
  resolver: ObservationFactResolver,
  locale: UiLocale,
): Extract<Observation, { kind: "hippocampus" }> {
  const jobId = text(payload["jobId"], "job:unknown");
  const job = safeResolve(() => resolver.requireHippocampusJob(jobId));
  const state = enumValue(
    payload["state"],
    ["queued", "running", "applied", "retry_wait", "failed", "conflict"] as const,
    "failed",
  );
  const runtimeCode = textOrNull(object(payload["error"])["code"] ?? payload["code"]);
  return {
    kind: "hippocampus",
    jobId,
    eventId: text(payload["eventId"], fact.eventId ?? job?.eventId ?? "event:unknown"),
    checkpointId: text(payload["checkpointId"], job?.sourceCheckpoint ?? "checkpoint:unknown"),
    state,
    attempt: nonNegativeInteger(payload["attempt"], job?.attempts ?? 0),
    retryAt: isoOrNull(payload["retryAt"]),
    error:
      runtimeCode !== null || state === "failed" || state === "conflict"
        ? publicError(
            runtimeCode ?? (state === "conflict" ? "memory_conflict" : "hippocampus_failed"),
            locale,
            state === "retry_wait",
          )
        : null,
  };
}

function lifecycle(payload: Record<string, JsonValue>): Extract<Observation, { kind: "lifecycle" }> {
  const raw = text(payload["phase"], "failed");
  const phase =
    raw === "ready" || raw === "initialized"
      ? "initialized"
      : raw === "forced" || raw === "stopped"
        ? "stopped"
        : raw === "crashed" || raw === "faulted"
          ? "failed"
          : enumValue(
              raw,
              ["draft", "running", "pausing", "paused", "stopping", "forcing", "failed"] as const,
              "failed",
            );
  return {
    kind: "lifecycle",
    phase,
    runId: textOrNull(payload["runId"]),
    reason: textOrNull(payload["reason"]),
  };
}

function queue(
  payload: Record<string, JsonValue>,
  resolver: ObservationFactResolver,
  occurredAt: number,
): Extract<Observation, { kind: "queue" }> | null {
  const workItemId = text(payload["workItemId"], "");
  if (workItemId === "") return null;
  const item = safeResolve(() => resolver.requireQueueItem(workItemId));
  const source = text(payload["source"], item?.kind ?? "");
  if (source !== "stimulus" && source !== "continuation") return null;
  const action = enumValue(
    payload["action"],
    ["accepted", "activated", "frozen", "completed", "discarded"] as const,
    "accepted",
  );
  const state: QueueItemSnapshot["state"] =
    action === "activated" || action === "completed"
      ? "active"
      : action === "frozen"
        ? "frozen_by_pause"
        : "pending";
  return {
    kind: "queue",
    workItem: {
      workItemId,
      source,
      state,
      acceptedAt: timestamp(item?.acceptedAt ?? number(payload["acceptedAt"], occurredAt)),
      stimulusKind: source === "stimulus" ? stimulusKind(payload["stimulusKind"], item?.payload) : null,
    },
    action,
  };
}

function stimulusKind(value: JsonValue | undefined, itemPayload: JsonValue | undefined): StimulusKind | null {
  const direct = enumValueOrNull(value, [
    "user_message",
    "system_event",
    "scheduled",
    "external_change",
  ] as const);
  if (direct !== null) return direct;
  const stored = object(itemPayload);
  return enumValueOrNull(stored["kind"], [
    "user_message",
    "system_event",
    "scheduled",
    "external_change",
  ] as const);
}

function diagnosticFromPayload(
  payload: Record<string, JsonValue>,
  locale: UiLocale,
): Extract<Observation, { kind: "diagnostic" }> {
  const code = text(payload["code"], "runtime_diagnostic");
  return {
    kind: "diagnostic",
    severity: enumValue(payload["severity"], ["info", "warning", "error"] as const, "warning"),
    code,
    message: ownerObservationDiagnosticText(locale, code),
    details: diagnosticDetails(payload, code),
  };
}

function diagnostic(
  sourceKind: string,
  payload: Record<string, JsonValue>,
  code: string,
  locale: UiLocale,
): Extract<Observation, { kind: "diagnostic" }> {
  return {
    kind: "diagnostic",
    severity: "info",
    code,
    message: ownerObservationDiagnosticText(locale, code),
    details: publicJson({ ...payload, runtimeCode: code, sourceKind }),
  };
}

function diagnosticDetails(payload: Record<string, JsonValue>, code: string): PublicJsonValue {
  const details: Record<string, JsonValue> = { ...object(payload["details"]) };
  for (const [key, value] of Object.entries(payload)) {
    if (key === "code" || key === "details" || key === "message" || key === "severity") continue;
    details[key] = value;
  }
  details["runtimeCode"] = code;
  return publicJson(details);
}

function checkpointRef(value: JsonValue | undefined, fallback: CheckpointRef): CheckpointRef {
  const candidate = object(value);
  if (Object.keys(candidate).length === 0) return fallback;
  return {
    checkpointId: text(candidate["checkpointId"], fallback.checkpointId),
    commitId: text(candidate["commitId"], fallback.commitId),
    summary: text(candidate["summary"], fallback.summary),
    createdAt: iso(candidate["createdAt"], fallback.createdAt),
  };
}

function publicError(code: string, locale: UiLocale, retryableOverride?: boolean): PublicError {
  const mapped =
    code === "permission_denied" || code === "permission_revoked_before_dispatch"
      ? "permission_denied"
      : code === "outcome_unknown" || code === "external_outcome_unknown"
        ? "outcome_unknown"
        : code === "rate_limited"
          ? "rate_limited"
          : code === "unavailable" || code === "model_unavailable"
            ? "unavailable"
            : "internal_error";
  return {
    code: mapped,
    message: ownerObservationErrorText(locale, mapped, code),
    retryable: retryableOverride ?? (mapped === "rate_limited" || mapped === "unavailable"),
    details: { runtimeCode: code },
  };
}

function localizedPublicError(error: PublicError, runtimeCode: string, locale: UiLocale): PublicError {
  return {
    code: error.code,
    message: ownerObservationErrorText(locale, error.code, runtimeCode),
    retryable: error.retryable,
    details: publicErrorDetails(runtimeCode, error.details),
  };
}

function publicErrorDetails(runtimeCode: string, sourceDetails: PublicJsonValue): PublicJsonValue {
  if (typeof sourceDetails === "object" && sourceDetails !== null && !Array.isArray(sourceDetails)) {
    return { ...sourceDetails, runtimeCode };
  }
  return sourceDetails === null ? { runtimeCode } : { runtimeCode, sourceDetails };
}

function isPublicError(value: Record<string, JsonValue>): boolean {
  return (
    typeof value["code"] === "string" &&
    typeof value["message"] === "string" &&
    typeof value["retryable"] === "boolean" &&
    value["details"] !== undefined
  );
}

function modelRole(value: JsonValue | undefined): "persona" | "closeout" | "hippocampus" | "compaction" {
  return enumValue(value, ["persona", "closeout", "hippocampus", "compaction"] as const, "persona");
}

function publicJson(value: JsonValue): PublicJsonValue {
  return value as PublicJsonValue;
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function text(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function textOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolean(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nonNegativeInteger(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function iso(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function isoOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
}

function enumValue<const T extends string>(
  value: JsonValue | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : fallback;
}

function enumValueOrNull<const T extends string>(
  value: JsonValue | undefined,
  choices: readonly T[],
): T | null {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : null;
}

function safeResolve<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

export function parseObservationCursor(cursor: string | null): { sequence: number; subIndex: number } {
  if (cursor === null) return { sequence: 0, subIndex: -1 };
  const match = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u.exec(cursor);
  if (!match) throw new Error("Invalid observation cursor.");
  const sequence = Number(match[1]);
  const subIndex = match[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(subIndex)) {
    throw new Error("Invalid observation cursor.");
  }
  return { sequence, subIndex };
}

export function compareObservationCursor(
  cursor: string,
  after: { sequence: number; subIndex: number },
): number {
  const current = parseObservationCursor(cursor);
  return current.sequence === after.sequence
    ? current.subIndex - after.subIndex
    : current.sequence - after.sequence;
}

export function isObservationKind(value: string): value is ObservationKind {
  return [
    "model_input",
    "internal_cognition",
    "provider_attempt",
    "usage",
    "tool_proposal",
    "tool_dispatch",
    "tool_outcome",
    "tool_callback",
    "event_committed",
    "publication",
    "hippocampus",
    "lifecycle",
    "queue",
    "diagnostic",
  ].includes(value as ObservationKind);
}
