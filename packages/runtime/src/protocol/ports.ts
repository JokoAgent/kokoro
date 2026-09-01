/**
 * An authenticated, ordered byte stream.
 *
 * Authentication and authorization of the peer belong to the transport host.
 * Data callbacks and `send` calls preserve byte order; ProtocolServer still
 * serializes complete frames so transports never have to understand framing.
 */
export interface ByteConnection {
  readonly peerIdentity: string;
  send(frame: Uint8Array): Promise<void>;
  close(reason?: string): Promise<void> | void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (reason?: unknown) => void): () => void;
}

/** A host-provided listener which yields only authenticated connections. */
export interface ByteListener {
  listen(accept: (connection: ByteConnection) => Promise<void> | void): Promise<() => Promise<void> | void>;
}
