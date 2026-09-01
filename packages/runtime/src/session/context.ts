import {
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  type PromptLocale,
  renderBuiltinToolResult,
} from "../i18n/index.js";
import {
  isJsonValue,
  type JsonValue,
  type ModelMessage,
  type ModelRequest,
  type ModelTool,
} from "../model.js";
import type { RepositoryDocument } from "../repository/index.js";
import type { SessionEntryFact, ToolCallFact } from "../store/index.js";

export function formatDocuments(documents: readonly RepositoryDocument[], emptyText: string): string {
  if (documents.length === 0) return emptyText;
  return documents.map((document) => `--- ${document.path} ---\n${document.content}`).join("\n\n");
}

export function formatCausalFacts(toolCalls: readonly ToolCallFact[]): string {
  const relevant = toolCalls
    .map((call, index) => ({ call, actionRef: `action-${index + 1}` }))
    .filter(
      ({ call }) =>
        call.status === "proposed" ||
        call.status === "intent_recorded" ||
        call.status === "dispatching" ||
        call.status === "unknown" ||
        call.status === "awaiting_callback",
    );
  if (relevant.length === 0) return "[]";
  return JSON.stringify(
    relevant.map(({ call, actionRef }) => ({
      actionRef,
      name: call.name,
      arguments: call.arguments,
      effect: call.effect,
      status: call.status,
      ...(call.dispatchResult === null ? {} : { dispatchResult: call.dispatchResult }),
      ...(call.result === null ? {} : { result: call.result }),
    })),
    null,
    2,
  );
}

export function formatPersonaCausalFacts(toolCalls: readonly ToolCallFact[]): string {
  return formatCausalFacts(toolCalls);
}

export function formatCloseoutCausalFacts(toolCalls: readonly ToolCallFact[]): string {
  return formatCausalFacts(toolCalls);
}

export function formatCompactionCausalFacts(toolCalls: readonly ToolCallFact[]): string {
  return formatCausalFacts(toolCalls);
}

export function formatPersonaStimulus(source: JsonValue): string {
  return JSON.stringify(projectSource(source), null, 2);
}

export function formatCloseoutEventEvidence(frozen: JsonValue): string {
  return JSON.stringify(projectFrozenEvent(frozen), null, 2);
}

export function formatHippocampusEventEvidence(frozen: JsonValue): string {
  return JSON.stringify(projectFrozenEvent(frozen), null, 2);
}

export function formatCompactionSessionHistory(entries: readonly SessionEntryFact[]): string {
  const source = entries.map((entry) => ({ kind: entry.kind, payload: entry.payload }));
  return JSON.stringify(projectSessionEntries(source), null, 2);
}

export function sessionMessages(
  entries: readonly SessionEntryFact[],
  dynamic?: { eventId: string; instruction: string; promptLocale?: PromptLocale },
): ModelMessage[] {
  const selected = sessionEntriesForCompaction(entries);
  const actionRefs = sessionActionRefs(selected);
  const messages: ModelMessage[] = [];
  for (const entry of selected) {
    const payload = entry.payload;
    if (!isObject(payload)) continue;
    if (entry.kind === "compaction") {
      const summary = payload["summary"];
      const causalFacts = payload["causalFacts"];
      if (typeof summary === "string") {
        messages.push({
          role: "user",
          content: JSON.stringify({
            kind: "derived_session_context",
            summary,
            ...(causalFacts === undefined ? {} : { retainedCausalFacts: causalFacts }),
          }),
        });
      }
      continue;
    }
    const storedContent = payload["content"];
    const dynamicPersonaInstruction = payload["dynamicPersonaInstruction"] === true;
    const content =
      entry.kind === "user" &&
      dynamic !== undefined &&
      entry.eventId === dynamic.eventId &&
      dynamicPersonaInstruction
        ? dynamic.instruction
        : entry.kind === "user" && dynamicPersonaInstruction && typeof storedContent === "string"
          ? JSON.stringify(projectStoredSource(storedContent), null, 2)
          : storedContent;
    if (typeof content !== "string") continue;
    if (entry.kind === "user") messages.push({ role: "user", content });
    else if (entry.kind === "assistant") {
      const reasoning = typeof payload["reasoning"] === "string" ? payload["reasoning"] : undefined;
      const toolCalls = Array.isArray(payload["toolCalls"])
        ? payload["toolCalls"].filter(isModelToolCall).map((call) => ({
            ...call,
            id: actionRefs.get(call.id) ?? "action-unresolved",
          }))
        : undefined;
      messages.push({
        role: "assistant",
        content,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(toolCalls === undefined || toolCalls.length === 0 ? {} : { toolCalls }),
      });
    } else if (entry.kind === "tool") {
      const storedToolCallId = payload["toolCallId"];
      if (typeof storedToolCallId !== "string") continue;
      const content = toolResultContent(payload, storedContent, dynamic?.promptLocale);
      if (content === null) continue;
      messages.push({
        role: "tool",
        content,
        toolCallId: actionRefs.get(storedToolCallId) ?? "action-unresolved",
        ...(payload["isError"] === true ? { isError: true } : {}),
      });
    }
  }
  if (
    dynamic !== undefined &&
    !selected.some(
      (entry) =>
        entry.kind === "user" &&
        entry.eventId === dynamic.eventId &&
        isObject(entry.payload) &&
        entry.payload["dynamicPersonaInstruction"] === true,
    )
  ) {
    messages.push({ role: "user", content: dynamic.instruction });
  }
  return messages;
}

