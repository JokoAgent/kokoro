import type { AuthoritySnapshot, PublicError } from "@kokoro/protocol";

export class KokoroClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KokoroClientError";
  }
}

export class KokoroDisconnectedError extends KokoroClientError {
  constructor(message = "Kokoro client is disconnected", options?: ErrorOptions) {
    super(message, options);
    this.name = "KokoroDisconnectedError";
  }
}

export class KokoroDisposedError extends KokoroClientError {
  constructor() {
    super("Kokoro client has been disposed");
    this.name = "KokoroDisposedError";
  }
}

export class KokoroProtocolError extends KokoroClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KokoroProtocolError";
  }
}

export class KokoroServerError extends KokoroClientError {
  readonly error: PublicError;
  readonly snapshot: AuthoritySnapshot | null;

  constructor(error: PublicError, snapshot: AuthoritySnapshot | null) {
    super(error.message);
    this.name = "KokoroServerError";
    this.error = error;
    this.snapshot = snapshot;
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
