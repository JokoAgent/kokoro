import type { Revision } from "@kokoro/protocol";
import type { ByteTransportFactory } from "./transport.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "disposed";

export interface ConnectionStateChange {
  readonly previous: ConnectionState;
  readonly current: ConnectionState;
  readonly error: Error | null;
}

export interface KokoroClientOptions {
  readonly transportFactory: ByteTransportFactory;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly maxFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly createId?: () => string;
  readonly onListenerError?: (error: Error) => void;
}

export interface RequestOptions {
  /** Mutation helpers default to the latest snapshot; generic and read helpers use null. */
  readonly expectedRevision?: Revision | null;
  readonly timeoutMs?: number;
}
