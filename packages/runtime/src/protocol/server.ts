import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type AuthoritySnapshot,
  type CapabilitySnapshot,
  type CheckpointRef,
  type ClientEnvelope,
  COMMAND_TYPES,
  type Command,
  type CommandResult,
  type CommandType,
  decodeJsonPayload,
  type EventEnvelope,
  encodeServerEnvelope,
  type JsonValue,
  LengthPrefixedFrameDecoder,
  type LifecyclePhase,
  type LocaleCapability,
  MAX_FRAME_BYTES,
  OBSERVATION_KINDS,
  type ObservationKind,
  type ObservationRecord,
  type OwnerDocument,
  type PersonaSnapshot,
  type PublicError,
  type PublicErrorCode,
  parseClientEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ServerEnvelope,
  type ServerHelloEnvelope,
  type StimulusKind,
} from "@kokoro/protocol";
import {
  isSupportedLocale,
  ownerText,
  SUPPORTED_PROMPT_LOCALES,
  SUPPORTED_UI_LOCALES,
  type UiLocale,
} from "../i18n/index.js";
import type { ModelCapability } from "../model.js";
import { RUNTIME_PACKAGE_VERSION } from "../package-version.js";
import type { CheckpointInfo } from "../repository/index.js";
import { type KokoroRuntime, type RuntimeAuthorityView, RuntimeStateError } from "../runtime.js";
import { type CredentialBoundary, captureCredentialSnapshot } from "../security.js";
import type { ObservationFact, QueueItemFact, RuntimeFactStore } from "../store/index.js";
import type { RuntimeTool } from "../tools/index.js";
import { compareObservationCursor, mapObservationFact, parseObservationCursor } from "./observations.js";
import type { ByteConnection } from "./ports.js";

export interface ProtocolRuntime
  extends Pick<
    KokoroRuntime,
    | "authorityView"
    | "subscribeObservations"
    | "createPersona"
    | "initialize"
    | "setLocales"
    | "start"
    | "pause"
    | "resume"
    | "stop"
    | "force"
    | "submitStimulus"
    | "submitCallback"
    | "ownerDocuments"
    | "putOwnerDocument"
    | "restore"
    | "branch"
    | "clone"
    | "deletePersona"
    | "checkpoints"
    | "retryHippocampus"
    | "observations"
  > {
  readonly incarnation: KokoroRuntime["incarnation"];
  readonly providers: KokoroRuntime["providers"];
  readonly tools: KokoroRuntime["tools"];
  readonly credentialBoundary: CredentialBoundary;
  readonly store: Pick<
    RuntimeFactStore,
    | "callbackForToolCall"
    | "getPersona"
    | "requireEvent"
    | "requireHippocampusJob"
    | "requireQueueItem"
    | "requireToolCall"
    | "reserveAuthorityRevision"
  >;
  retryProviderAttempt?(personaId: string, attemptId: string): Promise<unknown> | unknown;
  retryPublication?(personaId: string, publicationId: string): Promise<unknown> | unknown;
}

export interface ProtocolServerOptions {
  readonly serverName?: string;
  readonly serverVersion?: string;
  readonly maxFrameBytes?: number;
  readonly maxHandshakeObservations?: number;
  readonly sendTimeoutMs?: number;
  readonly now?: () => number;
  readonly id?: () => string;
}

interface CommandContext {
  readonly origin: ProtocolConnection;
  readonly correlationId: string;
  readonly messageId: string;
  readonly emissions: Set<Promise<void>>;
  readonly reviewedWorkingTreeDigests: ReadonlyMap<string, string>;
  active: boolean;
}

interface ExecutedCommand {
  readonly outcome:
    | { readonly status: "ok"; readonly result: CommandResult }
    | { readonly status: "error"; readonly error: PublicError };
  readonly snapshot: AuthoritySnapshot;
}

export class ProtocolServer {
  readonly runtime: ProtocolRuntime;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly maxFrameBytes: number;
  readonly maxHandshakeObservations: number;
  readonly sendTimeoutMs: number;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #connections = new Set<ProtocolConnection>();
  readonly #mutations = new ExclusiveQueue();
  readonly #commandContext = new AsyncLocalStorage<CommandContext>();
  #closed = false;

  constructor(runtime: ProtocolRuntime, options: ProtocolServerOptions = {}) {
    this.runtime = runtime;
    this.serverName = options.serverName ?? "kokoro-runtime";
    this.serverVersion = options.serverVersion ?? RUNTIME_PACKAGE_VERSION;
    this.maxFrameBytes = checkedFrameLimit(options.maxFrameBytes ?? MAX_FRAME_BYTES);
    this.maxHandshakeObservations = checkedPositiveInteger(
      options.maxHandshakeObservations ?? 10_000,
      "maxHandshakeObservations",
      100_000,
    );
    this.sendTimeoutMs = checkedPositiveInteger(
      options.sendTimeoutMs ?? 15_000,
      "sendTimeoutMs",
      2_147_483_647,
    );
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
  }

