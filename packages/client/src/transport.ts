/** A connected ordered byte sink. Incoming bytes are delivered through the factory handlers. */
export interface ByteTransport {
  /** Calls must be delivered in invocation order. Implementations must copy or retain the bytes safely. */
  send(chunk: Uint8Array): Promise<void>;
  /** Repeated close calls must be harmless. Closing a client never stops a Kokoro Persona. */
  close(): void;
}

export interface ByteTransportHandlers {
  /** Delivers an arbitrary fragment or coalescing of protocol frames. */
  onData(chunk: Uint8Array): void;
  /** Reports one orderly terminal close. */
  onClose(): void;
  /** Reports one terminal transport error. */
  onError(error: Error): void;
}

/** Creates a fresh connected and authenticated transport for one client connection generation. */
export type ByteTransportFactory = (
  handlers: ByteTransportHandlers,
) => ByteTransport | Promise<ByteTransport>;
