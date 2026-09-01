import type { RequestEnvelope, ResponseEnvelope } from "@kokoro/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  KokoroClient,
  KokoroDisconnectedError,
  KokoroProtocolError,
  KokoroServerError,
} from "../src/index.js";
import {
  eventFor,
  finishHandshake,
  helloFor,
  MemoryTransportHost,
  NOW,
  responseFor,
  snapshot,
} from "./support.js";

function createClient(
  host: MemoryTransportHost,
  overrides: Partial<ConstructorParameters<typeof KokoroClient>[0]> = {},
) {
  let sequence = 0;
  return new KokoroClient({
    transportFactory: host.factory,
    clientName: "test-client",
    clientVersion: "1.0.0",
    createId: () => `client-id-${++sequence}`,
    handshakeTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    ...overrides,
  });
}

async function connectedClient(host = new MemoryTransportHost()) {
  const client = createClient(host);
  await finishHandshake(client.connect(), host, { fragment: 1 });
  return { client, host };
}

describe("handshake and connection generations", () => {
  it("requires a correlated hello and accepts arbitrary fragmentation", async () => {
    const host = new MemoryTransportHost();
    const client = createClient(host);
    const states: string[] = [];
    client.subscribeConnection((change) => states.push(`${change.previous}->${change.current}`));
    const connected = client.connect();
    const authoritative = await finishHandshake(connected, host, { revision: 7, fragment: 1 });
    expect(authoritative.revision).toBe(7);
    expect(client.snapshot?.revision).toBe(7);
    expect(client.capabilities?.protocol).toBe("kokoro/1");
    expect(states).toEqual(["disconnected->connecting", "connecting->connected"]);
    client.dispose();
  });

  it("rejects a hello with the wrong correlation", async () => {
    const host = new MemoryTransportHost();
    const client = createClient(host);
    const connecting = client.connect();
    await host.waitForReceived(1);
    const hello = host.received[0];
    if (!hello) throw new Error("missing hello");
    if (hello.kind !== "hello") throw new Error("expected hello");
    host.deliver({ ...helloFor(hello), correlationId: "wrong-correlation" });
    await expect(connecting).rejects.toBeInstanceOf(KokoroProtocolError);
    expect(client.connectionState).toBe("disconnected");
  });

  it("honors the server's smaller negotiated outbound frame limit", async () => {
    const host = new MemoryTransportHost();
    const client = createClient(host);
    const connecting = client.connect();
    await host.waitForReceived(1);
    const hello = host.received[0];
    if (!hello || hello.kind !== "hello") throw new Error("expected hello");
    const serverHello = helloFor(hello);
    if (serverHello.outcome.status !== "ok") throw new Error("expected successful fixture hello");
    host.deliver({
      ...serverHello,
      outcome: {
        ...serverHello.outcome,
        capabilities: { ...serverHello.outcome.capabilities, maxFrameBytes: 256 },
      },
    });
    await connecting;

    await expect(
      client.submitStimulus({
        personaId: "persona-1",
        idempotencyKey: "too-large",
        stimulus: {
          kind: "user_message",
          content: { text: "x".repeat(512) },
          occurredAt: NOW,
          source: "test",
        },
      }),
    ).rejects.toThrow(/limit is 256/);
    expect(host.received).toHaveLength(1);
    expect(client.connected).toBe(true);
    client.dispose();
  });

  it("ignores callbacks from an old transport generation after explicit reconnect", async () => {
    const { client, host } = await connectedClient();
    client.disconnect();
    expect(client.connectionState).toBe("disconnected");
    const reconnecting = client.connect();
    await host.waitForReceived(2);
    const secondHello = host.received[1];
    if (!secondHello) throw new Error("missing second hello");
    if (secondHello.kind !== "hello") throw new Error("expected second hello");
    host.deliver(helloFor(secondHello, 10), { generation: 1 });
    await reconnecting;

    host.deliver(
      eventFor(99, {
        kind: "diagnostic",
        severity: "error",
        code: "stale-worker",
        message: "must be ignored",
        details: null,
      }),
      { generation: 0 },
    );
    expect(client.snapshot?.revision).toBe(10);
    client.dispose();
  });
});

