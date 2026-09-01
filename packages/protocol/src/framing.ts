import type { JsonValue } from "./types.js";
import { jsonValueAt, ProtocolValidationError } from "./validation.js";

export const FRAME_PREFIX_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

type DecoderState = "open" | "ended" | "failed";

export class ProtocolFrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolFrameError";
  }
}

function checkedLimit(value: number | undefined): number {
  const limit = value ?? MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FRAME_BYTES) {
    throw new RangeError(`maxFrameBytes must be an integer from 1 through ${MAX_FRAME_BYTES}`);
  }
  return limit;
}

/** Encodes one payload as uint32-big-endian length followed by bytes. */
export function encodePayloadFrame(payload: Uint8Array, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  if (!(payload instanceof Uint8Array)) throw new TypeError("payload must be a Uint8Array");
  const limit = checkedLimit(maxFrameBytes);
  if (payload.byteLength === 0)
    throw new ProtocolFrameError("zero-length frames are not valid Kokoro messages");
  if (payload.byteLength > limit) {
    throw new ProtocolFrameError(`frame payload is ${payload.byteLength} bytes; limit is ${limit}`);
  }
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, FRAME_PREFIX_BYTES);
  view.setUint32(0, payload.byteLength, false);
  frame.set(payload, FRAME_PREFIX_BYTES);
  return frame;
}

/**
 * Incrementally splits arbitrary transport chunks. A decoder becomes unusable after
 * a framing violation or a truncated end-of-stream, preventing accidental resync.
 */
export class LengthPrefixedFrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #header = new Uint8Array(FRAME_PREFIX_BYTES);
  #headerLength = 0;
  #payload: Uint8Array | null = null;
  #payloadLength = 0;
  #state: DecoderState = "open";

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = checkedLimit(options.maxFrameBytes);
  }

  get state(): DecoderState {
    return this.#state;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("chunk must be a Uint8Array");
    if (this.#state !== "open") throw new ProtocolFrameError(`decoder is ${this.#state}`);
    const payloads: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#payload === null) {
        const headerBytes = Math.min(FRAME_PREFIX_BYTES - this.#headerLength, chunk.byteLength - offset);
        this.#header.set(chunk.subarray(offset, offset + headerBytes), this.#headerLength);
        this.#headerLength += headerBytes;
        offset += headerBytes;
        if (this.#headerLength !== FRAME_PREFIX_BYTES) continue;
        const length = new DataView(
          this.#header.buffer,
          this.#header.byteOffset,
          FRAME_PREFIX_BYTES,
        ).getUint32(0, false);
        this.#headerLength = 0;
        if (length === 0) this.#fail("zero-length frames are not valid Kokoro messages");
        if (length > this.#maxFrameBytes) {
          this.#fail(`declared frame length ${length} exceeds limit ${this.#maxFrameBytes}`);
        }
        this.#payload = new Uint8Array(length);
        this.#payloadLength = 0;
      }

      const payload = this.#payload;
      if (payload === null) continue;
      const payloadBytes = Math.min(payload.byteLength - this.#payloadLength, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + payloadBytes), this.#payloadLength);
      this.#payloadLength += payloadBytes;
      offset += payloadBytes;
      if (this.#payloadLength === payload.byteLength) {
        payloads.push(payload);
        this.#payload = null;
        this.#payloadLength = 0;
      }
    }
    return payloads;
  }

  end(): void {
    if (this.#state !== "open") throw new ProtocolFrameError(`decoder is ${this.#state}`);
    if (this.#headerLength !== 0 || this.#payload !== null)
      this.#fail("transport ended with a truncated frame");
    this.#state = "ended";
  }

  #fail(message: string): never {
    this.#state = "failed";
    this.#headerLength = 0;
    this.#payload = null;
    this.#payloadLength = 0;
    throw new ProtocolFrameError(message);
  }
}

export function encodeJsonFrame(value: JsonValue, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  const normalized = jsonValueAt(value, "$frame");
  const json = JSON.stringify(normalized);
  return encodePayloadFrame(new TextEncoder().encode(json), maxFrameBytes);
}

export function decodeJsonPayload(payload: Uint8Array): JsonValue {
  if (!(payload instanceof Uint8Array)) throw new TypeError("payload must be a Uint8Array");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
  } catch (error) {
    throw new ProtocolFrameError("frame payload is not valid UTF-8", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProtocolFrameError("frame payload is not valid JSON", { cause: error });
  }
  try {
    return jsonValueAt(parsed, "$frame");
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new ProtocolFrameError(`frame JSON is outside the supported value domain: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export class JsonFrameDecoder {
  readonly #frames: LengthPrefixedFrameDecoder;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.#frames = new LengthPrefixedFrameDecoder(options);
  }

  get state(): DecoderState {
    return this.#frames.state;
  }

  push(chunk: Uint8Array): JsonValue[] {
    return this.#frames.push(chunk).map(decodeJsonPayload);
  }

  end(): void {
    this.#frames.end();
  }
}