  async attach(connection: ByteConnection): Promise<ProtocolConnection> {
    if (this.#closed) throw new Error("ProtocolServer is closed.");
    if (connection.peerIdentity.trim() === "")
      throw new Error("ByteConnection must identify its authorized peer.");
    const attached = new ProtocolConnection(this, connection);
    this.#connections.add(attached);
    attached.onClosed(() => this.#connections.delete(attached));
    return attached;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#connections].map((connection) => connection.close("server_closed")));
    this.#connections.clear();
  }

  async capabilities(
    personaId: string | null,
    negotiatedMaxFrameBytes = this.maxFrameBytes,
  ): Promise<CapabilitySnapshot> {
    const authority = await this.runtime.authorityView();
    const selected =
      personaId === null ? undefined : authority.personas.find((view) => view.persona.id === personaId);
    if (personaId !== null && selected === undefined) {
      throw new RuntimeStateError("not_found", "Persona was not found.");
    }
    const locale = selected?.persona.promptLocale ?? "en";
    const before = await captureCredentialSnapshot(
      this.runtime.credentialBoundary,
      "Protocol capability boundary",
    );
    const models = await this.runtime.providers.capabilities();
    const providers = providerCapabilities(models);
    const tools = toolCapabilities(this.runtime.tools.list(), locale);
    before.assertCredentialFree(JSON.stringify({ providers, tools }), "capabilities");
    (
      await captureCredentialSnapshot(this.runtime.credentialBoundary, "Protocol capability boundary")
    ).assertCredentialFree(JSON.stringify({ providers, tools }), "capabilities");
    return {
      protocol: "kokoro/1",
      serverVersion: this.serverVersion,
      maxFrameBytes: Math.min(this.maxFrameBytes, negotiatedMaxFrameBytes),
      commands: COMMAND_TYPES,
      availableCommands: availableCommands(this.runtime.incarnation, selected),
      observationKinds: OBSERVATION_KINDS,
      locales: localeCapabilities(),
      providers,
      tools,
      features: { continuation: true, publication: true, hippocampus: true },
    };
  }

  async snapshot(): Promise<AuthoritySnapshot> {
    return authoritySnapshot(await this.runtime.authorityView());
  }

  currentCommandContext(): CommandContext | undefined {
    return this.#commandContext.getStore();
  }

  async execute(connection: ProtocolConnection, request: RequestEnvelope): Promise<ExecutedCommand> {
    const mutating = isMutating(request.command);
    const invoke = async (): Promise<ExecutedCommand> => {
      if (!mutating && request.expectedRevision !== null) {
        throw new ProtocolCommandError(
          "invalid_request",
          "Read-only commands require expectedRevision to be null.",
        );
      }
      if (requiresReviewedWorkingTree(request.command) && request.expectedRevision === null) {
        throw new ProtocolCommandError(
          "invalid_request",
          "A recoverable destructive command requires an Owner-reviewed authority revision.",
        );
      }
      const reviewedAuthority =
        mutating && request.expectedRevision !== null ? await this.runtime.authorityView() : undefined;
      if (mutating && request.expectedRevision !== null) {
        const revision = this.runtime.store.reserveAuthorityRevision(request.expectedRevision, this.#now());
        if (!revision.accepted) {
          throw new ProtocolCommandError("revision_conflict", "Authority revision does not match.", false, {
            expectedRevision: request.expectedRevision,
            actualRevision: revision.actualRevision,
          });
        }
      }
      const context: CommandContext = {
        origin: connection,
        correlationId: request.correlationId,
        messageId: request.messageId,
        emissions: new Set(),
        reviewedWorkingTreeDigests: new Map(
          (reviewedAuthority?.personas ?? []).flatMap((view) =>
            view.workingTree.digest === null ? [] : [[view.persona.id, view.workingTree.digest] as const],
          ),
        ),
        active: true,
      };
      let result!: CommandResult;
      let failed = false;
      let failure: unknown;
      try {
        result = await this.#commandContext.run(context, () => this.#dispatch(request.command));
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        context.active = false;
      }
      try {
        await Promise.all([...context.emissions]);
      } catch (error) {
        throw new ProtocolResponseMaterializationError(error);
      }
      if (failed) throw failure;
      try {
        return { outcome: { status: "ok", result }, snapshot: await this.snapshot() };
      } catch (error) {
        throw new ProtocolResponseMaterializationError(error);
      }
    };
    if (!mutating) return invoke();
    return this.#mutations.run(async () => {
      try {
        return await invoke();
      } catch (error) {
        if (error instanceof ProtocolResponseMaterializationError) throw error;
        try {
          return {
            outcome: { status: "error", error: await this.errorFor(error, request.command) },
            snapshot: await this.snapshot(),
          };
        } catch (materializationError) {
          throw new ProtocolResponseMaterializationError(materializationError);
        }
      }
    });
  }

  noteEmission(context: CommandContext, emission: Promise<void>): void {
    context.emissions.add(emission);
    void emission.finally(() => context.emissions.delete(emission)).catch(() => undefined);
  }

  id(): string {
    return this.#id();
  }

  now(): number {
    return this.#now();
  }

  async errorFor(error: unknown, command: Command): Promise<PublicError> {
    const personaId = "personaId" in command ? command.personaId : null;
    let locale: UiLocale = "en";
    let state = "unknown";
    if (typeof personaId === "string") {
      try {
        const selected = (await this.runtime.authorityView()).personas.find(
          (view) => view.persona.id === personaId,
        );
        if (selected) {
          state = selected.persona.lifecycle;
          if (isSupportedLocale(selected.persona.uiLocale)) locale = selected.persona.uiLocale;
        }
      } catch {
        // Error rendering is best-effort and must never replace the original code.
      }
    }
    if (error instanceof ProtocolCommandError) {
      return {
        code: error.code,
        message: publicErrorMessage(locale, error.code, command.type),
        retryable: error.retryable,
        details: error.details,
      };
    }
    return errorToPublic(error, { locale, operation: command.type, state });
  }

  async #dispatch(command: Command): Promise<CommandResult> {
    switch (command.type) {
      case "create": {
        if (command.templateId !== "default") {
          throw new ProtocolCommandError("invalid_request", "Unknown Persona template.");
        }
        const persona = await this.runtime.createPersona({
          ...(command.personaId === null ? {} : { personaId: command.personaId }),
          displayName: command.displayName,
          uiLocale: command.uiLocale,
          promptLocale: command.promptLocale,
        });
        return {
          type: "create",
          personaId: persona.id,
          operationId: this.id(),
          acceptedAt: timestamp(persona.createdAt),
        };
      }
      case "init":
        await this.runtime.initialize(command.personaId, command.expectedWorkingTreeDigest);
        return operation("init", this.id(), this.now());
      case "start": {
        const checkpoint = command.from.kind === "checkpoint" ? command.from.checkpointId : undefined;
        await this.runtime.start({
          personaId: command.personaId,
          ...(command.model === null
            ? {}
            : { model: { provider: command.model.providerId, model: command.model.modelId } }),
          ...(command.promptLocale === null ? {} : { promptLocale: command.promptLocale }),
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(checkpoint === undefined
            ? {}
            : { expectedWorkingTreeDigest: this.#reviewedWorkingTreeDigest(command.personaId) }),
        });
        return operation("start", this.id(), this.now());
      }
      case "pause":
        this.runtime.pause(command.personaId);
        return operation("pause", this.id(), this.now());
      case "resume":
        await this.runtime.resume(command.personaId);
        return operation("resume", this.id(), this.now());
      case "stop":
        await this.runtime.stop(command.personaId);
        return operation("stop", this.id(), this.now());
      case "force":
        await this.runtime.force(command.personaId);
        return operation("force", this.id(), this.now());
      case "stimulus": {
        const accepted = await this.runtime.submitStimulus({
          personaId: command.personaId,
          idempotencyKey: command.idempotencyKey,
          kind: command.stimulus.kind,
          content: command.stimulus.content as never,
          occurredAt: command.stimulus.occurredAt,
          source: command.stimulus.source,
        });
        return {
          type: "stimulus",
          stimulusId: accepted.stimulusId,
          workItemId: accepted.item.id,
          acceptedAt: timestamp(accepted.item.acceptedAt),
        };
      }
      case "callback": {
        await this.runtime.submitCallback({
          personaId: command.personaId,
          callbackId: command.callbackId,
          toolCallId: command.toolCallId,
          outcome: command.outcome as never,
        });
        const callback = this.runtime.store.callbackForToolCall(command.toolCallId);
        return {
          type: "callback",
          callbackId: command.callbackId,
          toolCallId: command.toolCallId,
          recordedAt: timestamp(callback?.receivedAt ?? this.now()),
        };
      }
      case "owner_documents":
        return {
          type: "owner_documents",
          documents: (await this.runtime.ownerDocuments(command.personaId, command.path)).map(ownerDocument),
        };
      case "put_owner_document":
        return {
          type: "put_owner_document",
          document: ownerDocument(
            await this.runtime.putOwnerDocument({
              personaId: command.personaId,
              path: command.path,
              content: command.content,
              expectedSha256: command.expectedSha256,
            }),
          ),
        };
      case "history": {
        const page = await this.runtime.checkpoints(
          command.personaId,
          command.beforeCheckpointId,
          command.limit + 1,
        );
        const visible = page.slice(0, command.limit);
        return {
          type: "history",
          checkpoints: visible.map(checkpointFromInfo),
          nextBeforeCheckpointId:
            page.length > command.limit && visible.length > 0 ? (visible.at(-1)?.commit ?? null) : null,
        };
      }
      case "branch": {
        const checkpoint = await this.#checkpoint(command.personaId, command.checkpointId);
        await this.runtime.branch(command.personaId, command.checkpointId, command.branchName);
        return { type: "branch", branchName: command.branchName, checkpoint };
      }
      case "clone": {
        const checkpoint = await this.#checkpoint(command.personaId, command.checkpointId);
        const clone = await this.runtime.clone({
          personaId: command.personaId,
          checkpoint: command.checkpointId,
          ...(command.newPersonaId === null ? {} : { newPersonaId: command.newPersonaId }),
          displayName: command.displayName,
        });
        return { type: "clone", personaId: clone.id, checkpoint };
      }
      case "restore":
        await this.runtime.restore(
          command.personaId,
          command.checkpointId,
          command.workingTreePolicy === "discard_changes",
          command.workingTreePolicy === "require_clean"
            ? this.#reviewedWorkingTreeDigest(command.personaId)
            : null,
        );
        return operation("restore", this.id(), this.now());
      case "delete":
        await this.runtime.deletePersona(
          command.personaId,
          command.confirmationPersonaId,
          command.workingTreePolicy === "discard_changes",
          command.workingTreePolicy === "require_clean"
            ? this.#reviewedWorkingTreeDigest(command.personaId)
            : null,
        );
        return operation("delete", this.id(), this.now());
      case "locales":
        return { type: "locales", locales: localeCapabilities() };
      case "set_locales":
        this.runtime.setLocales({
          personaId: command.personaId,
          uiLocale: command.uiLocale,
          promptLocale: command.promptLocale,
        });
        return operation("set_locales", this.id(), this.now());
      case "retry":
        await this.runtime.retryHippocampus(command.personaId, command.target.jobId);
        return operation("retry", this.id(), this.now());
      case "capabilities":
        return { type: "capabilities", capabilities: await this.capabilities(command.personaId) };
      case "observations":
        return {
          type: "observations",
          ...this.#observations(command.personaId, command.afterCursor, command.limit, command.kinds),
        };
      case "snapshot":
        return { type: "snapshot" };
    }
  }

  async #checkpoint(personaId: string, checkpointId: string): Promise<CheckpointRef> {
    let before: string | null = null;
    for (;;) {
      const page = await this.runtime.checkpoints(personaId, before, 1_000);
      const found = page.find((checkpoint) => checkpoint.commit === checkpointId);
      if (found) return checkpointFromInfo(found);
      if (page.length < 1_000) break;
      before = page.at(-1)?.commit ?? null;
      if (before === null) break;
    }
    throw new ProtocolCommandError("not_found", "Checkpoint was not found.");
  }

  #reviewedWorkingTreeDigest(personaId: string): string {
    const digest = this.currentCommandContext()?.reviewedWorkingTreeDigests.get(personaId);
    if (!digest) {
      throw new ProtocolCommandError(
        "working_tree_conflict",
        "The complete working tree was not available in the reviewed authority snapshot.",
      );
    }
    return digest;
  }

