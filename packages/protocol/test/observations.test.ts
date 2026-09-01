import { expect, it } from "vitest";
import {
  type EventEnvelope,
  OBSERVATION_KINDS,
  type Observation,
  type PublicError,
  parseServerEnvelope,
} from "../src/index.js";

const at = "2026-08-30T00:00:00.000Z";
const denied: PublicError = {
  code: "permission_denied",
  message: "Authorization was revoked before dispatch",
  retryable: false,
  details: null,
};

const observations: readonly Observation[] = [
  { kind: "model_input", role: "persona", attemptId: "attempt", content: "prompt", redacted: true },
  {
    kind: "internal_cognition",
    attemptId: "attempt",
    channel: "reasoning",
    sequence: 0,
    content: "private reasoning",
    attemptState: "failed",
    externalMessage: false,
  },
  {
    kind: "provider_attempt",
    attemptId: "attempt",
    turnId: "turn",
    attempt: 1,
    providerId: "provider",
    modelId: "model",
    state: "retry_wait",
    retryAt: at,
    error: { code: "unavailable", message: "temporary", retryable: true, details: null },
  },
  { kind: "usage", attemptId: "attempt", inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
  {
    kind: "tool_proposal",
    attemptId: "attempt",
    toolCallId: "call",
    toolName: "send_message",
    arguments: { text: "hello" },
    proposedAt: at,
  },
  {
    kind: "tool_dispatch",
    toolCallId: "call",
    dispatchId: "dispatch",
    intentId: "intent",
    state: "blocked",
    checkedAt: at,
    externalEffect: "possible",
    authority: [
      {
        decisionId: "decision",
        stage: "proposal",
        allowed: false,
        revision: "policy-1",
        reason: "denied",
        checkedAt: at,
      },
    ],
    receipt: null,
    denial: denied,
  },
  {
    kind: "tool_outcome",
    toolCallId: "call",
    dispatchId: "dispatch",
    state: "failed",
    externalEffect: "none",
    result: null,
    error: { code: "unavailable", message: "tool failed", retryable: true, details: null },
  },
  {
    kind: "tool_callback",
    toolCallId: "call",
    callbackId: "callback",
    outcome: { state: "succeeded", result: { delivered: true } },
  },
  {
    kind: "event_committed",
    eventId: "event",
    sourceWorkItemIds: ["work"],
    summary: "summary",
    needsMemory: true,
    checkpoint: { checkpointId: "checkpoint", commitId: "commit", summary: "summary", createdAt: at },
    committedAt: at,
  },
  {
    kind: "publication",
    publicationId: "publication",
    eventId: "event",
    checkpointId: "checkpoint",
    state: "pending",
    attempt: 0,
    retryAt: null,
    receipt: null,
    error: null,
  },
  {
    kind: "hippocampus",
    jobId: "job",
    eventId: "event",
    checkpointId: "checkpoint",
    state: "queued",
    attempt: 0,
    retryAt: null,
    error: null,
  },
  { kind: "lifecycle", phase: "pausing", runId: "run", reason: "owner requested pause" },
  {
    kind: "queue",
    workItem: {
      workItemId: "continuation",
      source: "continuation",
      state: "frozen_by_pause",
      acceptedAt: at,
      stimulusKind: null,
    },
    action: "frozen",
  },
  { kind: "diagnostic", severity: "warning", code: "owner_attention", message: "attention", details: null },
];

it("validates a concrete public DTO for every observation kind", () => {
  expect(observations.map((observation) => observation.kind)).toEqual(OBSERVATION_KINDS);
  for (const [index, observation] of observations.entries()) {
    const envelope: EventEnvelope = {
      protocol: "kokoro/1",
      kind: "event",
      messageId: `message-${index}`,
      correlationId: `correlation-${index}`,
      causationId: null,
      snapshot: { revision: index, capturedAt: at, personas: [] },
      record: {
        observationId: `observation-${index}`,
        cursor: `cursor-${index}`,
        personaId: "persona",
        runId: "run",
        eventId:
          observation.kind === "event_committed" ||
          observation.kind === "publication" ||
          observation.kind === "hippocampus"
            ? observation.eventId
            : "event",
        occurredAt: at,
        correlationId: `correlation-${index}`,
        observation,
      },
    };
    expect(parseServerEnvelope(envelope)).toEqual(envelope);
  }
});

it("rejects impossible dispatch and unknown-outcome combinations", () => {
  const blockedWithoutDenial = structuredClone(observations[5]) as Record<string, unknown>;
  blockedWithoutDenial.denial = null;
  expect(() => parseServerEnvelope(wrap(blockedWithoutDenial))).toThrow(/blocked dispatch requires a denial/);

  const unknownWithClaimedSuccess = {
    kind: "tool_outcome",
    toolCallId: "call",
    dispatchId: "dispatch",
    state: "unknown",
    externalEffect: "confirmed",
    result: { delivered: true },
    error: null,
  };
  expect(() => parseServerEnvelope(wrap(unknownWithClaimedSuccess))).toThrow(/unknown external effect/);
});

it("requires causal and truthful automatic Provider retry facts", () => {
  const retry = structuredClone(observations[2]) as Record<string, unknown>;
  delete retry.turnId;
  expect(() => parseServerEnvelope(wrap(retry))).toThrow(/turnId/);

  const missingOrdinal = structuredClone(observations[2]) as Record<string, unknown>;
  missingOrdinal.attempt = 0;
  expect(() => parseServerEnvelope(wrap(missingOrdinal))).toThrow(/attempt/);

  const missingEligibility = structuredClone(observations[2]) as Record<string, unknown>;
  missingEligibility.retryAt = null;
  expect(() => parseServerEnvelope(wrap(missingEligibility))).toThrow(/retry_wait requires/);

  const failedWithRetryTime = structuredClone(observations[2]) as Record<string, unknown>;
  failedWithRetryTime.state = "failed";
  expect(() => parseServerEnvelope(wrap(failedWithRetryTime))).toThrow(/only retry_wait/);
});

function wrap(observation: unknown): unknown {
  return {
    protocol: "kokoro/1",
    kind: "event",
    messageId: "message-invalid",
    correlationId: "correlation-invalid",
    causationId: null,
    snapshot: { revision: 1, capturedAt: at, personas: [] },
    record: {
      observationId: "observation-invalid",
      cursor: "cursor-invalid",
      personaId: "persona",
      runId: "run",
      eventId: "event",
      occurredAt: at,
      correlationId: "correlation-invalid",
      observation,
    },
  };
}