describe("request correlation", () => {
  it("resolves out-of-order responses and never lets a stale response replace newer authority", async () => {
    const { client, host } = await connectedClient();
    const pause = client.pause("persona-1");
    const history = client.history({ personaId: "persona-1", beforeCheckpointId: null, limit: 10 });
    await host.waitForReceived(3);
    const pauseRequest = host.received[1] as RequestEnvelope;
    const historyRequest = host.received[2] as RequestEnvelope;

    host.deliver(
      responseFor(historyRequest, { type: "history", checkpoints: [], nextBeforeCheckpointId: null }, 3),
    );
    host.deliver(
      responseFor(pauseRequest, { type: "pause", operationId: "operation-pause", acceptedAt: NOW }, 2),
    );

    await expect(history).resolves.toMatchObject({ type: "history" });
    await expect(pause).resolves.toMatchObject({ type: "pause" });
    expect(client.snapshot?.revision).toBe(3);
    client.dispose();
  });

  it("treats a wrong correlation or result discriminator as a protocol fault", async () => {
    const first = await connectedClient();
    const pause = first.client.pause("persona-1");
    await first.host.waitForReceived(2);
    const request = first.host.received[1] as RequestEnvelope;
    first.host.deliver({
      ...responseFor(request, { type: "pause", operationId: "op", acceptedAt: NOW }, 2),
      correlationId: "wrong",
    });
    await expect(pause).rejects.toBeInstanceOf(KokoroProtocolError);
    expect(first.client.connectionState).toBe("disconnected");

    const second = await connectedClient();
    const stop = second.client.stop("persona-1");
    await second.host.waitForReceived(2);
    const stopRequest = second.host.received[1] as RequestEnvelope;
    second.host.deliver(
      responseFor(stopRequest, { type: "history", checkpoints: [], nextBeforeCheckpointId: null }, 2),
    );
    await expect(stop).rejects.toBeInstanceOf(KokoroProtocolError);
    expect(second.client.connectionState).toBe("disconnected");
  });

  it("applies an error response snapshot before exposing the typed server error", async () => {
    const { client, host } = await connectedClient();
    const requestPromise = client.restore({
      personaId: "persona-1",
      checkpointId: "checkpoint-1",
      workingTreePolicy: "require_clean",
    });
    await host.waitForReceived(2);
    const request = host.received[1] as RequestEnvelope;
    const response: ResponseEnvelope = {
      protocol: "kokoro/1",
      kind: "response",
      messageId: "response-conflict",
      correlationId: request.correlationId,
      replyTo: request.messageId,
      snapshot: snapshot(4),
      outcome: {
        status: "error",
        error: {
          code: "working_tree_conflict",
          message: "Owner changes are present",
          retryable: false,
          details: { personaId: "persona-1" },
        },
      },
    };
    host.deliver(response);
    await expect(requestPromise).rejects.toMatchObject({
      constructor: KokoroServerError,
      error: { code: "working_tree_conflict" },
      snapshot: { revision: 4 },
    });
    expect(client.snapshot?.revision).toBe(4);
    client.dispose();
  });

  it("rejects pending requests on disconnect instead of leaving them unresolved", async () => {
    const { client, host } = await connectedClient();
    const pending = client.refreshSnapshot();
    await host.waitForReceived(2);
    host.remoteClose();
    await expect(pending).rejects.toBeInstanceOf(KokoroDisconnectedError);
    expect(client.connectionState).toBe("disconnected");
  });
});

