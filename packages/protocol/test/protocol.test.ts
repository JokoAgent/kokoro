import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type ClientEnvelope,
  COMMAND_TYPES,
  type Command,
  decodeClientPayload,
  decodeServerPayload,
  type EventEnvelope,
  encodeClientEnvelope,
  encodeServerEnvelope,
  LengthPrefixedFrameDecoder,
  OBSERVATION_KINDS,
  ProtocolValidationError,
  parseClientEnvelope,
  parseServerEnvelope,
  type ServerEnvelope,
} from "../src/index.js";

interface GoldenFixture {
  clientHello: unknown;
  request: unknown;
  serverHello: unknown;
  response: unknown;
  events: unknown[];
}

async function golden(): Promise<GoldenFixture> {
  return JSON.parse(
    await readFile(new URL("../fixtures/protocol-v1.golden.json", import.meta.url), "utf8"),
  ) as GoldenFixture;
}

describe("protocol v1 golden fixture", () => {
  it("validates and round-trips every representative envelope", async () => {
    const fixture = await golden();
    const clients = [parseClientEnvelope(fixture.clientHello), parseClientEnvelope(fixture.request)];
    const servers = [
      parseServerEnvelope(fixture.serverHello),
      parseServerEnvelope(fixture.response),
      ...fixture.events.map(parseServerEnvelope),
    ];

    for (const envelope of clients) {
      const decoder = new LengthPrefixedFrameDecoder();
      const payloads = decoder.push(encodeClientEnvelope(envelope));
      expect(payloads).toHaveLength(1);
      const payload = payloads[0];
      if (!payload) throw new Error("missing encoded client payload");
      expect(decodeClientPayload(payload)).toEqual(envelope);
    }
    for (const envelope of servers) {
      const decoder = new LengthPrefixedFrameDecoder();
      const payloads = decoder.push(encodeServerEnvelope(envelope));
      expect(payloads).toHaveLength(1);
      const payload = payloads[0];
      if (!payload) throw new Error("missing encoded server payload");
      expect(decodeServerPayload(payload)).toEqual(envelope);
    }
  });

  it("covers every public observation discriminator", () => {
    expect(new Set(OBSERVATION_KINDS)).toEqual(
      new Set([
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
      ]),
    );
  });

  it("keeps cognition, proposal, dispatch, unknown outcome, commit, publication, and Memory maintenance distinct", async () => {
    const fixture = await golden();
    const kinds = fixture.events.map(
      (entry) => (parseServerEnvelope(entry) as EventEnvelope).record.observation.kind,
    );
    expect(kinds).toEqual([
      "internal_cognition",
      "tool_proposal",
      "tool_dispatch",
      "tool_outcome",
      "event_committed",
      "publication",
      "hippocampus",
    ]);
    const cognition = (parseServerEnvelope(fixture.events[0]) as EventEnvelope).record.observation;
    expect(cognition).toMatchObject({ kind: "internal_cognition", externalMessage: false });
    const outcome = (parseServerEnvelope(fixture.events[3]) as EventEnvelope).record.observation;
    expect(outcome).toMatchObject({ kind: "tool_outcome", state: "unknown", externalEffect: "unknown" });
  });
});

describe("strict protocol validation", () => {
  it("rejects unknown fields at the envelope and nested command levels", async () => {
    const fixture = await golden();
    expect(() => parseClientEnvelope({ ...(fixture.clientHello as object), extra: true })).toThrowError(
      expect.objectContaining({ path: "$.extra" }),
    );
    const request = structuredClone(fixture.request) as Record<string, unknown>;
    (request.command as Record<string, unknown>).session = "private-shape";
    expect(() => parseClientEnvelope(request)).toThrowError(
      expect.objectContaining({ path: "$.command.session" }),
    );
  });

  it("rejects unknown observation fields and mismatched event correlation", async () => {
    const fixture = await golden();
    const unknown = structuredClone(fixture.events[0]) as Record<string, unknown>;
    ((unknown.record as Record<string, unknown>).observation as Record<string, unknown>).sent = true;
    expect(() => parseServerEnvelope(unknown)).toThrowError(
      expect.objectContaining({ path: "$.record.observation.sent" }),
    );

    const mismatched = structuredClone(fixture.events[0]) as Record<string, unknown>;
    (mismatched.record as Record<string, unknown>).correlationId = "different-correlation";
    expect(() => parseServerEnvelope(mismatched)).toThrowError(
      expect.objectContaining({ path: "$.record.correlationId" }),
    );
  });

  it("rejects an internal cognition observation that claims external delivery", async () => {
    const fixture = await golden();
    const event = structuredClone(fixture.events[0]) as Record<string, unknown>;
    ((event.record as Record<string, unknown>).observation as Record<string, unknown>).externalMessage = true;
    expect(() => parseServerEnvelope(event)).toThrow(ProtocolValidationError);
  });

  it("requires dynamic commands to be unique members of the static support surface", async () => {
    const fixture = await golden();
    const duplicate = structuredClone(fixture.serverHello) as Record<string, unknown>;
    const duplicateOutcome = duplicate.outcome as Record<string, unknown>;
    const duplicateCapabilities = duplicateOutcome.capabilities as Record<string, unknown>;
    duplicateCapabilities.availableCommands = ["create", "create"];
    expect(() => parseServerEnvelope(duplicate)).toThrowError(
      expect.objectContaining({ path: "$.outcome.capabilities.availableCommands[1]" }),
    );

    const unsupported = structuredClone(fixture.serverHello) as Record<string, unknown>;
    const unsupportedOutcome = unsupported.outcome as Record<string, unknown>;
    const unsupportedCapabilities = unsupportedOutcome.capabilities as Record<string, unknown>;
    unsupportedCapabilities.commands = ["snapshot"];
    unsupportedCapabilities.availableCommands = ["create"];
    expect(() => parseServerEnvelope(unsupported)).toThrowError(
      expect.objectContaining({ path: "$.outcome.capabilities.availableCommands[0]" }),
    );
  });

  it("requires snapshot presence to agree with hello outcome", async () => {
    const fixture = await golden();
    const successWithoutSnapshot = structuredClone(fixture.serverHello) as Record<string, unknown>;
    successWithoutSnapshot.snapshot = null;
    expect(() => parseServerEnvelope(successWithoutSnapshot)).toThrowError(
      expect.objectContaining({ path: "$.snapshot" }),
    );

    const rejectedWithSnapshot = structuredClone(fixture.serverHello) as Record<string, unknown>;
    rejectedWithSnapshot.outcome = {
      status: "error",
      error: { code: "unsupported_version", message: "No common version", retryable: false, details: null },
    };
    expect(() => parseServerEnvelope(rejectedWithSnapshot)).toThrowError(
      expect.objectContaining({ path: "$.snapshot" }),
    );
  });
});

