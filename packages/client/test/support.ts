import {
  type AuthoritySnapshot,
  type CapabilitySnapshot,
  type ClientEnvelope,
  type ClientHelloEnvelope,
  COMMAND_TYPES,
  type CommandResult,
  decodeClientPayload,
  type EventEnvelope,
  encodeServerEnvelope,
  LengthPrefixedFrameDecoder,
  MAX_FRAME_BYTES,
  OBSERVATION_KINDS,
  type Observation,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ServerHelloEnvelope,
} from "@kokoro/protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "../src/transport.js";

export const NOW = "2026-08-30T00:00:00.000Z";

export function snapshot(revision: number, capturedAt = NOW): AuthoritySnapshot {
  return { revision, capturedAt, personas: [] };
}

export function capabilities(): CapabilitySnapshot {
  return {
    protocol: "kokoro/1",
    serverVersion: "0.1.0",
    maxFrameBytes: MAX_FRAME_BYTES,
    commands: COMMAND_TYPES,
    availableCommands: ["create", "locales", "capabilities", "snapshot"],
    observationKinds: OBSERVATION_KINDS,
    locales: [
      { locale: "en", label: "English", ui: true, prompt: true },
      { locale: "zh-CN", label: "简体中文", ui: true, prompt: true },
    ],
    providers: [],
    tools: [],
    features: { continuation: true, publication: true, hippocampus: true },
  };
}

export function helloFor(hello: ClientHelloEnvelope, revision = 1): ServerHelloEnvelope {
  return {
    protocol: "kokoro/1",
    kind: "hello",
    messageId: `server-${hello.messageId}`,
    correlationId: hello.correlationId,
    replyTo: hello.messageId,
    snapshot: snapshot(revision),
    outcome: {
      status: "ok",
      server: { name: "test-kokoro", version: "0.1.0" },
      capabilities: capabilities(),
    },
  };
}

export function responseFor(
  request: RequestEnvelope,
  result: CommandResult,
  revision: number,
): ResponseEnvelope {
  return {
    protocol: "kokoro/1",
    kind: "response",
    messageId: `server-${request.messageId}`,
    correlationId: request.correlationId,
    replyTo: request.messageId,
    snapshot: snapshot(revision, `2026-08-30T00:00:${String(revision).padStart(2, "0")}.000Z`),
    outcome: { status: "ok", result },
  };
}

export function eventFor(
  revision: number,
  observation: Observation,
  suffix = String(revision),
): EventEnvelope {
  const occurredAt = new Date(Date.parse("2026-08-30T00:01:00.000Z") + revision * 1_000).toISOString();
  return {
    protocol: "kokoro/1",
    kind: "event",
    messageId: `event-${suffix}`,
    correlationId: `correlation-${suffix}`,
    causationId: null,
    snapshot: snapshot(revision, occurredAt),
    record: {
      observationId: `observation-${suffix}`,
      cursor: `cursor-${suffix}`,
      personaId: "persona-1",
      runId: "run-1",
      eventId: "event-1",
      occurredAt,
      correlationId: `correlation-${suffix}`,
      observation,
    },
  };
}

export class MemoryTransportHost {
  readonly received: ClientEnvelope[] = [];
  readonly handlers: ByteTransportHandlers[] = [];
  readonly #clientDecoders: LengthPrefixedFrameDecoder[] = [];
  closed = 0;

  readonly factory: ByteTransportFactory = (handlers) => {
    const generation = this.handlers.length;
    this.handlers.push(handlers);
    this.#clientDecoders.push(new LengthPrefixedFrameDecoder());
    const transport: ByteTransport = {
      send: async (chunk) => {
        const decoder = this.#clientDecoders[generation];
        if (!decoder) throw new Error(`missing client decoder for generation ${generation}`);
        for (const payload of decoder.push(Uint8Array.from(chunk))) {
          this.received.push(decodeClientPayload(payload));
        }
      },
      close: () => {
        this.closed += 1;
      },
    };
    return transport;
  };

  deliver(
    envelope: Parameters<typeof encodeServerEnvelope>[0],
    options: { generation?: number; fragment?: number } = {},
  ): void {
    const generation = options.generation ?? this.handlers.length - 1;
    const handler = this.handlers[generation];
    if (!handler) throw new Error(`missing transport generation ${generation}`);
    const frame = encodeServerEnvelope(envelope);
    const fragment = options.fragment ?? frame.byteLength;
    for (let offset = 0; offset < frame.byteLength; offset += fragment) {
      handler.onData(frame.subarray(offset, Math.min(frame.byteLength, offset + fragment)));
    }
  }

  remoteClose(generation = this.handlers.length - 1): void {
    const handler = this.handlers[generation];
    if (!handler) throw new Error(`missing transport generation ${generation}`);
    handler.onClose();
  }

  remoteError(error: Error, generation = this.handlers.length - 1): void {
    const handler = this.handlers[generation];
    if (!handler) throw new Error(`missing transport generation ${generation}`);
    handler.onError(error);
  }

  async waitForReceived(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.received.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`expected ${count} client envelopes, received ${this.received.length}`);
  }
}

export async function finishHandshake(
  clientConnect: Promise<AuthoritySnapshot>,
  host: MemoryTransportHost,
  options: { revision?: number; fragment?: number } = {},
): Promise<AuthoritySnapshot> {
  await host.waitForReceived(1);
  const hello = host.received[0];
  if (hello?.kind !== "hello") throw new Error("first client message was not hello");
  host.deliver(
    helloFor(hello, options.revision),
    options.fragment === undefined ? {} : { fragment: options.fragment },
  );
  return clientConnect;
}