describe("authoritative state and subscriptions", () => {
  it("delivers causal Provider retry DTOs without collapsing the retry state", async () => {
    const { client, host } = await connectedClient();
    const seen = vi.fn();
    client.subscribeObservations(seen);

    host.deliver(
      eventFor(2, {
        kind: "provider_attempt",
        attemptId: "attempt-1",
        turnId: "turn-1",
        attempt: 1,
        providerId: "provider-1",
        modelId: "model-1",
        state: "retry_wait",
        retryAt: NOW,
        error: { code: "unavailable", message: "temporary", retryable: true, details: null },
      }),
    );

    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          kind: "provider_attempt",
          turnId: "turn-1",
          attempt: 1,
          state: "retry_wait",
        }),
      }),
      expect.objectContaining({ kind: "event" }),
    );
    client.dispose();
  });

  it("notifies observations while only monotonic snapshots update authority", async () => {
    const { client, host } = await connectedClient();
    const records: string[] = [];
    const revisions: number[] = [];
    client.subscribeObservations((record) => records.push(record.observationId));
    client.subscribeSnapshot((value) => revisions.push(value.revision));

    host.deliver(
      eventFor(3, {
        kind: "tool_outcome",
        toolCallId: "call-1",
        dispatchId: "dispatch-1",
        state: "unknown",
        externalEffect: "unknown",
        result: null,
        error: {
          code: "outcome_unknown",
          message: "Dispatch completed but the remote result is unknown",
          retryable: false,
          details: null,
        },
      }),
    );
    host.deliver(
      eventFor(
        2,
        {
          kind: "internal_cognition",
          attemptId: "attempt-1",
          channel: "assistant",
          sequence: 0,
          content: "not an external message",
          attemptState: "completed",
          externalMessage: false,
        },
        "stale",
      ),
    );

    expect(client.snapshot?.revision).toBe(3);
    expect(revisions).toEqual([3]);
    expect(records).toEqual(["observation-3", "observation-stale"]);
    client.dispose();
  });

  it("disconnects if equal revisions contain different facts", async () => {
    const { client, host } = await connectedClient();
    host.deliver(
      eventFor(2, { kind: "diagnostic", severity: "info", code: "first", message: "first", details: null }),
    );
    const conflicting = eventFor(
      2,
      { kind: "diagnostic", severity: "warning", code: "second", message: "second", details: null },
      "conflict",
    );
    host.deliver({
      ...conflicting,
      snapshot: { ...conflicting.snapshot, capturedAt: "2026-08-30T00:02:00.000Z" },
    });
    expect(client.connectionState).toBe("disconnected");
  });

  it("isolates listener exceptions from authority and later listeners", async () => {
    const listenerError = vi.fn();
    const host = new MemoryTransportHost();
    const client = createClient(host, { onListenerError: listenerError });
    await finishHandshake(client.connect(), host);
    const later = vi.fn();
    client.subscribeObservations(() => {
      throw new Error("consumer failed");
    });
    client.subscribeObservations(later);
    host.deliver(
      eventFor(2, { kind: "diagnostic", severity: "info", code: "ok", message: "ok", details: null }),
    );
    expect(listenerError).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(client.snapshot?.revision).toBe(2);
    client.dispose();
  });
});

describe("typed convenience API", () => {
  it("reads and compare-and-swaps Owner Markdown without exposing repository roots", async () => {
    const { client, host } = await connectedClient();
    const document = {
      path: "workspace/persona/profile.md",
      content: "# Profile\n",
      sha256: "a".repeat(64),
      mtimeMs: 1_777_500_000_000.5,
    };
    const reading = client.ownerDocuments({ personaId: "persona-1", path: null });
    await host.waitForReceived(2);
    const readRequest = host.received[1] as RequestEnvelope;
    expect(readRequest).toMatchObject({
      expectedRevision: null,
      command: { type: "owner_documents", personaId: "persona-1", path: null },
    });
    host.deliver(responseFor(readRequest, { type: "owner_documents", documents: [document] }, 2));
    await expect(reading).resolves.toEqual({ type: "owner_documents", documents: [document] });

    const writing = client.putOwnerDocument({
      personaId: "persona-1",
      path: document.path,
      content: "# Updated profile\n",
      expectedSha256: document.sha256,
    });
    await host.waitForReceived(3);
    const writeRequest = host.received[2] as RequestEnvelope;
    expect(writeRequest).toMatchObject({
      expectedRevision: 2,
      command: {
        type: "put_owner_document",
        path: document.path,
        expectedSha256: document.sha256,
      },
    });
    const updated = {
      ...document,
      content: "# Updated profile\n",
      sha256: "b".repeat(64),
      mtimeMs: document.mtimeMs + 1,
    };
    host.deliver(responseFor(writeRequest, { type: "put_owner_document", document: updated }, 3));
    await expect(writing).resolves.toEqual({ type: "put_owner_document", document: updated });
    client.dispose();
  });

  it("emits callback as callback-only work without coupling idempotent facts to a volatile revision", async () => {
    const { client, host } = await connectedClient();
    const promise = client.submitCallback({
      personaId: "persona-1",
      toolCallId: "tool-call-1",
      callbackId: "callback-1",
      outcome: { state: "succeeded", result: { delivered: true } },
    });
    await host.waitForReceived(2);
    const request = host.received[1] as RequestEnvelope;
    expect(request.expectedRevision).toBeNull();
    expect(request.command).toEqual({
      type: "callback",
      personaId: "persona-1",
      toolCallId: "tool-call-1",
      callbackId: "callback-1",
      outcome: { state: "succeeded", result: { delivered: true } },
    });
    host.deliver(
      responseFor(
        request,
        { type: "callback", callbackId: "callback-1", toolCallId: "tool-call-1", recordedAt: NOW },
        2,
      ),
    );
    await expect(promise).resolves.toMatchObject({ type: "callback" });
    client.dispose();
  });
});