  #observations(
    personaId: string,
    afterCursor: string | null,
    limit: number,
    kinds: readonly ObservationKind[] | null,
  ): { observations: ObservationRecord[]; nextCursor: string | null } {
    let after: ReturnType<typeof parseObservationCursor>;
    try {
      after = parseObservationCursor(afterCursor);
    } catch {
      throw new ProtocolCommandError("invalid_request", "The observation cursor is invalid.", false, {
        field: "afterCursor",
      });
    }
    const filter = kinds === null ? null : new Set(kinds);
    const matched: ObservationRecord[] = [];
    let scanAfter = Math.max(0, after.sequence - 1);
    for (;;) {
      const batch = this.runtime.observations(personaId, scanAfter, 10_000);
      for (const fact of batch) {
        for (const record of mapObservationFact(fact, this.runtime.store)) {
          if (compareObservationCursor(record.cursor, after) <= 0) continue;
          if (filter !== null && !filter.has(record.observation.kind)) continue;
          matched.push(record);
          if (matched.length > limit) break;
        }
        if (matched.length > limit) break;
      }
      if (matched.length > limit || batch.length < 10_000) break;
      scanAfter = batch.at(-1)?.sequence ?? scanAfter;
    }
    const observations = matched.slice(0, limit);
    return {
      observations,
      nextCursor:
        matched.length > limit && observations.length > 0 ? (observations.at(-1)?.cursor ?? null) : null,
    };
  }
}

