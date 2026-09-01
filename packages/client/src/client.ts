import {
  type AuthoritySnapshot,
  type BranchCommand,
  type CallbackCommand,
  type CapabilitiesCommand,
  type CapabilitySnapshot,
  type CloneCommand,
  type Command,
  type CommandResult,
  type CreateCommand,
  type DeleteCommand,
  decodeServerPayload,
  type EventEnvelope,
  encodeClientEnvelope,
  type ForceCommand,
  type HistoryCommand,
  type InitCommand,
  LengthPrefixedFrameDecoder,
  type LocalesCommand,
  MAX_FRAME_BYTES,
  type ObservationRecord,
  type ObservationsCommand,
  type OwnerDocumentsCommand,
  type PauseCommand,
  type PutOwnerDocumentCommand,
  type RequestEnvelope,
  type ResponseEnvelope,
  type RestoreCommand,
  type ResultForCommand,
  type ResumeCommand,
  type RetryCommand,
  resultMatchesCommand,
  type ServerEnvelope,
  type ServerHelloEnvelope,
  type SetLocalesCommand,
  type SnapshotCommand,
  type StartCommand,
  type StimulusCommand,
  type StopCommand,
} from "@kokoro/protocol";
import {
  KokoroDisconnectedError,
  KokoroDisposedError,
  KokoroProtocolError,
  KokoroServerError,
  toError,
} from "./errors.js";
import { AuthorityState, type Unsubscribe } from "./state.js";
import type { ByteTransport } from "./transport.js";
import type { ConnectionState, ConnectionStateChange, KokoroClientOptions, RequestOptions } from "./types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface PendingHandshake extends Deferred<AuthoritySnapshot> {
  readonly generation: number;
  readonly messageId: string;
  readonly correlationId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingRequest extends Deferred<CommandResult> {
  readonly generation: number;
  readonly command: Command;
  readonly correlationId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class KokoroClient {
  readonly #options: KokoroClientOptions;
  readonly #authority: AuthorityState;
  readonly #observationListeners = new Set<(record: ObservationRecord, event: EventEnvelope) => void>();
  readonly #eventListeners = new Set<(event: EventEnvelope) => void>();
  readonly #connectionListeners = new Set<(change: ConnectionStateChange) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #createId: () => string;
  #connectionState: ConnectionState = "disconnected";
  #generation = 0;
  #transport: ByteTransport | undefined;
  #decoder: LengthPrefixedFrameDecoder | undefined;
  #handshake: PendingHandshake | undefined;
  #connectPromise: Promise<AuthoritySnapshot> | undefined;
  #capabilities: CapabilitySnapshot | undefined;
  #outboundMaxFrameBytes: number;
  #disposed = false;

  constructor(options: KokoroClientOptions) {
    const maxFrameBytes = checkedFrameBytes(options.maxFrameBytes ?? MAX_FRAME_BYTES);
    checkedTimeout(options.handshakeTimeoutMs, 10_000, "handshakeTimeoutMs");
    checkedTimeout(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    this.#options = options;
    this.#authority = new AuthorityState(options.onListenerError);
    this.#createId = options.createId ?? createDefaultIdFactory();
    this.#outboundMaxFrameBytes = maxFrameBytes;
  }

  static async connect(options: KokoroClientOptions): Promise<KokoroClient> {
    const client = new KokoroClient(options);
    try {
      await client.connect();
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  get connectionState(): ConnectionState {
    return this.#connectionState;
  }

  get connected(): boolean {
    return this.#connectionState === "connected";
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get snapshot(): AuthoritySnapshot | undefined {
    return this.#authority.snapshot;
  }

  get capabilities(): CapabilitySnapshot | undefined {
    return this.#capabilities;
  }

  connect(): Promise<AuthoritySnapshot> {
    if (this.#disposed) return Promise.reject(new KokoroDisposedError());
    if (this.#connectionState === "connected") {
      const snapshot = this.#authority.snapshot;
      return snapshot
        ? Promise.resolve(snapshot)
        : Promise.reject(new KokoroProtocolError("connected client has no authority snapshot"));
    }
    if (this.#connectPromise) return this.#connectPromise;

    const generation = ++this.#generation;
    this.#authority.reset();
    this.#capabilities = undefined;
    this.#outboundMaxFrameBytes = checkedFrameBytes(this.#options.maxFrameBytes ?? MAX_FRAME_BYTES);
    this.#setConnectionState("connecting", null);
    const decoder = new LengthPrefixedFrameDecoder({
      maxFrameBytes: this.#options.maxFrameBytes ?? MAX_FRAME_BYTES,
    });
    this.#decoder = decoder;
    const messageId = this.#createId();
    const correlationId = this.#createId();
    const deferred = createDeferred<AuthoritySnapshot>();
    const timer = setTimeout(
      () => this.#failConnection(generation, new KokoroDisconnectedError("Kokoro handshake timed out")),
      checkedTimeout(this.#options.handshakeTimeoutMs, 10_000, "handshakeTimeoutMs"),
    );
    this.#handshake = { ...deferred, generation, messageId, correlationId, timer };

    const promise = (async () => {
      try {
        const transport = await this.#options.transportFactory({
          onData: (chunk) => this.#onData(generation, chunk),
          onClose: () => this.#onTransportClose(generation),
          onError: (error) => this.#failConnection(generation, error),
        });
        if (generation !== this.#generation || this.#connectionState !== "connecting") {
          transport.close();
          return await deferred.promise;
        }
        this.#transport = transport;
        await transport.send(
          encodeClientEnvelope(
            {
              protocol: "kokoro/1",
              kind: "hello",
              messageId,
              correlationId,
              client: { name: this.#options.clientName, version: this.#options.clientVersion },
              maxFrameBytes: this.#options.maxFrameBytes ?? MAX_FRAME_BYTES,
            },
            this.#options.maxFrameBytes,
          ),
        );
        return await deferred.promise;
      } catch (error) {
        this.#failConnection(generation, toError(error));
        return await deferred.promise;
      }
    })();
    this.#connectPromise = promise;
    const clearConnectPromise = () => {
      if (this.#connectPromise === promise) this.#connectPromise = undefined;
    };
    void promise.then(clearConnectPromise, clearConnectPromise);
    return promise;
  }

  disconnect(reason = "Client disconnected"): void {
    if (this.#disposed || this.#connectionState === "disconnected") return;
    this.#failConnection(this.#generation, new KokoroDisconnectedError(reason));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const previous = this.#connectionState;
    this.#generation += 1;
    this.#transport?.close();
    this.#transport = undefined;
    this.#decoder = undefined;
    this.#rejectHandshake(new KokoroDisposedError());
    this.#rejectPending(new KokoroDisposedError());
    this.#connectionState = "disposed";
    this.#notifyConnection({ previous, current: "disposed", error: null });
    this.#authority.dispose();
    this.#observationListeners.clear();
    this.#eventListeners.clear();
    this.#connectionListeners.clear();
  }

  subscribeSnapshot(listener: (snapshot: AuthoritySnapshot) => void): Unsubscribe {
    this.#assertNotDisposed();
    return this.#authority.subscribe(listener);
  }

  subscribeObservations(listener: (record: ObservationRecord, event: EventEnvelope) => void): Unsubscribe {
    this.#assertNotDisposed();
    this.#observationListeners.add(listener);
    return () => this.#observationListeners.delete(listener);
  }

  subscribeEvents(listener: (event: EventEnvelope) => void): Unsubscribe {
    this.#assertNotDisposed();
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  subscribeConnection(listener: (change: ConnectionStateChange) => void): Unsubscribe {
    this.#assertNotDisposed();
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  request<const TCommand extends Command>(
    command: TCommand,
    options: RequestOptions = {},
  ): Promise<ResultForCommand<TCommand>> {
    try {
      this.#assertConnected();
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = this.#generation;
    const messageId = this.#createId();
    const correlationId = this.#createId();
    const expectedRevision = options.expectedRevision === undefined ? null : options.expectedRevision;
    const envelope: RequestEnvelope<TCommand> = {
      protocol: "kokoro/1",
      kind: "request",
      messageId,
      correlationId,
      expectedRevision,
      command,
    };
    let timeoutMs: number;
    try {
      timeoutMs = checkedTimeout(options.timeoutMs, this.#options.requestTimeoutMs ?? 30_000, "timeoutMs");
    } catch (error) {
      return Promise.reject(error);
    }
    const deferred = createDeferred<CommandResult>();
    const timer = setTimeout(
      () => this.#failConnection(generation, new KokoroDisconnectedError(`request ${messageId} timed out`)),
      timeoutMs,
    );
    this.#pending.set(messageId, { ...deferred, generation, command, correlationId, timer });
    let frame: Uint8Array;
    try {
      frame = encodeClientEnvelope(envelope, this.#outboundMaxFrameBytes);
    } catch (error) {
      this.#takePending(messageId)?.reject(toError(error));
      return deferred.promise as Promise<ResultForCommand<TCommand>>;
    }
    const transport = this.#transport;
    if (!transport) {
      const error = new KokoroDisconnectedError();
      this.#takePending(messageId)?.reject(error);
      this.#failConnection(generation, error);
      return deferred.promise as Promise<ResultForCommand<TCommand>>;
    }
    void transport.send(frame).catch((error: unknown) => this.#failConnection(generation, toError(error)));
    return deferred.promise as Promise<ResultForCommand<TCommand>>;
  }

  createDraft(
    input: Omit<CreateCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<CreateCommand>> {
    return this.request({ type: "create", ...input }, this.#cas(options));
  }

  init(input: Omit<InitCommand, "type">, options?: RequestOptions): Promise<ResultForCommand<InitCommand>> {
    return this.request({ type: "init", ...input }, this.#cas(options));
  }

  start(
    input: Omit<StartCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<StartCommand>> {
    return this.request({ type: "start", ...input }, this.#cas(options));
  }

  pause(personaId: string, options?: RequestOptions): Promise<ResultForCommand<PauseCommand>> {
    return this.request({ type: "pause", personaId }, this.#cas(options));
  }

  resume(personaId: string, options?: RequestOptions): Promise<ResultForCommand<ResumeCommand>> {
    return this.request({ type: "resume", personaId }, this.#cas(options));
  }

  stop(personaId: string, options?: RequestOptions): Promise<ResultForCommand<StopCommand>> {
    return this.request({ type: "stop", personaId }, this.#cas(options));
  }

  force(personaId: string, options?: RequestOptions): Promise<ResultForCommand<ForceCommand>> {
    return this.request({ type: "force", personaId }, this.#cas(options));
  }

  submitStimulus(
    input: Omit<StimulusCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<StimulusCommand>> {
    return this.request({ type: "stimulus", ...input }, options ?? { expectedRevision: null });
  }

  submitCallback(
    input: Omit<CallbackCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<CallbackCommand>> {
    return this.request({ type: "callback", ...input }, options ?? { expectedRevision: null });
  }

  ownerDocuments(
    input: Omit<OwnerDocumentsCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<OwnerDocumentsCommand>> {
    return this.request({ type: "owner_documents", ...input }, options ?? { expectedRevision: null });
  }

  putOwnerDocument(
    input: Omit<PutOwnerDocumentCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<PutOwnerDocumentCommand>> {
    return this.request({ type: "put_owner_document", ...input }, this.#cas(options));
  }

  history(
    input: Omit<HistoryCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<HistoryCommand>> {
    return this.request({ type: "history", ...input }, options ?? { expectedRevision: null });
  }

  branch(
    input: Omit<BranchCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<BranchCommand>> {
    return this.request({ type: "branch", ...input }, this.#cas(options));
  }

  clone(
    input: Omit<CloneCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<CloneCommand>> {
    return this.request({ type: "clone", ...input }, this.#cas(options));
  }

  restore(
    input: Omit<RestoreCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<RestoreCommand>> {
    return this.request({ type: "restore", ...input }, this.#cas(options));
  }

  deletePersona(
    input: Omit<DeleteCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<DeleteCommand>> {
    return this.request({ type: "delete", ...input }, this.#cas(options));
  }

  locales(options: RequestOptions = { expectedRevision: null }): Promise<ResultForCommand<LocalesCommand>> {
    return this.request({ type: "locales" }, options);
  }

  setLocales(
    input: Omit<SetLocalesCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<SetLocalesCommand>> {
    return this.request({ type: "set_locales", ...input }, this.#cas(options));
  }

  retry(
    input: Omit<RetryCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<RetryCommand>> {
    return this.request({ type: "retry", ...input }, this.#cas(options));
  }

  queryCapabilities(
    personaId: string | null = null,
    options: RequestOptions = { expectedRevision: null },
  ): Promise<ResultForCommand<CapabilitiesCommand>> {
    return this.request({ type: "capabilities", personaId }, options).then((result) => {
      this.#capabilities = result.capabilities;
      return result;
    });
  }

  observations(
    input: Omit<ObservationsCommand, "type">,
    options?: RequestOptions,
  ): Promise<ResultForCommand<ObservationsCommand>> {
    return this.request({ type: "observations", ...input }, options ?? { expectedRevision: null });
  }

  refreshSnapshot(
    options: RequestOptions = { expectedRevision: null },
  ): Promise<ResultForCommand<SnapshotCommand>> {
    return this.request({ type: "snapshot" }, options);
  }

  #cas(options?: RequestOptions): RequestOptions {
    return options ?? { expectedRevision: this.#authority.snapshot?.revision ?? null };
  }

  #onData(generation: number, chunk: Uint8Array): void {
    if (generation !== this.#generation || this.#disposed) return;
    try {
      if (!(chunk instanceof Uint8Array))
        throw new KokoroProtocolError("transport delivered a non-Uint8Array chunk");
      const decoder = this.#decoder;
      if (!decoder) throw new KokoroProtocolError("connected transport has no frame decoder");
      for (const payload of decoder.push(chunk))
        this.#handleEnvelope(generation, decodeServerPayload(payload));
    } catch (error) {
      this.#failConnection(generation, toError(error));
    }
  }

  #handleEnvelope(generation: number, envelope: ServerEnvelope): void {
    if (generation !== this.#generation) return;
    if (this.#connectionState === "connecting") {
      if (envelope.kind !== "hello")
        throw new KokoroProtocolError("server must answer the handshake before other messages");
      this.#handleHello(envelope);
      return;
    }
    if (this.#connectionState !== "connected")
      throw new KokoroProtocolError("received a message while disconnected");
    if (envelope.kind === "hello")
      throw new KokoroProtocolError("received an unexpected second server hello");
    if (envelope.kind === "response") this.#handleResponse(envelope);
    else this.#handleEvent(envelope);
  }

  #handleHello(envelope: ServerHelloEnvelope): void {
    const pending = this.#handshake;
    if (!pending) throw new KokoroProtocolError("received a hello without a pending handshake");
    if (envelope.replyTo !== pending.messageId || envelope.correlationId !== pending.correlationId) {
      throw new KokoroProtocolError("server hello does not correlate to the client hello");
    }
    clearTimeout(pending.timer);
    this.#handshake = undefined;
    if (envelope.outcome.status === "error") {
      pending.reject(new KokoroServerError(envelope.outcome.error, null));
      this.#failConnection(pending.generation, new KokoroServerError(envelope.outcome.error, null));
      return;
    }
    this.#capabilities = envelope.outcome.capabilities;
    this.#outboundMaxFrameBytes = Math.min(
      this.#options.maxFrameBytes ?? MAX_FRAME_BYTES,
      envelope.outcome.capabilities.maxFrameBytes,
    );
    const snapshot = envelope.snapshot;
    if (!snapshot) throw new KokoroProtocolError("successful server hello omitted its authority snapshot");
    this.#authority.apply(snapshot);
    this.#setConnectionState("connected", null);
    pending.resolve(snapshot);
  }

  #handleResponse(envelope: ResponseEnvelope): void {
    const pending = this.#pending.get(envelope.replyTo);
    if (!pending) throw new KokoroProtocolError(`response ${envelope.messageId} has no pending request`);
    if (pending.generation !== this.#generation || pending.correlationId !== envelope.correlationId) {
      throw new KokoroProtocolError(`response ${envelope.messageId} has the wrong correlation`);
    }
    if (
      envelope.outcome.status === "ok" &&
      !resultMatchesCommand(envelope.outcome.result, pending.command.type)
    ) {
      throw new KokoroProtocolError(
        `response for ${pending.command.type} contains ${envelope.outcome.result.type} result`,
      );
    }
    this.#authority.apply(envelope.snapshot);
    this.#takePending(envelope.replyTo);
    if (envelope.outcome.status === "ok") pending.resolve(envelope.outcome.result);
    else pending.reject(new KokoroServerError(envelope.outcome.error, envelope.snapshot));
  }

  #handleEvent(envelope: EventEnvelope): void {
    this.#authority.apply(envelope.snapshot);
    this.#notify(this.#eventListeners, envelope);
    for (const listener of this.#observationListeners) {
      try {
        listener(envelope.record, envelope);
      } catch (error) {
        this.#reportListenerError(error);
      }
    }
  }

  #onTransportClose(generation: number): void {
    if (generation !== this.#generation || this.#disposed) return;
    let error: Error = new KokoroDisconnectedError("Kokoro transport closed");
    try {
      this.#decoder?.end();
    } catch (decoderError) {
      error = new KokoroProtocolError("Kokoro transport closed with a truncated frame", {
        cause: decoderError,
      });
    }
    this.#failConnection(generation, error);
  }

  #failConnection(generation: number, error: Error): void {
    if (generation !== this.#generation || this.#disposed) return;
    this.#generation += 1;
    const transport = this.#transport;
    this.#transport = undefined;
    this.#decoder = undefined;
    transport?.close();
    this.#rejectHandshake(error);
    this.#rejectPending(error);
    this.#connectPromise = undefined;
    this.#setConnectionState("disconnected", error);
  }

  #rejectHandshake(error: Error): void {
    const pending = this.#handshake;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#handshake = undefined;
    pending.reject(error);
  }

  #rejectPending(error: Error): void {
    for (const [messageId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(messageId);
      pending.reject(error);
    }
  }

  #takePending(messageId: string): PendingRequest | undefined {
    const pending = this.#pending.get(messageId);
    if (!pending) return undefined;
    this.#pending.delete(messageId);
    clearTimeout(pending.timer);
    return pending;
  }

  #setConnectionState(current: ConnectionState, error: Error | null): void {
    const previous = this.#connectionState;
    if (previous === current) return;
    this.#connectionState = current;
    this.#notifyConnection({ previous, current, error });
  }

  #notifyConnection(change: ConnectionStateChange): void {
    this.#notify(this.#connectionListeners, change);
  }

  #notify<T>(listeners: Iterable<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        this.#reportListenerError(error);
      }
    }
  }

  #reportListenerError(error: unknown): void {
    if (!this.#options.onListenerError) return;
    try {
      this.#options.onListenerError(toError(error));
    } catch {
      // Diagnostics cannot affect client state or request correlation.
    }
  }

  #assertConnected(): void {
    this.#assertNotDisposed();
    if (this.#connectionState !== "connected") throw new KokoroDisconnectedError();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new KokoroDisposedError();
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function checkedTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from 1 through 2147483647`);
  }
  return timeout;
}

function checkedFrameBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FRAME_BYTES) {
    throw new RangeError(`maxFrameBytes must be an integer from 1 through ${MAX_FRAME_BYTES}`);
  }
  return value;
}

function createDefaultIdFactory(): () => string {
  let sequence = 0;
  const origin = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return () => `kokoro-${origin}-${++sequence}`;
}
