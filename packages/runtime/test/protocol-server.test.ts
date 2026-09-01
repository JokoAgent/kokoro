import {
  type ClientEnvelope,
  type Command,
  decodeServerPayload,
  type EventEnvelope,
  encodeClientEnvelope,
  LengthPrefixedFrameDecoder,
  MAX_FRAME_BYTES,
  type ServerEnvelope,
} from "@kokoro/protocol";
import { describe, expect, it } from "vitest";
import {
  type CredentialGuard,
  createExactCredentialGuard,
  type ModelCapability,
  NO_CREDENTIAL_GUARDS,
  type RuntimeTool,
} from "../src/index.js";
import type { ProtocolRuntime } from "../src/protocol/index.js";
import { type ByteConnection, ProtocolServer } from "../src/protocol/index.js";
import type { RuntimePersonaView } from "../src/runtime.js";
import type {
  EventFact,
  HippocampusJobFact,
  ObservationFact,
  PersonaFact,
  QueueItemFact,
  RunFact,
  ToolCallFact,
} from "../src/store/index.js";

describe("ProtocolServer", () => {
  it("requires hello as the first envelope and returns a correlated rejection", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);

    connection.deliver(
      encodeClientEnvelope(request("request-before-hello", "correlation-before-hello", { type: "snapshot" })),
    );
    await connection.waitForFrames(1);

    const [reply] = connection.envelopes();
    expect(reply).toMatchObject({
      kind: "hello",
      correlationId: "correlation-before-hello",
      replyTo: "request-before-hello",
      snapshot: null,
      outcome: { status: "error", error: { code: "invalid_request" } },
    });
    expect(connection.closed).toBe(true);
  });

  it("negotiates hello and permits independent read requests to complete out of order", async () => {
    const fixture = runtimeFixture();
    fixture.historyDelayMs = 40;
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    connection.deliver(
      encodeClientEnvelope(
        request("history-request", "history-correlation", {
          type: "history",
          personaId: "persona-1",
          beforeCheckpointId: null,
          limit: 10,
        }),
      ),
    );
    connection.deliver(
      encodeClientEnvelope(request("snapshot-request", "snapshot-correlation", { type: "snapshot" })),
    );
    await connection.waitForFrames(3);

    const responses = connection.envelopes().slice(1);
    expect(
      responses.map((response) => {
        if (response.kind !== "response") throw new Error("Expected only correlated responses.");
        return response.replyTo;
      }),
    ).toEqual(["snapshot-request", "history-request"]);
    expect(responses[0]).toMatchObject({
      kind: "response",
      correlationId: "snapshot-correlation",
      snapshot: { revision: 1 },
      outcome: { status: "ok", result: { type: "snapshot" } },
    });
  });

  it("preserves response order while an exact credential capture is delayed", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    let captureCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.credentialGuards = [
      {
        async capture() {
          captureCalls += 1;
          if (captureCalls === 1) await gate;
          return null;
        },
      },
    ];

    connection.deliver(
      encodeClientEnvelope(request("ordered-1", "ordered-correlation-1", { type: "snapshot" })),
    );
    connection.deliver(
      encodeClientEnvelope(request("ordered-2", "ordered-correlation-2", { type: "snapshot" })),
    );
    while (captureCalls === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captureCalls).toBe(1);
    release();
    await connection.waitForFrames(3);

    expect(
      connection
        .envelopes()
        .slice(1)
        .map((envelope) => (envelope.kind === "response" ? envelope.replyTo : envelope.kind)),
    ).toEqual(["ordered-1", "ordered-2"]);
  });

  it("buffers the snapshot-to-hello race and flushes facts only after hello", async () => {
    const fixture = runtimeFixture();
    fixture.emitDuringAuthorityCall = 2;
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);

    connection.deliver(encodeClientEnvelope(helloEnvelope()));
    await connection.waitForFrames(2);

    const [serverHello, bufferedEvent] = connection.envelopes();
    expect(serverHello).toMatchObject({ kind: "hello", snapshot: { revision: 1 } });
    expect(bufferedEvent).toMatchObject({
      kind: "event",
      correlationId: "observation:30",
      causationId: null,
      snapshot: { revision: 2 },
      record: {
        observationId: "observation:30:0",
        observation: { kind: "lifecycle", phase: "running" },
      },
    });
  });

  it("closes instead of silently dropping an overflowing pre-hello observation buffer", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, {
      ...deterministicOptions(),
      maxHandshakeObservations: 2,
    });
    const connection = new MemoryByteConnection();
    await server.attach(connection);

    for (const sequence of [31, 32, 33]) {
      fixture.emit(
        fact(sequence, "diagnostic", {
          severity: "info",
          code: `prehello_${sequence}`,
          message: "Buffered",
          details: null,
        }),
      );
    }
    await connection.waitForClose();

    expect(connection.frames).toHaveLength(0);
    expect(connection.closed).toBe(true);
  });

  it("serializes live event production even when an earlier snapshot is slower", async () => {
    const fixture = runtimeFixture();
    fixture.slowAuthorityCall = 3;
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    fixture.emit(
      fact(41, "diagnostic", {
        severity: "info",
        code: "first_fact",
        message: "First",
        details: null,
      }),
    );
    fixture.emit(
      fact(42, "diagnostic", {
        severity: "info",
        code: "second_fact",
        message: "Second",
        details: null,
      }),
    );
    await connection.waitForFrames(3);

    expect(
      connection
        .envelopes()
        .slice(1)
        .map((envelope) => (envelope.kind === "event" ? envelope.record.cursor : null)),
    ).toEqual(["41.0", "42.0"]);
  });

  it("turns a malformed causal Runtime fact into a diagnostic instead of guessing success", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    fixture.emit(
      fact(50, "publication", {
        publicationId: "publication-1",
        eventId: "event-1",
        checkpointId: "checkpoint-1",
        state: "not-a-real-state",
      }),
    );
    await connection.waitForFrames(2);

    expect(connection.envelopes()[1]).toMatchObject({
      kind: "event",
      record: {
        observation: {
          kind: "diagnostic",
          severity: "error",
          code: "invalid_internal_fact",
          details: { sourceKind: "publication" },
        },
      },
    });
  });

  it("fences concurrent mutations with expectedRevision CAS", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    const pause = (messageId: string): ClientEnvelope => ({
      protocol: "kokoro/1",
      kind: "request",
      messageId,
      correlationId: `correlation-${messageId}`,
      expectedRevision: 1,
      command: { type: "pause", personaId: "persona-1" },
    });
    connection.deliver(encodeClientEnvelope(pause("pause-a")));
    connection.deliver(encodeClientEnvelope(pause("pause-b")));
    await connection.waitForFrames(3);

    const outcomes = connection
      .envelopes()
      .slice(1)
      .map((response) => (response.kind === "response" ? response.outcome : null));
    expect(outcomes.filter((outcome) => outcome?.status === "ok")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome?.status === "error")).toEqual([
      expect.objectContaining({
        status: "error",
        error: expect.objectContaining({ code: "revision_conflict" }),
      }),
    ]);
    expect(fixture.pauseCalls).toBe(1);
  });

  it("rejects expectedRevision on read-only commands instead of implying an MVCC read", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    connection.deliver(
      encodeClientEnvelope({
        protocol: "kokoro/1",
        kind: "request",
        messageId: "conditional-snapshot",
        correlationId: "conditional-snapshot-correlation",
        expectedRevision: fixture.revision,
        command: { type: "snapshot" },
      }),
    );
    await connection.waitForFrames(2);

    expect(connection.envelopes()[1]).toMatchObject({
      kind: "response",
      outcome: { status: "error", error: { code: "invalid_request" } },
    });
  });

  it("binds recoverable Restore to the Owner-reviewed authority working-tree digest", async () => {
    const fixture = runtimeFixture();
    fixture.authorityPersonas = [personaView({ persona: personaFact(), run: null })];
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    const unconditional = request("unsafe-restore", "unsafe-restore-correlation", {
      type: "restore",
      personaId: "persona-1",
      checkpointId: "checkpoint-1",
      workingTreePolicy: "require_clean",
    });
    connection.deliver(encodeClientEnvelope(unconditional));
    await connection.waitForFrames(2);
    expect(connection.envelopes()[1]).toMatchObject({
      kind: "response",
      outcome: { status: "error", error: { code: "invalid_request" } },
    });

    if (unconditional.kind !== "request") throw new Error("expected request fixture");
    connection.deliver(
      encodeClientEnvelope({ ...unconditional, messageId: "reviewed-restore", expectedRevision: 1 }),
    );
    await connection.waitForFrames(3);
    expect(connection.envelopes()[2]).toMatchObject({
      kind: "response",
      outcome: { status: "ok", result: { type: "restore" } },
    });
    expect(fixture.lastRestoreArguments).toEqual(["persona-1", "checkpoint-1", false, "working-tree-digest"]);
  });

  it("materializes a mutation conflict and its snapshot before admitting the next mutation", async () => {
    const fixture = runtimeFixture();
    fixture.slowAuthorityCall = 3;
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    const stale = request("stale-pause", "stale-pause-correlation", {
      type: "pause",
      personaId: "persona-1",
    });
    if (stale.kind !== "request") throw new Error("expected request fixture");
    connection.deliver(encodeClientEnvelope({ ...stale, expectedRevision: 99 }));
    connection.deliver(
      encodeClientEnvelope(
        request("unconditional-pause", "unconditional-pause-correlation", {
          type: "pause",
          personaId: "persona-1",
        }),
      ),
    );
    await connection.waitForFrames(3);

    const [conflict, success] = connection.envelopes().slice(1);
    expect(conflict).toMatchObject({
      kind: "response",
      replyTo: "stale-pause",
      snapshot: { revision: 1 },
      outcome: {
        status: "error",
        error: { code: "revision_conflict", details: { expectedRevision: 99, actualRevision: 1 } },
      },
    });
    expect(success).toMatchObject({
      kind: "response",
      replyTo: "unconditional-pause",
      snapshot: { revision: 2 },
      outcome: { status: "ok", result: { type: "pause" } },
    });
    expect(fixture.pauseCalls).toBe(1);
  });

  it("times out a stuck transport send, closes the connection, and releases the mutation queue", async () => {
    const fixture = runtimeFixture();
    fixture.emitOnPause = true;
    const server = new ProtocolServer(fixture.runtime, {
      ...deterministicOptions(),
      sendTimeoutMs: 20,
    });
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);
    connection.hangAfterFrames = 1;

    for (const suffix of ["first", "second"]) {
      connection.deliver(
        encodeClientEnvelope(
          request(`pause-${suffix}`, `pause-${suffix}-correlation`, {
            type: "pause",
            personaId: "persona-1",
          }),
        ),
      );
    }
    await connection.waitForClose();

    expect(fixture.pauseCalls).toBe(2);
    expect(connection.frames).toHaveLength(1);
  });

  it("fences a credential capture that resolves after its transport timeout", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, {
      ...deterministicOptions(),
      sendTimeoutMs: 20,
    });
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    let entered!: () => void;
    const captured = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.credentialGuards = [
      {
        async capture() {
          entered();
          await gate;
          return null;
        },
      },
    ];

    connection.deliver(
      encodeClientEnvelope(request("late-capture", "late-capture-correlation", { type: "snapshot" })),
    );
    await captured;
    await connection.waitForClose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(connection.frames).toHaveLength(1);
  });

  it("derives available commands from the selected Persona facts", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    expect((await server.capabilities(null)).availableCommands).toEqual([
      "create",
      "locales",
      "capabilities",
      "snapshot",
    ]);

    fixture.authorityPersonas = [personaView({ persona: personaFact(), run: null })];
    const ready = await server.capabilities("persona-1");
    expect(ready.commands).toEqual(expect.arrayContaining(["start", "pause", "put_owner_document"]));
    expect(ready.availableCommands).toEqual(
      expect.arrayContaining([
        "start",
        "owner_documents",
        "put_owner_document",
        "branch",
        "restore",
        "delete",
      ]),
    );
    expect(ready.availableCommands).not.toContain("pause");

    fixture.authorityPersonas = [personaView({ persona: personaFact(), run: runFact() })];
    const running = await server.capabilities("persona-1");
    expect(running.availableCommands).toEqual(
      expect.arrayContaining(["pause", "stop", "force", "stimulus", "put_owner_document"]),
    );
    expect(running.availableCommands).not.toEqual(expect.arrayContaining(["start", "restore", "delete"]));
  });

  it("never reflects credential-bearing Owner content into a response or observation", async () => {
    const fixture = runtimeFixture();
    const secret = "API_KEY=sk-examplecredential1234567890";
    fixture.ownerDocumentsError = Object.assign(new Error(secret), {
      name: "CredentialBoundaryError",
    });
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    connection.deliver(
      encodeClientEnvelope(
        request("owner-secret", "owner-secret-correlation", {
          type: "owner_documents",
          personaId: "persona-1",
          path: null,
        }),
      ),
    );
    await connection.waitForFrames(2);

    expect(connection.envelopes()[1]).toMatchObject({
      kind: "response",
      outcome: { status: "error", error: { code: "invalid_request" } },
    });
    expect(JSON.stringify(connection.envelopes())).not.toContain(secret);
    expect(connection.envelopes().filter((envelope) => envelope.kind === "event")).toHaveLength(0);
  });

  it("closes a handshake without sending bytes when Provider capabilities contain credentials", async () => {
    const fixture = runtimeFixture();
    const secret = "opaque.capability.8b93e24d71f6";
    fixture.credentialGuards = [createExactCredentialGuard(() => secret)];
    fixture.providerCapabilities = [
      {
        provider: "unsafe-provider",
        model: "unsafe-model",
        displayName: secret,
        contextWindow: 4_096,
        maxOutputTokens: 512,
        reasoning: false,
        authenticated: true,
      },
    ];
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);

    connection.deliver(encodeClientEnvelope(helloEnvelope()));
    await connection.waitForClose();

    expect(connection.frames).toHaveLength(0);
    expect(JSON.stringify(connection.envelopes())).not.toContain(secret);
  });

  it("applies the exact credential gate to the complete transport envelope", async () => {
    const fixture = runtimeFixture();
    const secret = "opaque.authority.fact.8b93e24d71f6";
    fixture.credentialGuards = [createExactCredentialGuard(() => secret)];
    fixture.authorityPersonas = [
      personaView({ persona: { ...personaFact(), displayName: secret }, run: null }),
    ];
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);

    connection.deliver(encodeClientEnvelope(helloEnvelope()));
    await connection.waitForClose();

    expect(connection.frames).toHaveLength(0);
    expect(JSON.stringify(connection.envelopes())).not.toContain(secret);
  });

  it("returns a generic error without observations when a Tool description becomes credential-bearing", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);
    const secret = "opaque.tool.capability.8b93e24d71f6";
    const guard = createExactCredentialGuard(() => secret);
    fixture.credentialGuards = [guard];
    fixture.runtimeTools = [
      {
        name: "unsafe_tool",
        effect: "none",
        credentialGuards: [guard],
        describe: () => ({
          name: "unsafe_tool",
          label: "Unsafe Tool",
          description: secret,
          inputSchema: {},
        }),
        validate: () => undefined,
        execute: async () => ({ content: "unused" }),
      },
    ];

    connection.deliver(
      encodeClientEnvelope(
        request("unsafe-capabilities", "unsafe-capabilities-correlation", {
          type: "capabilities",
          personaId: null,
        }),
      ),
    );
    await connection.waitForFrames(2);

    expect(connection.envelopes()[1]).toMatchObject({
      kind: "response",
      outcome: { status: "error", error: { code: "invalid_request" } },
    });
    expect(connection.closed).toBe(false);
    expect(JSON.stringify(connection.envelopes())).not.toContain(secret);
    expect(connection.envelopes().filter((envelope) => envelope.kind === "event")).toHaveLength(0);
  });

  it("retains a next-page cursor when history is requested at the public limit", async () => {
    const fixture = runtimeFixture();
    fixture.historyCheckpoints = Array.from({ length: 1_001 }, (_, index) => ({
      commit: `checkpoint-${index + 1}`,
      parent: index === 1_000 ? null : `checkpoint-${index + 2}`,
      message: `Checkpoint ${index + 1}`,
      timestamp: ISO,
    }));
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    connection.deliver(
      encodeClientEnvelope(
        request("history-at-limit", "history-at-limit-correlation", {
          type: "history",
          personaId: "persona-1",
          beforeCheckpointId: null,
          limit: 1_000,
        }),
      ),
    );
    await connection.waitForFrames(2);

    const response = connection.envelopes()[1];
    if (response?.kind !== "response" || response.outcome.status !== "ok") {
      throw new Error("Expected a successful history response.");
    }
    if (response.outcome.result.type !== "history") throw new Error("Expected history result.");
    expect(response.outcome.result.checkpoints).toHaveLength(1_000);
    expect(response.outcome.result.nextBeforeCheckpointId).toBe("checkpoint-1000");
  });

  it("uses reply correlation for responses and stable observation correlation plus causation for events", async () => {
    const fixture = runtimeFixture();
    fixture.emitOnPause = true;
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    connection.deliver(
      encodeClientEnvelope(
        request("pause-with-event", "pause-request-correlation", {
          type: "pause",
          personaId: "persona-1",
        }),
      ),
    );
    await connection.waitForFrames(3);

    const [event, response] = connection.envelopes().slice(1);
    expect(event).toMatchObject({
      kind: "event",
      correlationId: "observation:20",
      causationId: "pause-with-event",
      record: { correlationId: "observation:20" },
    });
    expect(response).toMatchObject({
      kind: "response",
      correlationId: "pause-request-correlation",
      replyTo: "pause-with-event",
    });
  });

  it("emits strictly encoded immutable cognition/tool/commit/publication/H facts", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    const facts: ObservationFact[] = [
      fact(1, "model_request", {
        attemptId: "attempt-1",
        role: "persona",
        request: { role: "persona", promptLocale: "en", messages: [] },
      }),
      fact(2, "internal_cognition", {
        attemptId: "attempt-1",
        channel: "assistant",
        content: "private thought",
        attemptState: "completed",
        externalMessage: false,
      }),
      fact(3, "provider_attempt", {
        attemptId: "attempt-1",
        turnId: "turn-1",
        attempt: 1,
        providerId: "provider-1",
        modelId: "model-1",
        state: "completed",
        retryAt: null,
        error: null,
      }),
      fact(4, "usage", {
        attemptId: "attempt-1",
        inputTokens: 20,
        outputTokens: 10,
        cachedInputTokens: 5,
      }),
      fact(5, "tool_proposal", {
        attemptId: "attempt-1",
        toolCallId: "tool-call-1",
        toolName: "send_message",
        arguments: { recipient: "owner", text: "hello" },
        proposedAt: NOW,
      }),
      fact(6, "tool_dispatch", {
        toolCallId: "tool-call-1",
        dispatchId: "dispatch-1",
        intentId: "intent-1",
        state: "dispatched",
        checkedAt: NOW,
        externalEffect: "possible",
        authority: [
          {
            decisionId: "decision-1",
            stage: "dispatch",
            allowed: true,
            revision: "policy-1",
            reason: null,
            checkedAt: ISO,
          },
        ],
      }),
      fact(7, "tool_outcome", {
        toolCallId: "tool-call-1",
        dispatchId: "dispatch-1",
        state: "unknown",
        externalEffect: "unknown",
        result: null,
        code: "external_outcome_unknown",
      }),
      fact(8, "tool_callback", {
        toolCallId: "tool-call-1",
        callbackId: "callback-1",
        outcome: { state: "unknown", reason: "carrier_timeout" },
      }),
      fact(9, "event_committed", {
        eventId: "event-1",
        sourceWorkItemIds: ["work-1"],
        summary: "Event summary",
        needsMemory: true,
        checkpoint: checkpointDto(),
        committedAt: ISO,
      }),
      fact(10, "publication", {
        publicationId: "publication-1",
        eventId: "event-1",
        checkpointId: "checkpoint-1",
        state: "delivered",
        attempt: 1,
        retryAt: null,
        receipt: { cursor: 1 },
        error: null,
      }),
      fact(11, "hippocampus", {
        jobId: "job-1",
        eventId: "event-1",
        checkpointId: "checkpoint-1",
        state: "applied",
        attempt: 1,
        retryAt: null,
        error: null,
      }),
      fact(12, "lifecycle", { phase: "running", runId: "run-1", reason: null }),
      fact(13, "queue", {
        workItemId: "work-1",
        source: "stimulus",
        stimulusKind: "user_message",
        action: "accepted",
      }),
      fact(14, "diagnostic", {
        severity: "warning",
        code: "test_diagnostic",
        message: "Test diagnostic",
        details: { safe: true },
      }),
    ];
    for (const observation of facts) fixture.emit(observation);
    await connection.waitForFrames(1 + facts.length);

    const events = connection.envelopes().slice(1) as EventEnvelope[];
    expect(events.map((event) => event.record.observation.kind)).toEqual([
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
    ]);
    expect(events[1]?.record.observation).toMatchObject({ externalMessage: false });
    expect(events[6]?.record.observation).toMatchObject({
      state: "unknown",
      externalEffect: "unknown",
      result: null,
      error: { code: "outcome_unknown" },
    });
    for (const event of events) {
      expect(event.correlationId).toBe(event.record.correlationId);
      expect(event.causationId).toBeNull();
      expect(event.snapshot.revision).toBe(fixture.revision);
    }
  });

  it("maps every public command to the Runtime boundary", async () => {
    const fixture = runtimeFixture();
    const server = new ProtocolServer(fixture.runtime, deterministicOptions());
    const connection = new MemoryByteConnection();
    await server.attach(connection);
    await hello(connection);

    const commands: Command[] = [
      {
        type: "create",
        templateId: "default",
        personaId: "new-persona",
        displayName: "New Persona",
        uiLocale: "en",
        promptLocale: "en",
      },
      { type: "init", personaId: "persona-1", expectedWorkingTreeDigest: null },
      {
        type: "start",
        personaId: "persona-1",
        from: { kind: "current_working_tree" },
        model: null,
        promptLocale: null,
      },
      { type: "pause", personaId: "persona-1" },
      { type: "resume", personaId: "persona-1" },
      { type: "stop", personaId: "persona-1" },
      { type: "force", personaId: "persona-1" },
      {
        type: "stimulus",
        personaId: "persona-1",
        idempotencyKey: "stimulus-key",
        stimulus: { kind: "user_message", content: { text: "hello" }, occurredAt: null, source: "test" },
      },
      {
        type: "callback",
        personaId: "persona-1",
        toolCallId: "tool-call-1",
        callbackId: "callback-1",
        outcome: { state: "unknown", reason: "carrier_timeout" },
      },
      { type: "owner_documents", personaId: "persona-1", path: null },
      {
        type: "put_owner_document",
        personaId: "persona-1",
        path: "workspace/persona/profile.md",
        content: "# Profile\n",
        expectedSha256: null,
      },
      { type: "history", personaId: "persona-1", beforeCheckpointId: null, limit: 10 },
      { type: "branch", personaId: "persona-1", checkpointId: "checkpoint-1", branchName: "branch-1" },
      {
        type: "clone",
        personaId: "persona-1",
        checkpointId: "checkpoint-1",
        newPersonaId: "clone-1",
        displayName: "Clone",
      },
      {
        type: "restore",
        personaId: "persona-1",
        checkpointId: "checkpoint-1",
        workingTreePolicy: "discard_changes",
      },
      {
        type: "delete",
        personaId: "persona-1",
        confirmationPersonaId: "persona-1",
        workingTreePolicy: "discard_changes",
      },
      { type: "locales" },
      { type: "retry", personaId: "persona-1", target: { kind: "hippocampus", jobId: "job-1" } },
      { type: "capabilities", personaId: null },
      { type: "observations", personaId: "persona-1", afterCursor: null, limit: 10, kinds: null },
      { type: "snapshot" },
    ];
    for (const [index, command] of commands.entries()) {
      connection.deliver(encodeClientEnvelope(request(`command-${index}`, `correlation-${index}`, command)));
    }
    await connection.waitForFrames(1 + commands.length);

    const responses = connection.envelopes().slice(1);
    expect(responses).toHaveLength(commands.length);
    for (const response of responses) {
      expect(response).toMatchObject({ kind: "response", outcome: { status: "ok" } });
    }
    expect(fixture.called).toEqual(
      expect.arrayContaining([
        "create",
        "init",
        "start",
        "pause",
        "resume",
        "stop",
        "force",
        "stimulus",
        "callback",
        "ownerDocuments",
        "putOwnerDocument",
        "history",
        "branch",
        "clone",
        "restore",
        "delete",
        "retryHippocampus",
        "observations",
      ]),
    );
  });
});

