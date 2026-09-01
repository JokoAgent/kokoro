import { expect, it } from "vitest";
import {
  COMMAND_TYPES,
  type CommandResult,
  MAX_FRAME_BYTES,
  OBSERVATION_KINDS,
  parseServerEnvelope,
  type ResponseEnvelope,
} from "../src/index.js";

const at = "2026-08-30T00:00:00.000Z";
const checkpoint = {
  checkpointId: "checkpoint",
  commitId: "commit",
  summary: "summary",
  createdAt: at,
} as const;
const accepted = <
  T extends
    | "init"
    | "start"
    | "pause"
    | "resume"
    | "stop"
    | "force"
    | "restore"
    | "delete"
    | "set_locales"
    | "retry",
>(
  type: T,
): CommandResult => ({ type, operationId: `operation-${type}`, acceptedAt: at });

const results: readonly CommandResult[] = [
  { type: "create", personaId: "persona", operationId: "operation-create", acceptedAt: at },
  accepted("init"),
  accepted("start"),
  accepted("pause"),
  accepted("resume"),
  accepted("stop"),
  accepted("force"),
  { type: "stimulus", stimulusId: "stimulus", workItemId: "work", acceptedAt: at },
  { type: "callback", callbackId: "callback", toolCallId: "call", recordedAt: at },
  {
    type: "owner_documents",
    documents: [
      {
        path: "workspace/persona/profile.md",
        content: "# Profile\n",
        sha256: "a".repeat(64),
        mtimeMs: 1_777_500_000_000.25,
      },
    ],
  },
  {
    type: "put_owner_document",
    document: {
      path: "workspace/memory/2026-08-30/note.md",
      content: "# Note\n",
      sha256: "b".repeat(64),
      mtimeMs: 1_777_500_000_001,
    },
  },
  { type: "history", checkpoints: [checkpoint], nextBeforeCheckpointId: null },
  { type: "branch", branchName: "review", checkpoint },
  { type: "clone", personaId: "clone", checkpoint },
  accepted("restore"),
  accepted("delete"),
  { type: "locales", locales: [{ locale: "en", label: "English", ui: true, prompt: true }] },
  accepted("set_locales"),
  accepted("retry"),
  {
    type: "capabilities",
    capabilities: {
      protocol: "kokoro/1",
      serverVersion: "0.1.0",
      maxFrameBytes: MAX_FRAME_BYTES,
      commands: COMMAND_TYPES,
      availableCommands: ["create", "locales", "capabilities", "snapshot"],
      observationKinds: OBSERVATION_KINDS,
      locales: [],
      providers: [
        {
          providerId: "provider",
          label: "Provider",
          available: false,
          unavailableReason: "authentication_required",
          models: [],
        },
      ],
      tools: [],
      features: { continuation: true, publication: true, hippocampus: true },
    },
  },
  { type: "observations", observations: [], nextCursor: null },
  { type: "snapshot" },
];

it("strictly validates one result DTO for every command", () => {
  expect(results.map((result) => result.type)).toEqual(COMMAND_TYPES);
  for (const [index, result] of results.entries()) {
    const response: ResponseEnvelope = {
      protocol: "kokoro/1",
      kind: "response",
      messageId: `response-${index}`,
      correlationId: `correlation-${index}`,
      replyTo: `request-${index}`,
      snapshot: { revision: index, capturedAt: at, personas: [] },
      outcome: { status: "ok", result },
    };
    expect(parseServerEnvelope(response)).toEqual(response);
  }
});

it("treats Provider unavailableReason as a stable machine-readable reason code", () => {
  const result = results.find((candidate) => candidate.type === "capabilities");
  if (!result || result.type !== "capabilities") throw new Error("missing capabilities result");
  const response: ResponseEnvelope = {
    protocol: "kokoro/1",
    kind: "response",
    messageId: "response-capability-reason",
    correlationId: "correlation-capability-reason",
    replyTo: "request-capability-reason",
    snapshot: { revision: 1, capturedAt: at, personas: [] },
    outcome: { status: "ok", result },
  };
  const widened = structuredClone(response) as unknown as Record<string, unknown>;
  const outcome = widened.outcome as Record<string, unknown>;
  const widenedResult = outcome.result as Record<string, unknown>;
  const capabilities = widenedResult.capabilities as Record<string, unknown>;
  const [provider] = capabilities.providers as Record<string, unknown>[];
  if (!provider) throw new Error("missing Provider capability fixture");
  provider.unavailableReason = "Please sign in";
  expect(() => parseServerEnvelope(widened)).toThrowError(
    expect.objectContaining({ path: "$.outcome.result.capabilities.providers[0].unavailableReason" }),
  );
});

it("rejects unknown fields inside Owner document DTOs", () => {
  const result = results.find((candidate) => candidate.type === "owner_documents");
  if (!result || result.type !== "owner_documents") throw new Error("missing Owner document result");
  const response: ResponseEnvelope = {
    protocol: "kokoro/1",
    kind: "response",
    messageId: "response-owner-extra",
    correlationId: "correlation-owner-extra",
    replyTo: "request-owner-extra",
    snapshot: { revision: 1, capturedAt: at, personas: [] },
    outcome: { status: "ok", result },
  };
  const widened = structuredClone(response) as unknown as Record<string, unknown>;
  const outcome = widened.outcome as Record<string, unknown>;
  const widenedResult = outcome.result as Record<string, unknown>;
  const [document] = widenedResult.documents as Record<string, unknown>[];
  if (!document) throw new Error("missing Owner document fixture");
  document.repositoryRoot = "D:/private/persona";
  expect(() => parseServerEnvelope(widened)).toThrowError(
    expect.objectContaining({ path: "$.outcome.result.documents[0].repositoryRoot" }),
  );
});
