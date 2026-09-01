import { describe, expect, it } from "vitest";
import {
  decodeJsonPayload,
  encodeJsonFrame,
  encodePayloadFrame,
  JsonFrameDecoder,
  LengthPrefixedFrameDecoder,
  MAX_FRAME_BYTES,
  ProtocolFrameError,
} from "../src/index.js";

describe("length-prefixed JSON framing", () => {
  it("decodes one-byte fragmentation and multiple coalesced frames", () => {
    const first = encodeJsonFrame({ type: "first", text: "你好" });
    const second = encodeJsonFrame(["second", 2, true, null]);
    const all = concatenate([first, second]);
    const decoder = new JsonFrameDecoder();
    const values: unknown[] = [];
    for (const byte of all) values.push(...decoder.push(Uint8Array.of(byte)));
    decoder.end();
    expect(values).toEqual([{ type: "first", text: "你好" }, ["second", 2, true, null]]);
  });

  it("accepts exactly 16 MiB and rejects one byte more", () => {
    expect(encodePayloadFrame(new Uint8Array(MAX_FRAME_BYTES))).toHaveLength(MAX_FRAME_BYTES + 4);
    expect(() => encodePayloadFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(ProtocolFrameError);
  });

  it("rejects zero and oversized declared lengths before payload allocation", () => {
    const zero = Uint8Array.of(0, 0, 0, 0);
    const oversized = Uint8Array.of(1, 0, 0, 1);
    expect(() => new LengthPrefixedFrameDecoder().push(zero)).toThrow(/zero-length/);
    const decoder = new LengthPrefixedFrameDecoder();
    expect(() => decoder.push(oversized)).toThrow(/exceeds limit/);
    expect(decoder.state).toBe("failed");
    expect(() => decoder.push(Uint8Array.of(1))).toThrow(/decoder is failed/);
  });

  it("detects truncated headers and payloads at end-of-stream", () => {
    const header = new LengthPrefixedFrameDecoder();
    header.push(Uint8Array.of(0, 0));
    expect(() => header.end()).toThrow(/truncated/);

    const payload = new LengthPrefixedFrameDecoder();
    payload.push(Uint8Array.of(0, 0, 0, 3, 1));
    expect(() => payload.end()).toThrow(/truncated/);
  });

  it("rejects malformed UTF-8 and malformed JSON", () => {
    expect(() => decodeJsonPayload(Uint8Array.of(0xc3, 0x28))).toThrow(/UTF-8/);
    expect(() => decodeJsonPayload(new TextEncoder().encode("{broken"))).toThrow(/valid JSON/);
  });

  it("rejects unsafe JSON values, excessive depth, and lone surrogates", () => {
    expect(() => encodeJsonFrame({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe range/);
    expect(() => encodeJsonFrame({ value: "\ud800" })).toThrow(/surrogate/);
    let deep: unknown = null;
    for (let index = 0; index < 66; index += 1) deep = [deep];
    expect(() => encodeJsonFrame(deep as never)).toThrow(/nesting/);
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