export class ProtocolConnection {
  readonly #server: ProtocolServer;
  readonly #connection: ByteConnection;
  readonly #decoder: LengthPrefixedFrameDecoder;
  readonly #seenMessageIds = new Set<string>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #closedListeners = new Set<() => void>();
  #receiveTail: Promise<void> = Promise.resolve();
  #writeTail: Promise<void> = Promise.resolve();
  #eventTail: Promise<void> = Promise.resolve();
  #unsubscribeData: (() => void) | undefined;
  #unsubscribeClose: (() => void) | undefined;
  #unsubscribeObservations: (() => void) | undefined;
  readonly #handshakeObservations: ObservationFact[] = [];
  #helloAccepted = false;
  #negotiatedMaxFrameBytes: number;
  #closed = false;

  constructor(server: ProtocolServer, connection: ByteConnection) {
    this.#server = server;
    this.#connection = connection;
    this.#negotiatedMaxFrameBytes = server.maxFrameBytes;
    this.#decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: server.maxFrameBytes });
    this.#unsubscribeObservations = server.runtime.subscribeObservations((fact) => this.#observation(fact));
    this.#unsubscribeData = connection.onData((chunk) => {
      this.#receiveTail = this.#receiveTail
        .then(() => this.#receive(chunk))
        .catch(() => this.close("protocol_error"));
    });
    this.#unsubscribeClose = connection.onClose(() => void this.close("peer_closed", false));
  }

  get peerIdentity(): string {
    return this.#connection.peerIdentity;
  }

  get closed(): boolean {
    return this.#closed;
  }

  onClosed(listener: () => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  async close(reason = "closed", closeTransport = true): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeData?.();
    this.#unsubscribeClose?.();
    this.#unsubscribeObservations?.();
    this.#handshakeObservations.length = 0;
    try {
      this.#decoder.end();
    } catch {
      // A partial peer frame is simply abandoned while closing.
    }
    await Promise.allSettled([...this.#inFlight]);
    await this.#writeTail.catch(() => undefined);
    if (closeTransport) await this.#connection.close(reason);
    for (const listener of this.#closedListeners) listener();
    this.#closedListeners.clear();
  }

  async #receive(chunk: Uint8Array): Promise<void> {
    if (this.#closed) return;
    const payloads = this.#decoder.push(chunk);
    for (const payload of payloads) {
      let raw: JsonValue;
      try {
        raw = decodeJsonPayload(payload);
      } catch {
        await this.close("invalid_json");
        return;
      }
      let envelope: ClientEnvelope;
      try {
        envelope = parseClientEnvelope(raw);
      } catch {
        const meta = envelopeMeta(raw);
        if (meta === null) {
          await this.close("invalid_envelope");
          return;
        }
        if (!this.#helloAccepted) {
          await this.#rejectHello(
            meta.messageId,
            meta.correlationId,
            meta.protocol === "kokoro/1" ? "invalid_request" : "unsupported_version",
          );
          return;
        }
        await this.#respondError(
          meta.messageId,
          meta.correlationId,
          publicError("invalid_request", "Invalid request envelope."),
        );
        continue;
      }
      if (!this.#helloAccepted) {
        await this.#first(envelope);
        if (!this.#helloAccepted) return;
        continue;
      }
      if (envelope.kind !== "request") {
        await this.#rejectHello(envelope.messageId, envelope.correlationId, "invalid_request");
        return;
      }
      if (this.#seenMessageIds.has(envelope.messageId)) {
        await this.#respondError(
          envelope.messageId,
          envelope.correlationId,
          publicError("invalid_request", "messageId was already used on this connection."),
        );
        continue;
      }
      this.#seenMessageIds.add(envelope.messageId);
      const task = this.#request(envelope);
      this.#inFlight.add(task);
      void task.finally(() => this.#inFlight.delete(task)).catch(() => this.close("request_failed"));
    }
  }

  async #first(envelope: ClientEnvelope): Promise<void> {
    if (envelope.kind !== "hello") {
      await this.#rejectHello(envelope.messageId, envelope.correlationId, "invalid_request");
      return;
    }
    this.#seenMessageIds.add(envelope.messageId);
    this.#negotiatedMaxFrameBytes = Math.min(this.#server.maxFrameBytes, envelope.maxFrameBytes);
    const capabilities = await this.#server.capabilities(null, this.#negotiatedMaxFrameBytes);
    // Capability discovery can await providers and inspect working trees.
    // Capture authority last so hello does not carry a snapshot already made
    // stale by its own preparation.
    const snapshot = await this.#server.snapshot();
    const response: ServerHelloEnvelope = {
      protocol: "kokoro/1",
      kind: "hello",
      messageId: this.#server.id(),
      correlationId: envelope.correlationId,
      replyTo: envelope.messageId,
      snapshot,
      outcome: {
        status: "ok",
        server: { name: this.#server.serverName, version: this.#server.serverVersion },
        capabilities,
      },
    };
    await this.#send(response);
    await this.#flushHandshakeObservations();
  }

  async #rejectHello(
    replyTo: string,
    correlationId: string,
    code: "invalid_request" | "unsupported_version",
  ): Promise<void> {
    const response: ServerHelloEnvelope = {
      protocol: "kokoro/1",
      kind: "hello",
      messageId: this.#server.id(),
      correlationId,
      replyTo,
      snapshot: null,
      outcome: {
        status: "error",
        error: publicError(
          code,
          code === "unsupported_version"
            ? "Unsupported protocol version."
            : "The first envelope must be hello.",
        ),
      },
    };
    try {
      await this.#send(response);
    } finally {
      await this.close(code);
    }
  }

  async #request(request: RequestEnvelope): Promise<void> {
    let executed: ExecutedCommand;
    try {
      executed = await this.#server.execute(this, request);
    } catch (error) {
      if (error instanceof ProtocolResponseMaterializationError) {
        throw error;
      }
      await this.#respondError(
        request.messageId,
        request.correlationId,
        await this.#server.errorFor(error, request.command),
      );
      return;
    }
    const response: ResponseEnvelope = {
      protocol: "kokoro/1",
      kind: "response",
      messageId: this.#server.id(),
      correlationId: request.correlationId,
      replyTo: request.messageId,
      snapshot: executed.snapshot,
      outcome: executed.outcome,
    };
    await this.#send(response);
  }

  async #respondError(replyTo: string, correlationId: string, error: PublicError): Promise<void> {
    const response: ResponseEnvelope = {
      protocol: "kokoro/1",
      kind: "response",
      messageId: this.#server.id(),
      correlationId,
      replyTo,
      snapshot: await this.#server.snapshot(),
      outcome: { status: "error", error },
    };
    await this.#send(response);
  }

  #observation(fact: ObservationFact): void {
    if (this.#closed) return;
    if (!this.#helloAccepted) {
      if (this.#handshakeObservations.length >= this.#server.maxHandshakeObservations) {
        void this.close("handshake_observation_overflow");
        return;
      }
      this.#handshakeObservations.push(fact);
      return;
    }
    const context = this.#server.currentCommandContext();
    const isOrigin = context?.active === true && context.origin === this;
    // Observation correlation is intrinsic and therefore identical on live
    // delivery and later cursor replay. Request linkage belongs in causationId.
    const correlationId = `observation:${fact.sequence}`;
    const causationId = isOrigin ? context.messageId : null;
    const emission = this.#queueObservation(fact, correlationId, causationId);
    if (isOrigin) this.#server.noteEmission(context, emission);
    this.#inFlight.add(emission);
    void emission
      .finally(() => this.#inFlight.delete(emission))
      .catch(() => this.close("event_delivery_failed"));
  }

  #queueObservation(fact: ObservationFact, correlationId: string, causationId: string | null): Promise<void> {
    const emission = this.#eventTail.then(() => this.#emitObservation(fact, correlationId, causationId));
    this.#eventTail = emission.catch(() => undefined);
    return emission;
  }

  async #flushHandshakeObservations(): Promise<void> {
    for (;;) {
      const buffered = this.#handshakeObservations
        .splice(0)
        .sort((left, right) => left.sequence - right.sequence);
      if (buffered.length === 0) {
        // No await occurs between observing an empty buffer and entering live
        // mode, so a fact cannot fall between those states in JavaScript.
        this.#helloAccepted = true;
        return;
      }
      for (const fact of buffered) {
        await this.#emitObservation(fact, `observation:${fact.sequence}`, null);
      }
    }
  }

  async #emitObservation(
    fact: ObservationFact,
    correlationId: string,
    causationId: string | null,
  ): Promise<void> {
    for (const record of mapObservationFact(fact, this.#server.runtime.store, { correlationId })) {
      if (this.#closed) return;
      const event: EventEnvelope = {
        protocol: "kokoro/1",
        kind: "event",
        messageId: this.#server.id(),
        correlationId,
        causationId,
        snapshot: await this.#server.snapshot(),
        record,
      };
      await this.#send(event);
    }
  }

  async #send(envelope: ServerEnvelope): Promise<void> {
    if (this.#closed) throw new Error("Protocol connection is closed.");
    const write = this.#writeTail.then(async () => {
      let active = true;
      try {
        await withTimeout(
          (async () => {
            const credentials = await captureCredentialSnapshot(
              this.#server.runtime.credentialBoundary,
              "Protocol transport boundary",
            );
            if (!active || this.#closed) return;
            credentials.assertCredentialFree(JSON.stringify(envelope), "protocol envelope");
            if (!active || this.#closed) return;
            // encodeServerEnvelope is deliberately the sole producer gate. It
            // parses the complete DTO strictly before bytes reach transport.
            const frame = encodeServerEnvelope(envelope, this.#negotiatedMaxFrameBytes);
            if (!active || this.#closed) return;
            await this.#connection.send(frame);
          })(),
          this.#server.sendTimeoutMs,
        );
      } finally {
        // Promise.race cannot cancel a late credential resolver. Fence that
        // continuation so a timed-out write can never reach the transport.
        active = false;
      }
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }
}

class ExclusiveQueue {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class ProtocolCommandError extends Error {
  readonly code: PublicErrorCode;
  readonly retryable: boolean;
  readonly details: JsonValue;

  constructor(code: PublicErrorCode, message: string, retryable = false, details: JsonValue = null) {
    super(message);
    this.name = "ProtocolCommandError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

class ProtocolResponseMaterializationError extends Error {
  constructor(cause: unknown) {
    super("The command completed but its authoritative response could not be materialized.", { cause });
    this.name = "ProtocolResponseMaterializationError";
  }
}

function isMutating(command: Command): boolean {
  return !READ_ONLY_COMMANDS.has(command.type);
}

function requiresReviewedWorkingTree(command: Command): boolean {
  return (
    (command.type === "start" && command.from.kind === "checkpoint") ||
    ((command.type === "restore" || command.type === "delete") &&
      command.workingTreePolicy === "require_clean")
  );
}

const READ_ONLY_COMMANDS: ReadonlySet<Command["type"]> = new Set([
  "owner_documents",
  "history",
  "locales",
  "capabilities",
  "observations",
  "snapshot",
]);

function availableCommands(
  incarnation: string,
  view: RuntimeAuthorityView["personas"][number] | undefined,
): CommandType[] {
  const available = new Set<CommandType>(["create", "locales", "capabilities", "snapshot"]);
  if (view === undefined) return COMMAND_TYPES.filter((command) => available.has(command));

  for (const command of ["owner_documents", "history", "set_locales", "observations"] as const) {
    available.add(command);
  }

  const run = view.run;
  const locallyWritable = run === null || run.incarnation === incarnation;
  if (locallyWritable) {
    available.add("put_owner_document");
    available.add("callback");
  }

  if (run === null) {
    available.add("delete");
    if (!view.persona.initialized && view.persona.lifecycle === "draft") available.add("init");
    if (view.persona.initialized && view.persona.currentCheckpoint !== null) available.add("start");
    if (view.latestCheckpoint !== null || view.persona.currentCheckpoint !== null) {
      available.add("branch");
      available.add("clone");
      available.add("restore");
    }
  } else if (run.incarnation === incarnation) {
    if (run.phase === "running" || run.phase === "pausing" || run.phase === "paused") {
      available.add("pause");
      available.add("stop");
      available.add("stimulus");
    }
    if (run.phase === "paused") available.add("resume");
    if (run.phase === "stopping") available.add("stop");
    if (view.persona.currentCheckpoint !== null && run.phase !== "forcing") available.add("force");
    if (view.latestCheckpoint !== null || view.persona.currentCheckpoint !== null) {
      available.add("branch");
      available.add("clone");
    }
  }

  if (
    locallyWritable &&
    view.hippocampus.some((job) => job.status === "failed" || job.status === "conflict")
  ) {
    available.add("retry");
  }
  return COMMAND_TYPES.filter((command) => available.has(command));
}

function ownerDocument(document: {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly mtimeMs: number;
}): OwnerDocument {
  return {
    path: document.path,
    content: document.content,
    sha256: document.sha256,
    mtimeMs: document.mtimeMs,
  };
}

function operation<
  T extends
    | "init"
    | "start"
    | "pause"
    | "resume"
    | "stop"
    | "force"
    | "restore"
    | "delete"
    | "set_locales"
    | "retry",
>(type: T, operationId: string, acceptedAt: number): Extract<CommandResult, { type: T }> {
  return { type, operationId, acceptedAt: timestamp(acceptedAt) } as Extract<CommandResult, { type: T }>;
}

function authoritySnapshot(view: RuntimeAuthorityView): AuthoritySnapshot {
  const capturedAt = timestamp(view.capturedAt);
  return {
    revision: view.revision,
    capturedAt,
    personas: view.personas.map((persona) => personaSnapshot(persona, capturedAt)),
  };
}

function personaSnapshot(
  view: RuntimeAuthorityView["personas"][number],
  capturedAt: string,
): PersonaSnapshot {
  const queue = view.queue
    .filter(
      (item): item is QueueItemFact & { kind: "stimulus" | "continuation" } =>
        (item.kind === "stimulus" || item.kind === "continuation") &&
        (item.status === "queued" || item.status === "started"),
    )
    .map((item) => ({
      workItemId: item.id,
      source: item.kind,
      state:
        item.status === "started"
          ? ("active" as const)
          : view.run?.phase === "paused" || view.run?.phase === "pausing"
            ? ("frozen_by_pause" as const)
            : ("pending" as const),
      acceptedAt: timestamp(item.acceptedAt),
      stimulusKind: item.kind === "stimulus" ? storedStimulusKind(item.payload) : null,
    }));
  const latest = view.latestCheckpoint;
  return {
    personaId: view.persona.id,
    displayName: view.persona.displayName,
    uiLocale: view.persona.uiLocale,
    promptLocale: view.persona.promptLocale,
    phase: lifecyclePhase(view.persona.lifecycle),
    runId: view.run?.id ?? null,
    activeEventId: view.activeEvent?.id ?? null,
    waiting: waitingFact(view.run?.waitingCode ?? null),
    queue,
    latestCheckpoint:
      latest === null
        ? null
        : {
            checkpointId: latest.commit,
            commitId: latest.commit,
            summary: latest.summary,
            createdAt: timestamp(latest.createdAt),
          },
    currentCheckpointId: view.persona.currentCheckpoint,
    selectedStartCheckpointId: view.persona.selectedCheckpoint,
    workingTree: view.workingTree,
    publication: view.publication,
    hippocampus: {
      queued: view.hippocampus.filter((job) => job.status === "queued").length,
      running: view.hippocampus.some((job) => job.status === "running" || job.status === "applying"),
      retryWaiting: view.hippocampus.filter((job) => job.status === "retry").length,
      failed: view.hippocampus.filter((job) => job.status === "failed").length,
      conflicted: view.hippocampus.filter((job) => job.status === "conflict").length,
    },
    updatedAt: capturedAt,
  };
}

function lifecyclePhase(value: string): LifecyclePhase {
  switch (value) {
    case "draft":
      return "draft";
    case "ready":
      return "initialized";
    case "running":
      return "running";
    case "pausing":
      return "pausing";
    case "paused":
      return "paused";
    case "stopping":
      return "stopping";
    case "forcing":
      return "forcing";
    case "stopped":
    case "forced":
      return "stopped";
    default:
      return "failed";
  }
}

function waitingFact(code: string | null): PersonaSnapshot["waiting"] {
  if (code === null) return null;
  if (code.startsWith("tool_callback:")) {
    return { kind: "tool_callback", toolCallId: code.slice("tool_callback:".length) };
  }
  return { kind: "owner_action", reason: code };
}

function storedStimulusKind(value: unknown): StimulusKind | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const kind = (value as Record<string, unknown>)["kind"];
  return kind === "user_message" ||
    kind === "system_event" ||
    kind === "scheduled" ||
    kind === "external_change"
    ? kind
    : null;
}

function checkpointFromInfo(checkpoint: CheckpointInfo): CheckpointRef {
  return {
    checkpointId: checkpoint.commit,
    commitId: checkpoint.commit,
    summary: checkpoint.message,
    createdAt: checkpoint.timestamp,
  };
}

function localeCapabilities(): LocaleCapability[] {
  const locales = new Set<string>([...SUPPORTED_UI_LOCALES, ...SUPPORTED_PROMPT_LOCALES]);
  return [...locales].sort().map((locale) => ({
    locale,
    label: locale === "zh-CN" ? "简体中文" : locale === "en" ? "English" : locale,
    ui: (SUPPORTED_UI_LOCALES as readonly string[]).includes(locale),
    prompt: (SUPPORTED_PROMPT_LOCALES as readonly string[]).includes(locale),
  }));
}

function providerCapabilities(models: readonly ModelCapability[]): CapabilitySnapshot["providers"] {
  const grouped = new Map<string, ModelCapability[]>();
  for (const model of models) {
    const group = grouped.get(model.provider) ?? [];
    group.push(model);
    grouped.set(model.provider, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerId, entries]) => ({
      providerId,
      label: providerId,
      available: entries.some((entry) => entry.authenticated),
      unavailableReason: entries.some((entry) => entry.authenticated) ? null : "authentication_required",
      models: entries
        .slice()
        .sort((left, right) => left.model.localeCompare(right.model))
        .map((entry) => ({
          modelId: entry.model,
          label: entry.displayName,
          contextWindow: entry.contextWindow,
        })),
    }));
}

function toolCapabilities(tools: readonly RuntimeTool[], locale: string): CapabilitySnapshot["tools"] {
  return tools
    .map((tool) => {
      const description = tool.describe(locale);
      return {
        toolName: tool.name,
        description: description.description,
        available: true,
        externalEffect: tool.effect === "external" ? ("possible" as const) : ("none" as const),
        authorizationRequiredAtDispatch: true,
      };
    })
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
}

function errorToPublic(
  error: unknown,
  owner: { locale: UiLocale; operation: string; state: string },
): PublicError {
  if (error instanceof RuntimeStateError) {
    const code: PublicErrorCode =
      error.code === "not_found"
        ? "not_found"
        : error.code === "invalid_request"
          ? "invalid_request"
          : error.code === "working_tree_conflict"
            ? "working_tree_conflict"
            : error.code === "unavailable" || error.code === "busy"
              ? "unavailable"
              : "invalid_state";
    const message =
      code === "invalid_request"
        ? ownerText(owner.locale, "error.invalidRequest")
        : code === "not_found"
          ? ownerText(owner.locale, "error.notFound")
          : code === "unavailable"
            ? ownerText(owner.locale, "error.authorityConflict")
            : code === "working_tree_conflict"
              ? owner.operation === "put_owner_document"
                ? ownerText(owner.locale, "error.ownerDocumentConflict")
                : ownerText(owner.locale, "error.memoryConflict", { reason: "working_tree_conflict" })
              : error.code === "conflict"
                ? ownerText(owner.locale, "error.authorityConflict")
                : ownerText(owner.locale, "error.invalidLifecycle", {
                    operation: owner.operation,
                    state: owner.state,
                  });
    return publicError(code, message, error.code === "busy" || error.code === "unavailable", {
      runtimeCode: error.code,
    });
  }
  const named = error as { name?: unknown; code?: unknown };
  if (named?.name === "CredentialBoundaryError") {
    return publicError("invalid_request", ownerText(owner.locale, "error.invalidRequest"));
  }
  if (named?.name === "RepositoryError") {
    const code =
      named.code === "dirty_worktree" || named.code === "conflict" || named.code === "path_exists"
        ? "working_tree_conflict"
        : named.code === "invalid_checkpoint" || named.code === "not_found"
          ? "not_found"
          : named.code === "invalid_path"
            ? "invalid_request"
            : "invalid_state";
    const message =
      code === "working_tree_conflict"
        ? owner.operation === "put_owner_document"
          ? ownerText(owner.locale, "error.ownerDocumentConflict")
          : ownerText(owner.locale, "error.memoryConflict", { reason: "working_tree_conflict" })
        : code === "not_found"
          ? ownerText(owner.locale, "error.notFound")
          : code === "invalid_request"
            ? ownerText(owner.locale, "error.invalidRequest")
            : ownerText(owner.locale, "error.invalidLifecycle", {
                operation: owner.operation,
                state: owner.state,
              });
    return publicError(code, message, false, { runtimeCode: String(named.code ?? "repository_error") });
  }
  if (named?.code === "SQLITE_BUSY" || named?.code === "SQLITE_LOCKED") {
    return publicError("unavailable", ownerText(owner.locale, "error.authorityConflict"), true, {
      runtimeCode: String(named.code),
    });
  }
  return publicError(
    "internal_error",
    ownerText(owner.locale, "error.internalFailure", { operation: owner.operation }),
  );
}

function publicErrorMessage(locale: UiLocale, code: PublicErrorCode, operation: string): string {
  if (code === "invalid_request") return ownerText(locale, "error.invalidRequest");
  if (code === "not_found") return ownerText(locale, "error.notFound");
  if (code === "revision_conflict") return ownerText(locale, "error.authorityConflict");
  if (code === "unavailable" || code === "rate_limited") {
    return ownerText(locale, "error.authorityConflict");
  }
  return ownerText(locale, "error.internalFailure", { operation });
}

function publicError(
  code: PublicErrorCode,
  message: string,
  retryable = false,
  details: JsonValue = null,
): PublicError {
  return { code, message, retryable, details };
}

function envelopeMeta(
  value: JsonValue,
): { messageId: string; correlationId: string; protocol: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue>;
  const messageId = boundedId(record["messageId"]);
  const correlationId = boundedId(record["correlationId"]);
  if (messageId === null || correlationId === null) return null;
  return {
    messageId,
    correlationId,
    protocol: typeof record["protocol"] === "string" ? record["protocol"] : "",
  };
}

function boundedId(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function checkedFrameLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FRAME_BYTES) {
    throw new RangeError(`maxFrameBytes must be between 1 and ${MAX_FRAME_BYTES}.`);
  }
  return value;
}

function checkedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Protocol transport send timed out.")), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
