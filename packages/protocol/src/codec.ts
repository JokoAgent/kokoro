import { decodeJsonPayload, encodeJsonFrame, MAX_FRAME_BYTES } from "./framing.js";
import {
  parseAuthoritySnapshot,
  parseCapabilitySnapshot,
  parseCommand,
  parseCommandResult,
  parseObservationRecord,
  parsePublicError,
} from "./parsers.js";
import type {
  ClientEnvelope,
  ClientHelloEnvelope,
  EventEnvelope,
  RequestEnvelope,
  ResponseEnvelope,
  ServerEnvelope,
  ServerHelloEnvelope,
} from "./types.js";
import { enumAt, fail, idAt, integerAt, literalAt, nullableAt, objectAt, stringAt } from "./validation.js";

export function parseClientEnvelope(value: unknown): ClientEnvelope {
  const envelope = objectAt(
    value,
    "$",
    ["protocol", "kind", "messageId", "correlationId"],
    ["client", "maxFrameBytes", "expectedRevision", "command"],
  );
  literalAt(envelope.protocol, "$.protocol", "kokoro/1");
  const kind = enumAt(envelope.kind, "$.kind", ["hello", "request"] as const);
  return kind === "hello" ? parseClientHello(value) : parseRequest(value);
}

function parseClientHello(value: unknown): ClientHelloEnvelope {
  const envelope = objectAt(value, "$", [
    "protocol",
    "kind",
    "messageId",
    "correlationId",
    "client",
    "maxFrameBytes",
  ]);
  const client = objectAt(envelope.client, "$.client", ["name", "version"]);
  return {
    protocol: literalAt(envelope.protocol, "$.protocol", "kokoro/1"),
    kind: literalAt(envelope.kind, "$.kind", "hello"),
    messageId: idAt(envelope.messageId, "$.messageId"),
    correlationId: idAt(envelope.correlationId, "$.correlationId"),
    client: {
      name: stringAt(client.name, "$.client.name", { nonEmpty: true, maxLength: 128 }),
      version: stringAt(client.version, "$.client.version", { nonEmpty: true, maxLength: 128 }),
    },
    maxFrameBytes: integerAt(envelope.maxFrameBytes, "$.maxFrameBytes", { min: 1, max: MAX_FRAME_BYTES }),
  };
}

function parseRequest(value: unknown): RequestEnvelope {
  const envelope = objectAt(value, "$", [
    "protocol",
    "kind",
    "messageId",
    "correlationId",
    "expectedRevision",
    "command",
  ]);
  return {
    protocol: literalAt(envelope.protocol, "$.protocol", "kokoro/1"),
    kind: literalAt(envelope.kind, "$.kind", "request"),
    messageId: idAt(envelope.messageId, "$.messageId"),
    correlationId: idAt(envelope.correlationId, "$.correlationId"),
    expectedRevision: nullableAt(envelope.expectedRevision, "$.expectedRevision", (entry, path) =>
      integerAt(entry, path, { min: 0 }),
    ),
    command: parseCommand(envelope.command, "$.command"),
  };
}

export function parseServerEnvelope(value: unknown): ServerEnvelope {
  const envelope = objectAt(
    value,
    "$",
    ["protocol", "kind", "messageId", "correlationId"],
    ["replyTo", "snapshot", "outcome", "causationId", "record"],
  );
  literalAt(envelope.protocol, "$.protocol", "kokoro/1");
  const kind = enumAt(envelope.kind, "$.kind", ["hello", "response", "event"] as const);
  switch (kind) {
    case "hello":
      return parseServerHello(value);
    case "response":
      return parseResponse(value);
    case "event":
      return parseEvent(value);
  }
}