function sessionActionRefs(entries: readonly SessionEntryFact[]): ReadonlyMap<string, string> {
  const refs = new Map<string, string>();
  const register = (id: string): void => {
    if (!refs.has(id)) refs.set(id, `action-${refs.size + 1}`);
  };
  for (const entry of entries) {
    if (!isObject(entry.payload)) continue;
    if (entry.kind === "assistant" && Array.isArray(entry.payload["toolCalls"])) {
      for (const call of entry.payload["toolCalls"]) {
        if (isModelToolCall(call)) register(call.id);
      }
    }
    if (entry.kind === "tool" && typeof entry.payload["toolCallId"] === "string") {
      register(entry.payload["toolCallId"]);
    }
  }
  return refs;
}

function toolResultContent(
  payload: Record<string, JsonValue>,
  storedContent: JsonValue | undefined,
  locale: PromptLocale | undefined,
): string | null {
  if (Object.hasOwn(payload, "rawResult")) {
    const raw = JSON.stringify(payload["rawResult"]);
    const toolName = payload["toolName"];
    if (locale !== undefined && typeof toolName === "string" && isBuiltinToolName(toolName)) {
      return renderBuiltinToolResult(locale, toolName, raw);
    }
    return raw;
  }
  return typeof storedContent === "string" ? storedContent : null;
}

/** Latest derived summary plus only the raw entries beyond its durable watermark. */
export function sessionEntriesForCompaction(entries: readonly SessionEntryFact[]): SessionEntryFact[] {
  const latest = [...entries].reverse().find((entry) => entry.kind === "compaction");
  if (!latest || !isObject(latest.payload)) return [...entries];
  const watermark = latest.payload["coversThrough"];
  if (typeof watermark !== "number" || !Number.isSafeInteger(watermark) || watermark < 0) {
    return [
      latest,
      ...entries.filter((entry) => entry.kind !== "compaction" && entry.sequence > latest.sequence),
    ];
  }
  return [latest, ...entries.filter((entry) => entry.kind !== "compaction" && entry.sequence > watermark)];
}

export function estimateRequestTokens(input: {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  maxOutputTokens: number;
}): number {
  const characters =
    input.system.length + JSON.stringify(input.messages).length + JSON.stringify(input.tools).length;
  return Math.ceil(characters / 3) + input.maxOutputTokens + 256;
}

export function requestFact(request: ModelRequest): JsonValue {
  return JSON.parse(JSON.stringify(request)) as JsonValue;
}

