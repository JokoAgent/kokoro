import { createServer } from "node:net";
import {
  decodeClientPayload,
  encodeServerEnvelope,
  LengthPrefixedFrameDecoder,
  type RequestEnvelope,
} from "@kokoro/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { connectNodeSocket } from "../src/node.js";
import { helloFor, NOW, responseFor } from "./support.js";

describe("Node socket subpath", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("keeps Node imports in the explicit subpath and exchanges framed protocol bytes over TCP", async () => {
    const commands: string[] = [];
    const server = createServer((socket) => {
      const decoder = new LengthPrefixedFrameDecoder();
      socket.on("data", (chunk) => {
        for (const payload of decoder.push(chunk)) {
          const envelope = decodeClientPayload(payload);
          if (envelope.kind === "hello") {
            const frame = encodeServerEnvelope(helloFor(envelope));
            socket.write(frame.subarray(0, 2));
            socket.write(frame.subarray(2));
            continue;
          }
          commands.push(envelope.command.type);
          const request = envelope as RequestEnvelope;
          const result =
            envelope.command.type === "pause"
              ? ({ type: "pause", operationId: "pause-operation", acceptedAt: NOW } as const)
              : ({ type: "resume", operationId: "resume-operation", acceptedAt: NOW } as const);
          socket.write(encodeServerEnvelope(responseFor(request, result, 1 + commands.length)));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP server address");

    let sequence = 0;
    const client = await connectNodeSocket({
      clientName: "node-test",
      clientVersion: "1.0.0",
      createId: () => `node-client-${++sequence}`,
      socket: { host: "127.0.0.1", port: address.port },
    });
    cleanups.push(() => client.dispose());

    await Promise.all([client.pause("persona-1"), client.resume("persona-1")]);
    expect(commands).toEqual(["pause", "resume"]);
    expect(client.snapshot?.revision).toBe(3);
  });
});