function parseServerHello(value: unknown): ServerHelloEnvelope {
  const envelope = objectAt(value, "$", [
    "protocol",
    "kind",
    "messageId",
    "correlationId",
    "replyTo",
    "snapshot",
    "outcome",
  ]);
  const outcomeDiscriminator = objectAt(
    envelope.outcome,
    "$.outcome",
    ["status"],
    ["server", "capabilities", "error"],
  );
  const status = enumAt(outcomeDiscriminator.status, "$.outcome.status", ["ok", "error"] as const);
  const snapshot = nullableAt(envelope.snapshot, "$.snapshot", parseAuthoritySnapshot);
  let outcome: ServerHelloEnvelope["outcome"];
  if (status === "ok") {
    if (snapshot === null) fail("$.snapshot", "a successful hello requires an authority snapshot");
    const success = objectAt(envelope.outcome, "$.outcome", ["status", "server", "capabilities"]);
    const server = objectAt(success.server, "$.outcome.server", ["name", "version"]);
    outcome = {
      status,
      server: {
        name: stringAt(server.name, "$.outcome.server.name", { nonEmpty: true, maxLength: 128 }),
        version: stringAt(server.version, "$.outcome.server.version", { nonEmpty: true, maxLength: 128 }),
      },
      capabilities: parseCapabilitySnapshot(success.capabilities, "$.outcome.capabilities"),
    };
  } else {
    if (snapshot !== null) fail("$.snapshot", "a rejected hello must not include an authority snapshot");
    const failure = objectAt(envelope.outcome, "$.outcome", ["status", "error"]);
    outcome = { status, error: parsePublicError(failure.error, "$.outcome.error") };
  }
  return {
    protocol: literalAt(envelope.protocol, "$.protocol", "kokoro/1"),
    kind: literalAt(envelope.kind, "$.kind", "hello"),
    messageId: idAt(envelope.messageId, "$.messageId"),
    correlationId: idAt(envelope.correlationId, "$.correlationId"),
    replyTo: idAt(envelope.replyTo, "$.replyTo"),
    snapshot,
    outcome,
  };
}

function parseResponse(value: unknown): ResponseEnvelope {
  const envelope = objectAt(value, "$", [
    "protocol",
    "kind",
    "messageId",
    "correlationId",
    "replyTo",
    "snapshot",
    "outcome",
  ]);
  const outcomeDiscriminator = objectAt(envelope.outcome, "$.outcome", ["status"], ["result", "error"]);
  const status = enumAt(outcomeDiscriminator.status, "$.outcome.status", ["ok", "error"] as const);
  const outcome: ResponseEnvelope["outcome"] =
    status === "ok"
      ? (() => {
          const success = objectAt(envelope.outcome, "$.outcome", ["status", "result"]);
          return { status, result: parseCommandResult(success.result, "$.outcome.result") };
        })()
      : (() => {
          const failure = objectAt(envelope.outcome, "$.outcome", ["status", "error"]);
          return { status, error: parsePublicError(failure.error, "$.outcome.error") };
        })();
  return {
    protocol: literalAt(envelope.protocol, "$.protocol", "kokoro/1"),
    kind: literalAt(envelope.kind, "$.kind", "response"),
    messageId: idAt(envelope.messageId, "$.messageId"),
    correlationId: idAt(envelope.correlationId, "$.correlationId"),
    replyTo: idAt(envelope.replyTo, "$.replyTo"),
    snapshot: parseAuthoritySnapshot(envelope.snapshot, "$.snapshot"),
    outcome,
  };
}

function parseEvent(value: unknown): EventEnvelope {
  const envelope = objectAt(value, "$", [
    "protocol",
    "kind",
    "messageId",
    "correlationId",
    "causationId",
    "snapshot",
    "record",
  ]);
  const correlationId = idAt(envelope.correlationId, "$.correlationId");
  const record = parseObservationRecord(envelope.record, "$.record");
  if (record.correlationId !== correlationId) {
    fail("$.record.correlationId", "must equal the enclosing event correlationId");
  }
  return {
    protocol: literalAt(envelope.protocol, "$.protocol", "kokoro/1"),
    kind: literalAt(envelope.kind, "$.kind", "event"),
    messageId: idAt(envelope.messageId, "$.messageId"),
    correlationId,
    causationId: nullableAt(envelope.causationId, "$.causationId", idAt),
    snapshot: parseAuthoritySnapshot(envelope.snapshot, "$.snapshot"),
    record,
  };
}

export function encodeClientEnvelope(envelope: ClientEnvelope, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  return encodeJsonFrame(parseClientEnvelope(envelope) as never, maxFrameBytes);
}

export function encodeServerEnvelope(envelope: ServerEnvelope, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  return encodeJsonFrame(parseServerEnvelope(envelope) as never, maxFrameBytes);
}

export function decodeClientPayload(payload: Uint8Array): ClientEnvelope {
  return parseClientEnvelope(decodeJsonPayload(payload));
}

export function decodeServerPayload(payload: Uint8Array): ServerEnvelope {
  return parseServerEnvelope(decodeJsonPayload(payload));
}

/** A convenience invariant for request-correlated clients and servers. */
export function resultMatchesCommand(response: CommandResultLike, commandType: string): boolean {
  return response.type === commandType;
}

type CommandResultLike = { readonly type: string };