export function responseFact(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectFrozenEvent(frozen: JsonValue): JsonValue {
  if (!isObject(frozen)) return { source: frozen, experience: [], actions: [] };
  const calls = Array.isArray(frozen["toolCalls"]) ? frozen["toolCalls"].filter(isObject) : [];
  const actionRefs = new Map<string, string>();
  for (const [index, call] of calls.entries()) {
    const actionRef = `action-${index + 1}`;
    const internalId = call["id"];
    const providerId = call["providerCallId"];
    if (typeof internalId === "string") actionRefs.set(internalId, actionRef);
    if (typeof providerId === "string") actionRefs.set(providerId, actionRef);
  }
  const rawEntries = Array.isArray(frozen["sessionEntries"]) ? frozen["sessionEntries"].filter(isObject) : [];
  return {
    source: projectSource(frozen["source"] ?? null),
    experience: projectSessionEntries(rawEntries, actionRefs),
    actions: calls.map((call, index) => projectAction(call, `action-${index + 1}`)),
  };
}

function projectSource(source: JsonValue): JsonValue {
  if (!isObject(source)) return source;
  const projected: Record<string, JsonValue> = {};
  if (typeof source["kind"] === "string") projected["kind"] = source["kind"];
  if (source["payload"] !== undefined) projected["payload"] = source["payload"];
  const origin = source["originAction"];
  if (isObject(origin)) {
    projected["originAction"] = {
      ...(typeof origin["name"] === "string" ? { name: origin["name"] } : {}),
      ...(typeof origin["effect"] === "string" ? { effect: origin["effect"] } : {}),
      ...(typeof origin["status"] === "string" ? { status: origin["status"] } : {}),
    };
  }
  return projected;
}

function projectAction(call: Record<string, JsonValue>, actionRef: string): JsonValue {
  return {
    actionRef,
    ...(typeof call["name"] === "string" ? { name: call["name"] } : {}),
    ...(isObject(call["arguments"] ?? null) ? { arguments: call["arguments"] as JsonValue } : {}),
    ...(typeof call["effect"] === "string" ? { effect: call["effect"] } : {}),
    ...(typeof call["status"] === "string" ? { status: call["status"] } : {}),
    ...(call["dispatchResult"] === undefined || call["dispatchResult"] === null
      ? {}
      : { dispatchResult: call["dispatchResult"] }),
    ...(call["result"] === undefined || call["result"] === null ? {} : { result: call["result"] }),
  };
}

function projectSessionEntries(
  entries: readonly Record<string, JsonValue>[],
  seededActionRefs: ReadonlyMap<string, string> = new Map(),
): JsonValue[] {
  const actionRefs = new Map(seededActionRefs);
  let nextAction = actionRefs.size + 1;
  for (const entry of entries) {
    const payload = entry["payload"];
    if (entry["kind"] !== "assistant" || !isObject(payload) || !Array.isArray(payload["toolCalls"])) {
      continue;
    }
    for (const call of payload["toolCalls"]) {
      if (!isObject(call) || typeof call["id"] !== "string" || actionRefs.has(call["id"])) continue;
      actionRefs.set(call["id"], `action-${nextAction}`);
      nextAction += 1;
    }
  }

  return entries.flatMap((entry): JsonValue[] => {
    const kind = entry["kind"];
    const payload = entry["payload"];
    if (typeof kind !== "string" || !isObject(payload)) return [];
    if (kind === "user") {
      const content = payload["content"];
      const semanticContent =
        payload["dynamicPersonaInstruction"] === true && typeof content === "string"
          ? projectStoredSource(content)
          : content;
      return [{ kind: "stimulus", ...(semanticContent === undefined ? {} : { content: semanticContent }) }];
    }
    if (kind === "assistant") {
      const proposedActions = Array.isArray(payload["toolCalls"])
        ? payload["toolCalls"].flatMap((call): JsonValue[] => {
            if (!isObject(call)) return [];
            const id = call["id"];
            return [
              {
                ...(typeof id === "string" && actionRefs.has(id)
                  ? { actionRef: actionRefs.get(id) as string }
                  : {}),
                ...(typeof call["name"] === "string" ? { name: call["name"] } : {}),
                ...(isObject(call["arguments"] ?? null) ? { arguments: call["arguments"] as JsonValue } : {}),
              },
            ];
          })
        : [];
      return [
        {
          kind: "private_cognition",
          ...(typeof payload["reasoning"] === "string" ? { reasoning: payload["reasoning"] } : {}),
          ...(typeof payload["content"] === "string" ? { content: payload["content"] } : {}),
          ...(proposedActions.length === 0 ? {} : { proposedActions }),
        },
      ];
    }
    if (kind === "tool") {
      const id = payload["toolCallId"];
      const hasRawResult = Object.hasOwn(payload, "rawResult");
      return [
        {
          kind: "tool_result",
          ...(typeof id === "string" && actionRefs.has(id)
            ? { actionRef: actionRefs.get(id) as string }
            : {}),
          ...(typeof payload["toolName"] === "string" ? { toolName: payload["toolName"] } : {}),
          ...(hasRawResult
            ? { result: payload["rawResult"] as JsonValue }
            : typeof payload["content"] === "string"
              ? { content: payload["content"] }
              : {}),
          ...(payload["isError"] === true ? { isError: true } : {}),
        },
      ];
    }
    if (kind === "compaction") {
      return [
        {
          kind: "derived_context",
          ...(typeof payload["summary"] === "string" ? { summary: payload["summary"] } : {}),
          ...(typeof payload["causalFacts"] === "string"
            ? { retainedCausalFacts: parseJsonValue(payload["causalFacts"]) ?? payload["causalFacts"] }
            : {}),
        },
      ];
    }
    return [];
  });
}

function projectStoredSource(content: string): JsonValue {
  const parsed = parseJsonValue(content);
  return parsed === undefined ? content : projectSource(parsed);
}

function parseJsonValue(content: string): JsonValue | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isModelToolCall(
  value: JsonValue,
): value is { id: string; name: string; arguments: Record<string, JsonValue> } {
  if (!isObject(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    isObject(value["arguments"] ?? null)
  );
}

function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}