describe("commands", () => {
  const commands: readonly Command[] = [
    {
      type: "create",
      templateId: "default",
      personaId: null,
      displayName: "A",
      uiLocale: "en",
      promptLocale: "zh-CN",
    },
    { type: "init", personaId: "p", expectedWorkingTreeDigest: null },
    {
      type: "start",
      personaId: "p",
      from: { kind: "current_working_tree" },
      model: null,
      promptLocale: null,
    },
    { type: "pause", personaId: "p" },
    { type: "resume", personaId: "p" },
    { type: "stop", personaId: "p" },
    { type: "force", personaId: "p" },
    {
      type: "stimulus",
      personaId: "p",
      idempotencyKey: "s-1",
      stimulus: { kind: "scheduled", content: null, occurredAt: null, source: null },
    },
    {
      type: "callback",
      personaId: "p",
      toolCallId: "call",
      callbackId: "callback",
      outcome: { state: "unknown", reason: "remote state cannot be reconciled" },
    },
    { type: "owner_documents", personaId: "p", path: null },
    {
      type: "put_owner_document",
      personaId: "p",
      path: "workspace/persona/profile.md",
      content: "# Profile\n",
      expectedSha256: null,
    },
    { type: "history", personaId: "p", beforeCheckpointId: null, limit: 10 },
    { type: "branch", personaId: "p", checkpointId: "c", branchName: "review" },
    { type: "clone", personaId: "p", checkpointId: "c", newPersonaId: null, displayName: "Clone" },
    { type: "restore", personaId: "p", checkpointId: "c", workingTreePolicy: "require_clean" },
    { type: "delete", personaId: "p", confirmationPersonaId: "p", workingTreePolicy: "require_clean" },
    { type: "locales" },
    { type: "set_locales", personaId: "p", uiLocale: "zh-CN", promptLocale: null },
    { type: "retry", personaId: "p", target: { kind: "hippocampus", jobId: "job" } },
    { type: "capabilities", personaId: null },
    { type: "observations", personaId: "p", afterCursor: null, limit: 100, kinds: null },
    { type: "snapshot" },
  ];

  it("validates every required public command without widening the DTO", () => {
    expect(commands.map((command) => command.type)).toEqual(COMMAND_TYPES);
    for (const [index, command] of commands.entries()) {
      const envelope: ClientEnvelope = {
        protocol: "kokoro/1",
        kind: "request",
        messageId: `request-${index}`,
        correlationId: `correlation-${index}`,
        expectedRevision: 4,
        command,
      };
      expect(parseClientEnvelope(envelope)).toEqual(envelope);
    }
  });

  it("does not let callback carry unrelated stimulus data", () => {
    const command = structuredClone(commands.find((entry) => entry.type === "callback")) as unknown as Record<
      string,
      unknown
    >;
    command.independentStimulus = { kind: "external_change", content: null };
    expect(() =>
      parseClientEnvelope({
        protocol: "kokoro/1",
        kind: "request",
        messageId: "request-callback",
        correlationId: "correlation-callback",
        expectedRevision: 0,
        command,
      }),
    ).toThrowError(expect.objectContaining({ path: "$.command.independentStimulus" }));
  });

  it("keeps Owner document paths portable and compare-and-swap digests strict", () => {
    const put = structuredClone(commands.find((entry) => entry.type === "put_owner_document"));
    if (!put || put.type !== "put_owner_document") throw new Error("missing Owner document command");
    expect(() =>
      parseClientEnvelope({
        protocol: "kokoro/1",
        kind: "request",
        messageId: "owner-path",
        correlationId: "owner-path-correlation",
        expectedRevision: 1,
        command: { ...put, path: "workspace\\persona\\profile.md" },
      }),
    ).toThrowError(expect.objectContaining({ path: "$.command.path" }));
    expect(() =>
      parseClientEnvelope({
        protocol: "kokoro/1",
        kind: "request",
        messageId: "owner-sha",
        correlationId: "owner-sha-correlation",
        expectedRevision: 1,
        command: { ...put, expectedSha256: "ABC" },
      }),
    ).toThrowError(expect.objectContaining({ path: "$.command.expectedSha256" }));
  });
});

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

it("decodes coalesced golden server messages in order", async () => {
  const fixture = await golden();
  const envelopes: ServerEnvelope[] = [
    parseServerEnvelope(fixture.serverHello),
    parseServerEnvelope(fixture.response),
    ...fixture.events.map(parseServerEnvelope),
  ];
  const decoder = new LengthPrefixedFrameDecoder();
  const payloads = decoder.push(concatenate(envelopes.map((entry) => encodeServerEnvelope(entry))));
  expect(payloads.map(decodeServerPayload)).toEqual(envelopes);
});
