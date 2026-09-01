import { createConnection, type Socket } from "node:net";
import { KokoroClient } from "./client.js";
import { KokoroDisconnectedError } from "./errors.js";
import type { ByteTransport, ByteTransportFactory } from "./transport.js";
import type { KokoroClientOptions } from "./types.js";

export type NodeSocketAddress =
  | { readonly path: string; readonly host?: never; readonly port?: never }
  | { readonly path?: never; readonly host?: string; readonly port: number };

export type NodeSocketTransportOptions = NodeSocketAddress & {
  readonly connectTimeoutMs?: number;
  readonly maxPendingBytes?: number;
};

export type NodeKokoroClientOptions = Omit<KokoroClientOptions, "transportFactory"> & {
  readonly socket: NodeSocketTransportOptions;
};

export function createNodeSocketTransport(options: NodeSocketTransportOptions): ByteTransportFactory {
  const connectTimeoutMs = checkedPositiveInteger(options.connectTimeoutMs ?? 10_000, "connectTimeoutMs");
  const maxPendingBytes = checkedPositiveInteger(
    options.maxPendingBytes ?? 32 * 1024 * 1024,
    "maxPendingBytes",
  );
  return (handlers) =>
    new Promise<ByteTransport>((resolve, reject) => {
      let connected = false;
      let terminal = false;
      const socket =
        "path" in options && options.path !== undefined
          ? createConnection({ path: options.path })
          : createConnection({ host: options.host ?? "127.0.0.1", port: options.port });
      const timer = setTimeout(() => {
        const error = new KokoroDisconnectedError("Node socket connection timed out");
        socket.destroy(error);
      }, connectTimeoutMs);

      socket.on("data", (chunk) => {
        if (connected && !terminal) handlers.onData(Uint8Array.from(chunk));
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        connected = true;
        resolve(new NodeSocketTransport(socket, maxPendingBytes));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        if (terminal) return;
        terminal = true;
        if (connected) handlers.onError(error);
        else reject(error);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        if (terminal) return;
        terminal = true;
        if (connected) handlers.onClose();
        else reject(new KokoroDisconnectedError("Node socket closed before connecting"));
      });
    });
}

export function connectNodeSocket(options: NodeKokoroClientOptions): Promise<KokoroClient> {
  const { socket, ...client } = options;
  return KokoroClient.connect({ ...client, transportFactory: createNodeSocketTransport(socket) });
}

class NodeSocketTransport implements ByteTransport {
  readonly #socket: Socket;
  readonly #maxPendingBytes: number;
  #tail: Promise<void> = Promise.resolve();
  #pendingBytes = 0;
  #closed = false;

  constructor(socket: Socket, maxPendingBytes: number) {
    this.#socket = socket;
    this.#maxPendingBytes = maxPendingBytes;
  }

  send(chunk: Uint8Array): Promise<void> {
    if (!(chunk instanceof Uint8Array)) return Promise.reject(new TypeError("chunk must be a Uint8Array"));
    if (this.#closed || this.#socket.destroyed) return Promise.reject(new KokoroDisconnectedError());
    if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
      return Promise.reject(new KokoroDisconnectedError("Node socket pending-byte limit exceeded"));
    }
    const retained = Uint8Array.from(chunk);
    this.#pendingBytes += retained.byteLength;
    const write = this.#tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.#closed || this.#socket.destroyed) {
            reject(new KokoroDisconnectedError());
            return;
          }
          this.#socket.write(retained, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.#tail = write.catch(() => {});
    return write.finally(() => {
      this.#pendingBytes -= retained.byteLength;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.end();
  }
}

function checkedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from 1 through 2147483647`);
  }
  return value;
}