const NOW = Date.parse("2026-08-30T00:00:00.000Z");
const ISO = new Date(NOW).toISOString();

function deterministicOptions() {
  let id = 0;
  return { now: () => NOW, id: () => `server-message-${++id}` };
}

function helloEnvelope(): ClientEnvelope {
  return {
    protocol: "kokoro/1",
    kind: "hello",
    messageId: "client-hello",
    correlationId: "hello-correlation",
    client: { name: "test-client", version: "1.0.0" },
    maxFrameBytes: MAX_FRAME_BYTES,
  };
}

async function hello(connection: MemoryByteConnection): Promise<void> {
  connection.deliver(encodeClientEnvelope(helloEnvelope()));
  await connection.waitForFrames(1);
  expect(connection.envelopes()[0]).toMatchObject({
    kind: "hello",
    replyTo: "client-hello",
    correlationId: "hello-correlation",
    snapshot: { revision: 1 },
    outcome: { status: "ok" },
  });
}

function request(messageId: string, correlationId: string, command: Command): ClientEnvelope {
  return {
    protocol: "kokoro/1",
    kind: "request",
    messageId,
    correlationId,
    expectedRevision: null,
    command,
  };
}

class MemoryByteConnection implements ByteConnection {
  readonly peerIdentity = "authorized-test-peer";
  readonly frames: Uint8Array[] = [];
  readonly #data = new Set<(chunk: Uint8Array) => void>();
  readonly #close = new Set<(reason?: unknown) => void>();
  closed = false;
  hangAfterFrames = Number.POSITIVE_INFINITY;

  async send(frame: Uint8Array): Promise<void> {
    if (this.frames.length >= this.hangAfterFrames) return new Promise<void>(() => undefined);
    this.frames.push(frame.slice());
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#close) listener(reason);
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onClose(listener: (reason?: unknown) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  deliver(frame: Uint8Array): void {
    for (const listener of this.#data) listener(frame);
  }

  envelopes(): ServerEnvelope[] {
    const decoder = new LengthPrefixedFrameDecoder();
    return this.frames.flatMap((frame) => decoder.push(frame).map(decodeServerPayload));
  }

  async waitForFrames(count: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (this.frames.length < count) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${count} frames; got ${this.frames.length}.`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async waitForClose(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for connection close.");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

function runtimeFixture() {
  let revision = 1;
  let historyDelayMs = 0;
  let emitOnPause = false;
  let authorityCalls = 0;
  let emitDuringAuthorityCall = 0;
  let slowAuthorityCall = 0;
  let pauseCalls = 0;
  let authorityPersonas: RuntimePersonaView[] = [];
  let ownerDocumentsError: Error | undefined;
  let providerCapabilities: ModelCapability[] = [];
  let runtimeTools: RuntimeTool[] = [];
  let credentialGuards: readonly CredentialGuard[] = NO_CREDENTIAL_GUARDS;
  let historyCheckpoints: CheckpointInfoLike[];
  let lastRestoreArguments: unknown[] | undefined;
  const called: string[] = [];
  const observationListeners = new Set<(fact: ObservationFact) => void>();
  const observations: ObservationFact[] = [];
  const persona = personaFact();
  const run = runFact();
  const queueItem = queueFact();
  const event = eventFact();
  const job = jobFact();
  const tool = toolCallFact();
  const checkpoint: CheckpointInfoLike = {
    commit: "checkpoint-1",
    parent: null,
    message: "Checkpoint summary",
    timestamp: ISO,
  };
  historyCheckpoints = [checkpoint];
  const runtime = {
    incarnation: "incarnation-1",
    credentialBoundary: {
      get credentialGuards() {
        return credentialGuards;
      },
    },
    providers: { capabilities: async () => providerCapabilities },
    tools: { list: () => runtimeTools },
    store: {
      callbackForToolCall: () => ({ callbackId: "callback-1", payload: null, receivedAt: NOW }),
      requireEvent: () => event,
      requireHippocampusJob: () => job,
      requireQueueItem: () => queueItem,
      requireToolCall: () => tool,
      reserveAuthorityRevision: (expectedRevision: number) => {
        if (revision !== expectedRevision) return { accepted: false, actualRevision: revision };
        revision += 1;
        return { accepted: true, actualRevision: revision };
      },
    },
    authorityView: async () => {
      authorityCalls += 1;
      const view = { revision, capturedAt: NOW + revision, personas: authorityPersonas };
      if (authorityCalls === emitDuringAuthorityCall) {
        revision += 1;
        const observation = fact(30, "lifecycle", {
          phase: "running",
          runId: "run-1",
          reason: "snapshot_race",
        });
        observations.push(observation);
        for (const listener of observationListeners) listener(observation);
      }
      if (authorityCalls === slowAuthorityCall) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return view;
    },
    subscribeObservations(listener: (fact: ObservationFact) => void) {
      observationListeners.add(listener);
      return () => observationListeners.delete(listener);
    },
    async createPersona() {
      called.push("create");
      return { ...persona, id: "new-persona", displayName: "New Persona" };
    },
    async initialize() {
      called.push("init");
      return persona;
    },
    async start() {
      called.push("start");
      return run;
    },
    pause() {
      called.push("pause");
      pauseCalls += 1;
      revision += 1;
      if (emitOnPause) {
        const observation = fact(20, "lifecycle", {
          phase: "pausing",
          runId: "run-1",
          reason: null,
        });
        observations.push(observation);
        for (const listener of observationListeners) listener(observation);
      }
      return run;
    },
    async resume() {
      called.push("resume");
      return run;
    },
    async stop() {
      called.push("stop");
      return run;
    },
    async force() {
      called.push("force");
      return run;
    },
    submitStimulus() {
      called.push("stimulus");
      return { stimulusId: "stimulus-1", item: queueItem };
    },
    submitCallback() {
      called.push("callback");
      return { callbackId: "callback-1", recorded: true };
    },
    async ownerDocuments() {
      called.push("ownerDocuments");
      if (ownerDocumentsError) throw ownerDocumentsError;
      return [ownerDocumentFixture()];
    },
    async putOwnerDocument(input: { path: string; content: string }) {
      called.push("putOwnerDocument");
      return { ...ownerDocumentFixture(), path: input.path, content: input.content };
    },
    async restore(...input: unknown[]) {
      called.push("restore");
      lastRestoreArguments = input;
      return persona;
    },
    async branch() {
      called.push("branch");
    },
    async clone() {
      called.push("clone");
      return { ...persona, id: "clone-1", displayName: "Clone" };
    },
    async deletePersona() {
      called.push("delete");
    },
    async checkpoints(_personaId: string, before: string | null, limit: number) {
      called.push("history");
      if (historyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, historyDelayMs));
      const index =
        before === null
          ? 0
          : Math.max(0, historyCheckpoints.findIndex((entry) => entry.commit === before) + 1);
      return historyCheckpoints.slice(index, index + limit);
    },
    async retryHippocampus() {
      called.push("retryHippocampus");
      return job;
    },
    observations(_personaId: string, after: number, limit: number) {
      called.push("observations");
      return observations.filter((entry) => entry.sequence > after).slice(0, limit);
    },
  } as unknown as ProtocolRuntime;
  return {
    runtime,
    called,
    get revision() {
      return revision;
    },
    get pauseCalls() {
      return pauseCalls;
    },
    get lastRestoreArguments() {
      return lastRestoreArguments;
    },
    get historyDelayMs() {
      return historyDelayMs;
    },
    set historyDelayMs(value: number) {
      historyDelayMs = value;
    },
    set historyCheckpoints(value: CheckpointInfoLike[]) {
      historyCheckpoints = value;
    },
    set authorityPersonas(value: RuntimePersonaView[]) {
      authorityPersonas = value;
    },
    set ownerDocumentsError(value: Error | undefined) {
      ownerDocumentsError = value;
    },
    set providerCapabilities(value: ModelCapability[]) {
      providerCapabilities = value;
    },
    set runtimeTools(value: RuntimeTool[]) {
      runtimeTools = value;
    },
    set credentialGuards(value: readonly CredentialGuard[]) {
      credentialGuards = value;
    },
    get emitOnPause() {
      return emitOnPause;
    },
    set emitOnPause(value: boolean) {
      emitOnPause = value;
    },
    get emitDuringAuthorityCall() {
      return emitDuringAuthorityCall;
    },
    set emitDuringAuthorityCall(value: number) {
      emitDuringAuthorityCall = value;
    },
    get slowAuthorityCall() {
      return slowAuthorityCall;
    },
    set slowAuthorityCall(value: number) {
      slowAuthorityCall = value;
    },
    emit(observation: ObservationFact) {
      observations.push(observation);
      for (const listener of observationListeners) listener(observation);
    },
  };
}

type CheckpointInfoLike = {
  commit: string;
  parent: string | null;
  message: string;
  timestamp: string;
};

function ownerDocumentFixture() {
  return {
    path: "workspace/persona/profile.md",
    content: "# Profile\n",
    sha256: "a".repeat(64),
    mtimeMs: NOW + 0.5,
  };
}

function personaView(input: { persona: PersonaFact; run: RunFact | null }): RuntimePersonaView {
  return {
    persona: input.persona,
    run: input.run,
    activeEvent: null,
    queue: [],
    latestCheckpoint: {
      commit: "checkpoint-1",
      summary: "Checkpoint summary",
      createdAt: NOW,
    },
    workingTree: { state: "clean", digest: "working-tree-digest" },
    publication: { pending: 0, delivering: 0, retryWaiting: 0, failed: 0 },
    hippocampus: [],
  };
}

function personaFact(): PersonaFact {
  return {
    id: "persona-1",
    displayName: "Persona One",
    repositoryPath: "D:/personas/persona-1",
    lifecycle: "ready",
    uiLocale: "en",
    promptLocale: "en",
    initialized: true,
    currentCheckpoint: "checkpoint-1",
    selectedCheckpoint: "checkpoint-1",
    revision: 1,
    createdAt: NOW,
  };
}

function runFact(): RunFact {
  return {
    id: "run-1",
    personaId: "persona-1",
    incarnation: "incarnation-1",
    phase: "running",
    model: { provider: "provider-1", model: "model-1" },
    sessionId: "session-1",
    startingCheckpoint: "checkpoint-1",
    currentQueueItemId: null,
    waitingCode: null,
    fault: null,
    stopCutoffSequence: null,
    startedAt: NOW,
    endedAt: null,
  };
}

function queueFact(): QueueItemFact {
  return {
    id: "work-1",
    runId: "run-1",
    sequence: 1,
    kind: "stimulus",
    payload: { kind: "user_message", payload: { content: "hello" } },
    stimulusId: "stimulus-1",
    sourceEventId: null,
    sourceToolCallId: null,
    status: "queued",
    acceptedAt: NOW,
    startedAt: null,
    finishedAt: null,
  };
}

function eventFact(): EventFact {
  return {
    id: "event-1",
    personaId: "persona-1",
    runId: "run-1",
    sessionId: "session-1",
    queueItemId: "work-1",
    sequence: 1,
    status: "checkpointed",
    sourceKind: "stimulus",
    frozen: { version: 1 },
    summary: "Event summary",
    memoryDecision: "maintain",
    checkpoint: "checkpoint-1",
    createdAt: NOW,
    frozenAt: NOW,
    closedAt: NOW,
    checkpointedAt: NOW,
  };
}

function jobFact(): HippocampusJobFact {
  return {
    id: "job-1",
    personaId: "persona-1",
    eventId: "event-1",
    sourceCheckpoint: "checkpoint-1",
    model: { provider: "provider-1", model: "model-1" },
    promptLocale: "en",
    status: "completed",
    attempts: 1,
    proposal: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function toolCallFact(): ToolCallFact {
  return {
    id: "tool-call-1",
    eventId: "event-1",
    turnId: "turn-1",
    sequence: 1,
    providerCallId: "provider-tool-call-1",
    name: "send_message",
    arguments: { recipient: "owner", text: "hello" },
    effect: "external",
    status: "unknown",
    authorizationRevision: "authorization-1",
    dispatchResult: null,
    result: null,
    proposedAt: NOW,
    intentAt: NOW,
    dispatchAt: NOW,
    outcomeAt: NOW,
  };
}

function fact(sequence: number, kind: string, payload: ObservationFact["payload"]): ObservationFact {
  return {
    sequence,
    personaId: "persona-1",
    runId: "run-1",
    eventId: "event-1",
    kind,
    payload,
    createdAt: NOW + sequence,
  };
}

function checkpointDto() {
  return {
    checkpointId: "checkpoint-1",
    commitId: "checkpoint-1",
    summary: "Event summary",
    createdAt: ISO,
  };
}
