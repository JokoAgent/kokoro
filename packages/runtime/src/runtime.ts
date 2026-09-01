import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolCallbackOutcome } from "@kokoro/protocol";
import { AsyncMutex, AsyncSignal } from "./async.js";
import { CallbackCoordinator } from "./callbacks.js";
import { createBuiltinToolTextResolver, EventEngine, type EventEngineOptions } from "./engine/index.js";
import {
  filesystemDirectoriesEqual,
  filesystemDirectoriesOverlap,
  filesystemDirectoryIdentity,
  filesystemPathOverlapsDirectory,
} from "./filesystem-path.js";
import { HippocampusRunner } from "./hippocampus/index.js";
import { draftTemplates, isSupportedLocale, type PromptLocale, type UiLocale } from "./i18n/index.js";
import {
  MemoryTransactionManager,
  type MemoryTransactionOptions,
  MemoryTransactionRecoveryRequiredError,
} from "./memory/index.js";
import type { JsonValue, ModelProvider, ModelRef } from "./model.js";
import { ProviderRegistry } from "./model.js";
import {
  type CheckpointInfo,
  type CheckpointPlan,
  PersonaRepository,
  type RepositoryDocument,
  RepositoryError,
} from "./repository/index.js";
import {
  assertCredentialBoundary,
  assertCredentialFree,
  type CredentialBoundary,
  captureCredentialSnapshot,
  mergeCredentialBoundaries,
} from "./security.js";
import type {
  EventFact,
  HippocampusJobFact,
  ObservationFact,
  PersonaFact,
  QueueItemFact,
  RunFact,
  ToolCallFact,
} from "./store/index.js";
import { RuntimeFactStore } from "./store/index.js";
import {
  AllowAllAuthorizationPolicy,
  type AuthorizationPolicy,
  createBuiltinTools,
  type MessageDelivery,
  type RuntimeTool,
  ToolRegistry,
} from "./tools/index.js";

export interface KokoroRuntimeOptions {
  stateDirectory: string;
  personaDirectory: string;
  providers?: readonly ModelProvider[];
  tools?: readonly RuntimeTool[];
  authorization?: AuthorizationPolicy;
  messageDelivery?: MessageDelivery;
  defaultModel?: ModelRef;
  now?: () => number;
  eventFault?: EventEngineOptions["fault"];
  memoryFault?: MemoryTransactionOptions["fault"];
}

export interface CreatePersonaInput {
  personaId?: string;
  displayName: string;
  uiLocale: string;
  promptLocale: string;
}

export interface RuntimePersonaView {
  persona: PersonaFact;
  run: RunFact | null;
  activeEvent: EventFact | null;
  queue: QueueItemFact[];
  latestCheckpoint: { commit: string; summary: string; createdAt: number } | null;
  workingTree: { state: "clean" | "dirty" | "unknown"; digest: string | null };
  publication: { pending: number; delivering: number; retryWaiting: number; failed: number };
  hippocampus: HippocampusJobFact[];
}

export interface RuntimeAuthorityView {
  revision: number;
  capturedAt: number;
  personas: RuntimePersonaView[];
}

export class RuntimeStateError extends Error {
  readonly code:
    | "busy"
    | "conflict"
    | "invalid_request"
    | "invalid_state"
    | "not_found"
    | "unavailable"
    | "working_tree_conflict";

  constructor(code: RuntimeStateError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeStateError";
    this.code = code;
  }
}

interface PersonaContext {
  readonly repository: PersonaRepository;
  readonly mutex: AsyncMutex;
  readonly engine: EventEngine;
  readonly hippocampus: HippocampusRunner;
  readonly queueSignal: AsyncSignal;
  queueController?: AbortController;
  queuePromise?: Promise<void>;
  lease?: { ownerId: string; fence: number };
  hSignal: AsyncSignal;
  hController?: AbortController;
  hPromise?: Promise<void>;
}

interface RuntimeComponents {
  readonly providers: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly authorization: AuthorizationPolicy;
  readonly credentialBoundary: CredentialBoundary;
}

export class KokoroRuntime {
  readonly stateDirectory: string;
  readonly personaDirectory: string;
  readonly incarnation = randomUUID();
  readonly store: RuntimeFactStore;
  readonly providers: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly credentialBoundary: CredentialBoundary;
  readonly callbacks: CallbackCoordinator;
  readonly #authorization: AuthorizationPolicy;
  readonly #messageDelivery: MessageDelivery | undefined;
  readonly #defaultModel: ModelRef | undefined;
  readonly #now: () => number;
  readonly #eventFault: EventEngineOptions["fault"] | undefined;
  readonly #memory: MemoryTransactionManager;
  readonly #contexts = new Map<string, Promise<PersonaContext>>();
  readonly #authorityViewMutex = new AsyncMutex();
  readonly #hDisabled = new Set<string>();
  readonly #ownedLeases = new Map<string, { ownerId: string; fence: number }>();
  #closed = false;

  private constructor(options: KokoroRuntimeOptions, components: RuntimeComponents) {
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.personaDirectory = path.resolve(options.personaDirectory);
    if (pathsOverlap(this.stateDirectory, this.personaDirectory)) {
      throw new RuntimeStateError(
        "invalid_request",
        "Runtime state and Persona repositories must use separate directories.",
      );
    }
    this.store = new RuntimeFactStore(this.stateDirectory);
    this.providers = components.providers;
    this.tools = components.tools;
    this.credentialBoundary = components.credentialBoundary;
    this.#authorization = components.authorization;
    this.#messageDelivery = options.messageDelivery;
    this.#defaultModel = options.defaultModel;
    this.#now = options.now ?? Date.now;
    this.#eventFault = options.eventFault;
    this.callbacks = new CallbackCoordinator(this.store);
    this.#memory = new MemoryTransactionManager(this.store, {
      ...(options.memoryFault === undefined ? {} : { fault: options.memoryFault }),
      now: this.#now,
    });
  }

  static async open(options: KokoroRuntimeOptions): Promise<KokoroRuntime> {
    const providers = new ProviderRegistry(options.providers ?? []);
    const authorization = options.authorization ?? new AllowAllAuthorizationPolicy();
    assertCredentialBoundary(authorization, "AuthorizationPolicy");
    if (options.messageDelivery !== undefined) {
      assertCredentialBoundary(options.messageDelivery, "MessageDelivery");
    }
    const text = createBuiltinToolTextResolver();
    const builtins = createBuiltinTools(text).filter(
      (tool) => tool.name !== "send_message" || options.messageDelivery !== undefined,
    );
    const tools = new ToolRegistry([...builtins, ...(options.tools ?? [])]);
    const credentialBoundary = mergeCredentialBoundaries([
      providers,
      tools,
      authorization,
      ...(options.messageDelivery === undefined ? [] : [options.messageDelivery]),
    ]);
    const hostCredentials = await captureCredentialSnapshot(credentialBoundary, "Runtime host boundary");
    hostCredentials.assertCredentialFree(
      JSON.stringify({
        stateDirectory: path.resolve(options.stateDirectory),
        personaDirectory: path.resolve(options.personaDirectory),
        defaultModel: options.defaultModel ?? null,
        providerIds: (options.providers ?? []).map((provider) => provider.id),
        toolNames: (options.tools ?? []).map((tool) => tool.name),
      }),
      "Runtime host options",
    );
    const authorityDirectories = await prepareAuthorityDirectories(
      options.stateDirectory,
      options.personaDirectory,
    );
    hostCredentials.assertCredentialFree(
      JSON.stringify(authorityDirectories),
      "Runtime authority directories",
    );
    const runtime = new KokoroRuntime(
      { ...options, ...authorityDirectories },
      {
        providers,
        tools,
        authorization,
        credentialBoundary,
      },
    );
    try {
      await runtime.#recover();
      return runtime;
    } catch (error) {
      runtime.#releaseOwnedLeases();
      runtime.store.close();
      throw error;
    }
  }

  subscribeObservations(listener: (observation: ObservationFact) => void): () => void {
    this.#assertOpen();
    return this.store.subscribeObservations(listener);
  }

  async createPersona(input: CreatePersonaInput): Promise<PersonaFact> {
    this.#assertOpen();
    const uiLocale = requireUiLocale(input.uiLocale);
    const promptLocale = requirePromptLocale(input.promptLocale);
    const id = input.personaId ?? randomUUID();
    assertPersonaId(id);
    assertCredentialFree(id, "Persona id");
    if (input.displayName.trim() === "")
      throw new RuntimeStateError("invalid_request", "Display name must not be empty.");
    assertCredentialFree(input.displayName, "Persona display name");
    (
      await captureCredentialSnapshot(this.credentialBoundary, "Runtime create boundary")
    ).assertCredentialFree(JSON.stringify({ ...input, personaId: id }), "Persona creation");
    const repositoryPath = path.join(this.personaDirectory, id);
    await assertAuthorityDestination(
      repositoryPath,
      [this.stateDirectory],
      "A Persona repository cannot contain Runtime state.",
    );
    const repository = await PersonaRepository.createDraft(
      repositoryPath,
      draftTemplates(promptLocale),
      this.credentialBoundary,
    );
    await assertAuthorityDestination(
      repository.root,
      [this.stateDirectory],
      "A Persona repository cannot contain Runtime state.",
    );
    // A Store failure retains the draft: recursive cleanup could race an editor.
    const persona = this.store.createPersona({
      id,
      displayName: input.displayName,
      repositoryPath,
      uiLocale,
      promptLocale,
      now: this.#now(),
    });
    this.#observe(persona.id, "lifecycle", { phase: "draft", runId: null, reason: null });
    return persona;
  }

  async initialize(personaId: string, expectedWorkingTreeDigest: string | null = null): Promise<PersonaFact> {
    this.#assertOpen();
    const persona = this.#persona(personaId);
    if (persona.lifecycle !== "draft" || persona.initialized) {
      throw new RuntimeStateError("invalid_state", "Only a draft can be initialized.");
    }
    const context = await this.#context(persona);
    if (!this.#ensureLease(personaId, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    const summary = persona.promptLocale === "zh-CN" ? "初始化 Persona" : "Initialize Persona";
    try {
      await context.mutex.run(async () => {
        this.#assertContextLease(personaId, context);
        const reviewed = await context.repository.stableWorkingTreeSnapshot();
        if (expectedWorkingTreeDigest !== null && expectedWorkingTreeDigest !== reviewed.digest) {
          throw new RuntimeStateError("working_tree_conflict", "The draft changed after it was reviewed.");
        }
        const [personaDocuments, memoryDocuments] = await Promise.all([
          context.repository.readPersonaDocuments(),
          context.repository.readMemoryDocuments(),
        ]);
        (
          await captureCredentialSnapshot(this.credentialBoundary, "Runtime initialization boundary")
        ).assertCredentialFree(
          [...personaDocuments, ...memoryDocuments].map((document) => document.content).join("\n"),
          "Persona initialization",
        );
        if ((await context.repository.stableWorkingTreeSnapshot()).digest !== reviewed.digest) {
          throw new RuntimeStateError(
            "working_tree_conflict",
            "The draft changed while initialization was being reviewed.",
          );
        }
        this.#assertContextLease(personaId, context);
        const plan = await context.repository.prepareCheckpoint(summary, new Date(this.#now()).toISOString());
        if ((await context.repository.stableWorkingTreeSnapshot()).digest !== reviewed.digest) {
          throw new RuntimeStateError(
            "working_tree_conflict",
            "The draft changed while its root Checkpoint was being prepared.",
          );
        }
        this.#assertContextLease(personaId, context);
        const intentId = this.store.saveCheckpointIntent({
          personaId,
          kind: "root",
          commit: plan.commit,
          plan: toJson(plan),
          now: this.#now(),
        });
        await context.repository.advanceCheckpoint(plan);
        this.#assertContextLease(personaId, context);
        this.store.completeCheckpointIntent({
          intentId,
          personaId,
          commit: plan.commit,
          summary,
          root: true,
          now: this.#now(),
        });
      });
    } finally {
      this.#releaseLeaseIfIdle(personaId, context);
    }
    this.#observe(personaId, "lifecycle", { phase: "initialized", runId: null, reason: null });
    return this.#persona(personaId);
  }

  setLocales(input: {
    personaId: string;
    uiLocale: string | null;
    promptLocale: string | null;
  }): PersonaFact {
    this.#assertOpen();
    if (input.uiLocale === null && input.promptLocale === null) {
      throw new RuntimeStateError("invalid_request", "At least one locale must be selected.");
    }
    const patch: { uiLocale?: UiLocale; promptLocale?: PromptLocale } = {};
    if (input.uiLocale !== null) patch.uiLocale = requireUiLocale(input.uiLocale);
    if (input.promptLocale !== null) patch.promptLocale = requirePromptLocale(input.promptLocale);
    return this.store.updatePersona(this.#persona(input.personaId).id, patch);
  }

  async ownerDocuments(personaId: string, documentPath: string | null = null): Promise<RepositoryDocument[]> {
    this.#assertOpen();
    const context = await this.#context(this.#persona(personaId));
    const documents = await context.mutex.run(() => context.repository.readOwnerDocuments(documentPath));
    for (const document of documents) {
      assertCredentialFree(document.path, "Owner document path");
      assertCredentialFree(document.content, "Owner document content");
    }
    return documents;
  }

  async putOwnerDocument(input: {
    personaId: string;
    path: string;
    content: string;
    expectedSha256: string | null;
  }): Promise<RepositoryDocument> {
    this.#assertOpen();
    assertCredentialFree(input.path, "Owner document path");
    assertCredentialFree(input.content, "Owner document");
    (await captureCredentialSnapshot(this.credentialBoundary, "Runtime Owner boundary")).assertCredentialFree(
      JSON.stringify(input),
      "Owner document",
    );
    const context = await this.#context(this.#persona(input.personaId));
    if (!this.#ensureLease(input.personaId, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    try {
      return await context.mutex.run(async () => {
        this.#assertContextLease(input.personaId, context);
        if (this.store.pendingMemoryTransaction(input.personaId) !== undefined) {
          throw new RuntimeStateError(
            "conflict",
            "A recorded Memory transaction must be reconciled before Owner edits can continue.",
          );
        }
        const document = await context.repository.writeOwnerDocument(
          input.path,
          input.content,
          input.expectedSha256,
        );
        this.#assertContextLease(input.personaId, context);
        return document;
      });
    } finally {
      this.#releaseLeaseIfIdle(input.personaId, context);
    }
  }

  async start(input: {
    personaId: string;
    model?: ModelRef;
    promptLocale?: string;
    checkpoint?: string;
    expectedWorkingTreeDigest?: string | null;
  }): Promise<RunFact> {
    this.#assertOpen();
    (await captureCredentialSnapshot(this.credentialBoundary, "Runtime Start boundary")).assertCredentialFree(
      JSON.stringify(input),
      "Start input",
    );
    let persona = this.#persona(input.personaId);
    if (!persona.initialized || persona.currentCheckpoint === null) {
      throw new RuntimeStateError("invalid_state", "The Persona must be initialized before Start.");
    }
    if (this.store.activeRun(persona.id))
      throw new RuntimeStateError("invalid_state", "The Persona already has an active run.");
    const context = await this.#context(persona);
    if (!this.#ensureLease(persona.id, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    let run: RunFact;
    let startRestoreOperationId: string | undefined;
    let startRestoreApplied = false;
    try {
      if (input.checkpoint !== undefined) {
        const selectedCheckpoint = input.checkpoint;
        const restoreOperationId = randomUUID();
        startRestoreOperationId = restoreOperationId;
        await context.mutex.run(async () => {
          this.#assertContextLease(persona.id, context);
          await this.#registeredCheckpointInfo(persona.id, selectedCheckpoint, context.repository);
          const reviewed = await context.repository.stableWorkingTreeSnapshot();
          if (reviewed.dirty) {
            throw new RuntimeStateError(
              "working_tree_conflict",
              "The Persona repository contains uncommitted changes.",
            );
          }
          if (
            input.expectedWorkingTreeDigest != null &&
            input.expectedWorkingTreeDigest !== reviewed.digest
          ) {
            throw new RuntimeStateError(
              "working_tree_conflict",
              "The complete working tree changed after it was reviewed.",
            );
          }
          const transactionDirectory = PersonaRepository.operationTransactionDirectory(
            context.repository.root,
            restoreOperationId,
          );
          this.store.saveRepositoryOperation({
            id: restoreOperationId,
            personaId: persona.id,
            kind: "restore",
            payload: {
              checkpoint: selectedCheckpoint,
              discardChanges: false,
              expectedWorkingTreeDigest: reviewed.digest,
              transactionDirectory,
            },
            now: this.#now(),
          });
          await context.repository.restoreWithSnapshot(
            selectedCheckpoint,
            reviewed.digest,
            transactionDirectory,
          );
          this.#assertContextLease(persona.id, context);
        });
        startRestoreApplied = true;
        this.store.transaction(() => {
          this.store.updatePersona(persona.id, {
            currentCheckpoint: selectedCheckpoint,
            selectedCheckpoint,
            lifecycle: "ready",
          });
          this.store.completeRepositoryOperation(restoreOperationId, this.#now());
        });
        persona = this.#persona(persona.id);
      }
      if (input.promptLocale !== undefined) {
        const promptLocale = requirePromptLocale(input.promptLocale);
        persona = this.store.updatePersona(persona.id, { promptLocale });
      }
      const model = input.model ?? this.#defaultModel;
      if (!model) throw new RuntimeStateError("unavailable", "No model was selected for Start.");
      assertCredentialFree(JSON.stringify(model), "model selection");
      await this.#requireModel(model);
      run = this.store.createRun({
        personaId: persona.id,
        incarnation: this.incarnation,
        model,
        startingCheckpoint: requireCheckpoint(persona.selectedCheckpoint ?? persona.currentCheckpoint),
        now: this.#now(),
      });
      this.store.enqueue({
        runId: run.id,
        kind: "start",
        payload: { kind: "manual_start" },
        now: this.#now(),
      });
    } catch (error) {
      if (startRestoreOperationId && !startRestoreApplied) {
        const prepared = this.store
          .preparedRepositoryOperations()
          .some((operation) => operation.id === startRestoreOperationId);
        this.store.failRepositoryOperation(startRestoreOperationId, this.#now());
        if (prepared) this.store.updatePersona(persona.id, { lifecycle: "faulted" });
      }
      this.#releaseLease(persona.id, context);
      throw error;
    }
    this.#hDisabled.delete(persona.id);
    this.#startHWorker(persona.id, context);
    this.#startQueueWorker(persona.id, run.id, context);
    this.#observe(persona.id, "lifecycle", { phase: "running", runId: run.id, reason: null }, run.id);
    context.queueSignal.notify();
    return run;
  }

  async submitStimulus(input: {
    personaId: string;
    idempotencyKey?: string;
    kind: string;
    content: JsonValue;
    occurredAt?: string | null;
    source?: string | null;
  }): Promise<{ stimulusId: string; item: QueueItemFact }> {
    this.#assertOpen();
    const payload = {
      content: input.content,
      occurredAt: input.occurredAt ?? null,
      source: input.source ?? null,
    };
    (
      await captureCredentialSnapshot(this.credentialBoundary, "Runtime stimulus boundary")
    ).assertCredentialFree(
      JSON.stringify({
        idempotencyKey: input.idempotencyKey ?? null,
        kind: input.kind,
        payload,
      }),
      "stimulus boundary",
    );
    if (input.idempotencyKey !== undefined) {
      const replay = this.store.replayStimulus({
        personaId: input.personaId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        payload,
      });
      if (replay) return replay;
    }
    const run = this.#activeRun(input.personaId);
    if (
      run.incarnation !== this.incarnation ||
      run.phase === "stopping" ||
      run.phase === "forcing" ||
      run.phase === "faulted"
    ) {
      throw new RuntimeStateError("invalid_state", "The current run is not accepting new stimulus.");
    }
    const accepted = this.store.acceptStimulus({
      personaId: input.personaId,
      runId: run.id,
      kind: input.kind,
      payload,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      now: this.#now(),
    });
    this.#observe(
      input.personaId,
      "queue",
      {
        action: "accepted",
        workItemId: accepted.item.id,
        source: "stimulus",
        stimulusKind: input.kind,
      },
      run.id,
    );
    void this.#context(this.#persona(input.personaId)).then((context) => context.queueSignal.notify());
    return accepted;
  }

  async submitCallback(input: {
    personaId: string;
    callbackId: string;
    toolCallId: string;
    outcome: ToolCallbackOutcome;
  }): Promise<{ callbackId: string; recorded: boolean }> {
    this.#assertOpen();
    (
      await captureCredentialSnapshot(this.credentialBoundary, "Runtime callback boundary")
    ).assertCredentialFree(
      JSON.stringify({
        callbackId: input.callbackId,
        toolCallId: input.toolCallId,
        outcome: input.outcome,
      }),
      "callback boundary",
    );
    const call = this.store.requireToolCall(input.toolCallId);
    const event = this.store.requireEvent(call.eventId);
    if (event.personaId !== input.personaId) {
      throw new RuntimeStateError("not_found", "The ToolCall does not belong to this Persona.");
    }
    const outcome = toJson(input.outcome);
    const result = this.store.recordCallback({
      callbackId: input.callbackId,
      toolCallId: input.toolCallId,
      payload: outcome,
      status: input.outcome.state,
      now: this.#now(),
    });
    if (result.recorded) {
      this.#observe(
        input.personaId,
        "tool_callback",
        {
          toolCallId: input.toolCallId,
          callbackId: input.callbackId,
          outcome,
        },
        event.runId,
        event.id,
      );
      this.callbacks.notify(input.toolCallId);
    }
    return result;
  }

  pause(personaId: string): RunFact {
    const run = this.#activeRun(personaId);
    if (run.incarnation !== this.incarnation) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona run.");
    }
    if (run.phase === "pausing" || run.phase === "paused") return run;
    if (run.phase !== "running")
      throw new RuntimeStateError("invalid_state", "Pause requires a running Persona.");
    this.store.updateRun(run.id, { phase: "pausing" });
    this.store.updatePersona(personaId, { lifecycle: "pausing" });
    this.#observe(personaId, "lifecycle", { phase: "pausing", runId: run.id, reason: null }, run.id);
    void this.#context(this.#persona(personaId)).then((context) => context.queueSignal.notify());
    return this.store.requireRun(run.id);
  }

  async resume(personaId: string): Promise<RunFact> {
    const run = this.#activeRun(personaId);
    if (run.phase !== "paused") throw new RuntimeStateError("invalid_state", "Resume requires a paused run.");
    const context = await this.#context(this.#persona(personaId));
    if (!context.queuePromise || run.incarnation !== this.incarnation) {
      throw new RuntimeStateError("invalid_state", "The frozen queue no longer belongs to this process.");
    }
    this.store.updateRun(run.id, { phase: "running" });
    this.store.updatePersona(personaId, { lifecycle: "running" });
    this.#observe(personaId, "lifecycle", { phase: "running", runId: run.id, reason: "resume" }, run.id);
    context.queueSignal.notify();
    return this.store.requireRun(run.id);
  }

  async stop(personaId: string): Promise<RunFact> {
    const run = this.#activeRun(personaId);
    if (run.incarnation !== this.incarnation) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona run.");
    }
    if (run.phase === "stopping") return run;
    if (
      !(["running", "pausing", "paused"] as const).includes(run.phase as "running" | "pausing" | "paused")
    ) {
      throw new RuntimeStateError("invalid_state", "Stop requires an active run.");
    }
    const cutoff = this.store.maxQueueSequence(run.id);
    this.store.updateRun(run.id, { phase: "stopping", stopCutoffSequence: cutoff });
    this.store.updatePersona(personaId, { lifecycle: "stopping" });
    this.#observe(
      personaId,
      "lifecycle",
      { phase: "stopping", runId: run.id, reason: `cutoff:${cutoff}` },
      run.id,
    );
    const context = await this.#context(this.#persona(personaId));
    context.queueSignal.notify();
    return this.store.requireRun(run.id);
  }

  async force(personaId: string): Promise<RunFact> {
    const persona = this.#persona(personaId);
    const run = this.#activeRun(personaId);
    const context = await this.#context(persona);
    if (run.incarnation !== this.incarnation || !context.lease) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona run.");
    }
    this.#assertContextLease(personaId, context);
    const currentRun = this.store.requireRun(run.id);
    if (currentRun.phase === "forcing") {
      throw new RuntimeStateError("invalid_state", "Force termination is already in progress.");
    }
    this.store.updateRun(run.id, { phase: "forcing" });
    this.store.updatePersona(personaId, { lifecycle: "forcing" });
    this.#observe(personaId, "lifecycle", { phase: "forcing", runId: run.id, reason: null }, run.id);
    this.#hDisabled.add(personaId);
    context.queueController?.abort(new Error("Force termination"));
    context.hController?.abort(new Error("Force termination"));
    const interruptedHippocampusJobIds = this.store
      .listHippocampusJobs(personaId)
      .filter((job) => job.status === "running" || job.status === "applying")
      .map((job) => job.id);
    context.repository.invalidateWrites();
    this.#observeUnknownToolCalls(
      this.store.markDispatchingUnknown(this.#now(), run.id),
      "force_termination",
    );
    this.store.discardRunQueue(run.id, this.#now());
    const settled = await context.mutex.run(async () => {
      this.#assertContextLease(personaId, context);
      await this.#memory.recoverAll(
        async (candidateId) =>
          candidateId === personaId
            ? context.repository
            : PersonaRepository.open(this.#persona(candidateId).repositoryPath, this.credentialBoundary),
        new Set([personaId]),
      );
      this.store.recoverInterruptedHippocampusJobs(this.#now(), personaId);
      this.#assertContextLease(personaId, context);
      // An Event may have entered its Checkpoint boundary before cancellation.
      // Select only after that boundary has either completed or failed, while
      // holding the same repository mutex, so Repo and Persona facts cannot
      // disagree about which complete Checkpoint Force restores.
      const checkpoint = this.#persona(personaId).currentCheckpoint;
      if (!checkpoint) throw new RuntimeStateError("invalid_state", "Force requires a complete Checkpoint.");
      await context.repository.forceRestore(checkpoint);
      this.#assertContextLease(personaId, context);
      // Cancellation fences the old Event worker before it can publish or
      // create H work. Reconcile any obligation derived from a Checkpoint that
      // completed while Force was waiting; this never replays Persona or Tool.
      this.#reconcileCommittedObligations(personaId, this.#now());
      const requeued = this.store.requeueHippocampusAfterForce(
        personaId,
        this.#now(),
        interruptedHippocampusJobIds,
      );
      return { checkpoint, requeued };
    });
    for (const job of settled.requeued) {
      const event = this.store.requireEvent(job.eventId);
      this.#observe(
        personaId,
        "hippocampus",
        { ...hippocampusObservation(job, "queued"), error: { code: "force_restore" } },
        event.runId,
        event.id,
      );
    }
    this.store.updateRun(run.id, {
      phase: "forced",
      currentQueueItemId: null,
      waitingCode: null,
      endedAt: this.#now(),
    });
    this.store.updatePersona(personaId, {
      lifecycle: "forced",
      currentCheckpoint: settled.checkpoint,
      selectedCheckpoint: settled.checkpoint,
    });
    this.#releaseLease(personaId, context);
    this.#contexts.delete(personaId);
    this.#observe(personaId, "lifecycle", { phase: "stopped", runId: run.id, reason: "forced" }, run.id);
    return this.store.requireRun(run.id);
  }

  async restore(
    personaId: string,
    checkpoint: string,
    discardChanges: boolean,
    expectedWorkingTreeDigest: string | null = null,
  ): Promise<PersonaFact> {
    (
      await captureCredentialSnapshot(this.credentialBoundary, "Runtime Restore boundary")
    ).assertCredentialFree(
      JSON.stringify({ personaId, checkpoint, expectedWorkingTreeDigest }),
      "Restore input",
    );
    const persona = this.#persona(personaId);
    if (this.store.activeRun(personaId))
      throw new RuntimeStateError("invalid_state", "Restore requires an inactive Persona.");
    const context = await this.#context(persona);
    if (!this.#ensureLease(personaId, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    const operationId = randomUUID();
    let operationPrepared = false;
    let repositoryRestored = false;
    try {
      await context.mutex.run(async () => {
        this.#assertContextLease(personaId, context);
        await this.#registeredCheckpointInfo(personaId, checkpoint, context.repository);
        if (discardChanges) {
          this.store.saveRepositoryOperation({
            id: operationId,
            personaId,
            kind: "restore",
            payload: { checkpoint, discardChanges: true },
            now: this.#now(),
          });
          operationPrepared = true;
          await context.repository.restore(checkpoint, true);
        } else {
          const reviewed = await context.repository.stableWorkingTreeSnapshot();
          if (reviewed.dirty) {
            throw new RuntimeStateError(
              "working_tree_conflict",
              "The Persona repository contains uncommitted changes.",
            );
          }
          if (expectedWorkingTreeDigest !== null && expectedWorkingTreeDigest !== reviewed.digest) {
            throw new RuntimeStateError(
              "working_tree_conflict",
              "The complete working tree changed after it was reviewed.",
            );
          }
          const transactionDirectory = PersonaRepository.operationTransactionDirectory(
            context.repository.root,
            operationId,
          );
          this.store.saveRepositoryOperation({
            id: operationId,
            personaId,
            kind: "restore",
            payload: {
              checkpoint,
              discardChanges: false,
              expectedWorkingTreeDigest: reviewed.digest,
              transactionDirectory,
            },
            now: this.#now(),
          });
          operationPrepared = true;
          await context.repository.restoreWithSnapshot(checkpoint, reviewed.digest, transactionDirectory);
        }
        this.#assertContextLease(personaId, context);
      });
      repositoryRestored = true;
      return this.store.transaction(() => {
        const updated = this.store.updatePersona(personaId, {
          lifecycle: "ready",
          currentCheckpoint: checkpoint,
          selectedCheckpoint: checkpoint,
        });
        this.store.completeRepositoryOperation(operationId, this.#now());
        return updated;
      });
    } catch (error) {
      if (operationPrepared && !repositoryRestored) {
        this.store.failRepositoryOperation(operationId, this.#now());
        if (!discardChanges) this.store.updatePersona(personaId, { lifecycle: "faulted" });
      }
      throw error;
    } finally {
      this.#releaseLeaseIfIdle(personaId, context);
    }
  }

  async branch(personaId: string, checkpoint: string, branchName: string): Promise<void> {
    assertCredentialFree(branchName, "branch name");
    (
      await captureCredentialSnapshot(this.credentialBoundary, "Runtime branch boundary")
    ).assertCredentialFree(JSON.stringify({ personaId, checkpoint, branchName }), "branch input");
    const context = await this.#context(this.#persona(personaId));
    if (!this.#ensureLease(personaId, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    const operationId = this.store.saveRepositoryOperation({
      personaId,
      kind: "branch",
      payload: { checkpoint, branchName },
      now: this.#now(),
    });
    let branchCreated = false;
    try {
      await context.mutex.run(async () => {
        this.#assertContextLease(personaId, context);
        await this.#registeredCheckpointInfo(personaId, checkpoint, context.repository);
        await context.repository.createBranch(branchName, checkpoint);
        this.#assertContextLease(personaId, context);
      });
      branchCreated = true;
      this.store.completeRepositoryOperation(operationId, this.#now());
    } catch (error) {
      if (!branchCreated) this.store.failRepositoryOperation(operationId, this.#now());
      throw error;
    } finally {
      this.#releaseLeaseIfIdle(personaId, context);
    }
  }

  async clone(input: {
    personaId: string;
    checkpoint: string;
    newPersonaId?: string;
    displayName: string;
  }): Promise<PersonaFact> {
    const source = this.#persona(input.personaId);
    const context = await this.#context(source);
    const id = input.newPersonaId ?? randomUUID();
    assertPersonaId(id);
    if (id === source.id) {
      throw new RuntimeStateError("invalid_request", "A Clone must use a new Persona id.");
    }
    assertCredentialFree(id, "Persona id");
    if (input.displayName.trim() === "") {
      throw new RuntimeStateError("invalid_request", "Display name must not be empty.");
    }
    assertCredentialFree(input.displayName, "Persona display name");
    (await captureCredentialSnapshot(this.credentialBoundary, "Runtime clone boundary")).assertCredentialFree(
      JSON.stringify({ ...input, newPersonaId: id }),
      "clone input",
    );
    const destination = path.join(this.personaDirectory, id);
    await assertAuthorityDestination(
      destination,
      [this.stateDirectory, source.repositoryPath],
      "The Clone destination overlaps Runtime authority.",
    );
    if (!this.#ensureLease(source.id, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    const operationId = this.store.saveRepositoryOperation({
      personaId: source.id,
      kind: "clone",
      payload: {
        checkpoint: input.checkpoint,
        newPersonaId: id,
        displayName: input.displayName,
        destination,
        uiLocale: source.uiLocale,
        promptLocale: source.promptLocale,
      },
      now: this.#now(),
    });
    try {
      return await context.mutex.run(async () => {
        this.#assertContextLease(source.id, context);
        const checkpointInfo = await this.#registeredCheckpointInfo(
          source.id,
          input.checkpoint,
          context.repository,
        );
        const clone = await context.repository.cloneAt(
          input.checkpoint,
          destination,
          {},
          PersonaRepository.operationTransactionDirectory(destination, operationId),
        );
        await clone.assertExactCheckout(input.checkpoint);
        await assertAuthorityDestination(
          clone.root,
          [this.stateDirectory, context.repository.root],
          "The Clone destination overlaps Runtime authority.",
        );
        this.#assertContextLease(source.id, context);
        return this.store.adoptCloneOperation({
          operationId,
          sourcePersonaId: source.id,
          personaId: id,
          displayName: input.displayName,
          repositoryPath: clone.root,
          uiLocale: source.uiLocale,
          promptLocale: source.promptLocale,
          commit: input.checkpoint,
          summary: checkpointInfo.message,
          now: this.#now(),
        });
      });
    } catch (error) {
      // A destination that reached the filesystem remains as conflict
      // evidence. Deleting it after any validation would race Owner writes.
      this.store.failRepositoryOperation(operationId, this.#now());
      throw error;
    } finally {
      this.#releaseLeaseIfIdle(source.id, context);
    }
  }

  async deletePersona(
    personaId: string,
    confirmationPersonaId: string,
    discardChanges: boolean,
    expectedWorkingTreeDigest: string | null = null,
  ): Promise<void> {
    if (personaId !== confirmationPersonaId)
      throw new RuntimeStateError("invalid_request", "Delete confirmation does not match.");
    const persona = this.#persona(personaId);
    if (this.store.activeRun(personaId))
      throw new RuntimeStateError("invalid_state", "Delete requires an inactive Persona.");
    const context = await this.#context(persona);
    if (!this.#ensureLease(personaId, context)) {
      throw new RuntimeStateError("busy", "Another Kokoro process owns this Persona.");
    }
    let operationId: string | undefined;
    let repositoryDeleted = false;
    try {
      await context.mutex.run(async () => {
        this.#assertContextLease(personaId, context);
        if (discardChanges) {
          this.#hDisabled.add(personaId);
          context.hController?.abort(new Error("Persona deleted"));
          context.repository.invalidateWrites();
          await context.repository.drainWrites();
          operationId = this.store.saveRepositoryOperation({
            personaId,
            kind: "delete",
            payload: { repositoryPath: persona.repositoryPath, discardChanges: true },
            now: this.#now(),
          });
          await PersonaRepository.deleteExact(context.repository.root, persona.repositoryPath);
        } else {
          const reviewed = await context.repository.stableWorkingTreeSnapshot();
          if (reviewed.dirty) {
            throw new RuntimeStateError(
              "working_tree_conflict",
              "The Persona repository contains uncommitted changes.",
            );
          }
          if (expectedWorkingTreeDigest !== null && expectedWorkingTreeDigest !== reviewed.digest) {
            throw new RuntimeStateError(
              "working_tree_conflict",
              "The complete working tree changed after it was reviewed.",
            );
          }
          this.#hDisabled.add(personaId);
          context.hController?.abort(new Error("Persona deleted"));
          context.repository.invalidateWrites();
          await context.repository.drainWrites();
          const id = randomUUID();
          const transactionDirectory = PersonaRepository.operationTransactionDirectory(
            context.repository.root,
            id,
          );
          operationId = this.store.saveRepositoryOperation({
            id,
            personaId,
            kind: "delete",
            payload: {
              repositoryPath: persona.repositoryPath,
              discardChanges: false,
              expectedWorkingTreeDigest: reviewed.digest,
              transactionDirectory,
            },
            now: this.#now(),
          });
          await PersonaRepository.deleteExactWithSnapshot(
            context.repository.root,
            persona.repositoryPath,
            reviewed.digest,
            transactionDirectory,
            {},
            this.credentialBoundary,
          );
        }
        this.#assertContextLease(personaId, context);
      });
      repositoryDeleted = true;
      this.store.transaction(() => {
        this.store.settleDeletedPersonaObligations(personaId, this.#now());
        this.store.markPersonaDeleted(personaId, this.#now());
        this.store.completeRepositoryOperation(operationId as string, this.#now());
      });
      this.#releaseLease(personaId, context);
      this.#contexts.delete(personaId);
    } catch (error) {
      if (operationId && !repositoryDeleted) {
        this.store.failRepositoryOperation(operationId, this.#now());
        if (!discardChanges) this.store.updatePersona(personaId, { lifecycle: "faulted" });
      }
      this.#releaseLeaseIfIdle(personaId, context);
      throw error;
    }
  }

  async checkpoints(personaId: string, before: string | null, limit: number): Promise<CheckpointInfo[]> {
    const context = await this.#context(this.#persona(personaId));
    try {
      const registered = this.store.registeredCheckpoints(
        personaId,
        before,
        Math.max(1, Math.min(10_000, Math.floor(limit))),
      );
      if (!registered) {
        throw new RuntimeStateError("not_found", "The history cursor Checkpoint was not found.");
      }
      return await Promise.all(
        registered.map(async (checkpoint) => {
          const info = await context.repository.checkpointInfo(checkpoint.commit);
          return { ...info, message: checkpoint.summary };
        }),
      );
    } catch (error) {
      if (error instanceof RepositoryError && error.code === "invalid_checkpoint") {
        throw new RuntimeStateError("not_found", "The history cursor Checkpoint was not found.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async retryHippocampus(personaId: string, jobId: string): Promise<HippocampusJobFact> {
    const job = this.store.requireHippocampusJob(jobId);
    if (job.personaId !== personaId)
      throw new RuntimeStateError("not_found", "Hippocampus work was not found.");
    const context = await this.#context(this.#persona(personaId));
    const retried = context.hippocampus.retry(jobId);
    const event = this.store.requireEvent(retried.eventId);
    this.#observe(personaId, "hippocampus", hippocampusObservation(retried, "queued"), event.runId, event.id);
    this.#hDisabled.delete(personaId);
    this.#startHWorker(personaId, context);
    context.hSignal.notify();
    return retried;
  }

  observations(personaId: string, after: number, limit: number): ObservationFact[] {
    this.#persona(personaId);
    return this.store.observations(personaId, after, limit);
  }

  async authorityView(): Promise<RuntimeAuthorityView> {
    this.#assertOpen();
    return this.#authorityViewMutex.run(async () => {
      const sampleWorkingTrees = async () => {
        const entries = await Promise.all(
          this.store.listPersonas().map(async (persona) => {
            try {
              const repository = (await this.#context(persona)).repository;
              const snapshot = await repository.workingTreeSnapshot();
              return [
                persona.id,
                { state: snapshot.dirty ? "dirty" : "clean", digest: snapshot.digest },
              ] as const;
            } catch {
              return [persona.id, { state: "unknown", digest: null }] as const;
            }
          }),
        );
        return new Map<string, RuntimePersonaView["workingTree"]>(entries);
      };

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const workingTrees = await sampleWorkingTrees();
        const candidate = this.store.transaction(() => {
          const personas = this.store.listPersonas();
          const views = personas.map((persona): RuntimePersonaView => {
            const run = this.store.activeRun(persona.id) ?? null;
            const queue = run ? this.store.listQueue(run.id) : [];
            const activeEvent = run?.currentQueueItemId
              ? (this.store.eventForQueueItem(run.currentQueueItemId) ?? null)
              : null;
            return {
              persona,
              run,
              activeEvent,
              queue,
              latestCheckpoint: this.store.latestCheckpoint(persona.id) ?? null,
              workingTree: workingTrees.get(persona.id) ?? { state: "unknown", digest: null },
              publication: {
                pending: this.store.pendingPublicationCount(persona.id),
                delivering: 0,
                retryWaiting: 0,
                failed: 0,
              },
              hippocampus: this.store.listHippocampusJobs(persona.id),
            };
          });
          const authority = this.store.stampAuthoritySnapshot(authorityFingerprint(views), this.#now());
          return { revision: authority.revision, capturedAt: authority.updatedAt, personas: views };
        });
        const verifiedWorkingTrees = await sampleWorkingTrees();
        if (workingTreeMapsEqual(workingTrees, verifiedWorkingTrees)) return candidate;
      }
      throw new RuntimeStateError(
        "unavailable",
        "The working tree changed continuously while the authority snapshot was captured.",
      );
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const contexts = await Promise.all([...this.#contexts.values()]);
    for (const context of contexts) {
      context.queueController?.abort(new Error("Runtime closed"));
      context.hController?.abort(new Error("Runtime closed"));
      context.repository.invalidateWrites();
    }
    for (const run of this.store.activeRunsForIncarnation(this.incarnation)) {
      this.#observeUnknownToolCalls(this.store.markDispatchingUnknown(this.#now(), run.id), "runtime_closed");
      this.store.discardRunQueue(run.id, this.#now());
      this.store.updateRun(run.id, {
        phase: "crashed",
        currentQueueItemId: null,
        waitingCode: null,
        endedAt: this.#now(),
      });
      this.store.updatePersona(run.personaId, { lifecycle: "crashed" });
    }
    await Promise.allSettled(
      contexts.map(async (context) => {
        await context.mutex.run(async () => undefined);
        await context.repository.drainWrites();
      }),
    );
    for (const [personaId, context] of contexts.map(
      (context) => [this.#personaIdForContext(context), context] as const,
    )) {
      if (personaId) this.#releaseLease(personaId, context);
    }
    this.store.close();
  }

  async #recover(): Promise<void> {
    const now = this.#now();
    const staleRuns = this.store.staleActiveRuns(this.incarnation);
    const recoveryLeases = new Map<string, { ownerId: string; fence: number }>();
    for (const persona of this.store.listPersonas()) {
      if (persona.lifecycle === "forced") continue;
      const lease = this.store.acquireLease(persona.id, this.incarnation, process.pid, now);
      if (!lease.acquired) continue;
      const owned = { ownerId: this.incarnation, fence: lease.fence };
      recoveryLeases.set(persona.id, owned);
      this.#ownedLeases.set(persona.id, owned);
    }
    const repositoryOperationRecovery = await this.#recoverRepositoryOperations(recoveryLeases, now);
    const reconciledRepositoryOperations = repositoryOperationRecovery.reconciled;
    const leasedPersonaIds = new Set(
      [...recoveryLeases.keys()].filter((personaId) => this.store.getPersona(personaId) !== undefined),
    );
    const claimedPersonaIds = new Set(
      [...leasedPersonaIds].filter((personaId) => {
        const persona = this.store.getPersona(personaId);
        return (
          persona?.lifecycle !== "faulted" && !repositoryOperationRecovery.blockedPersonaIds.has(personaId)
        );
      }),
    );

    for (const persona of this.store
      .listPersonas()
      .filter((candidate) => claimedPersonaIds.has(candidate.id))) {
      try {
        const repository = await PersonaRepository.open(persona.repositoryPath, this.credentialBoundary);
        let before: string | null = null;
        for (;;) {
          const registered = this.store.registeredCheckpoints(persona.id, before, 10_000);
          if (!registered) throw new Error("The registered Checkpoint cursor is unavailable.");
          for (const checkpoint of registered) {
            await repository.ensureCheckpointRef(checkpoint.commit);
          }
          if (registered.length < 10_000) break;
          before = registered.at(-1)?.commit ?? null;
          if (before === null) break;
        }
      } catch {
        this.store.updatePersona(persona.id, { lifecycle: "faulted" });
        claimedPersonaIds.delete(persona.id);
        this.#observe(persona.id, "diagnostic", { code: "checkpoint_recovery_conflict" });
      }
    }

    for (const run of staleRuns.filter((candidate) => leasedPersonaIds.has(candidate.personaId))) {
      this.#observeUnknownToolCalls(
        this.store.markDispatchingUnknown(now, run.id),
        "runtime_recovered_after_crash",
      );
      this.store.discardRunQueue(run.id, now);
      this.store.updateRun(run.id, {
        phase: "crashed",
        currentQueueItemId: null,
        waitingCode: null,
        endedAt: now,
      });
      if (this.store.requirePersona(run.personaId).lifecycle !== "faulted") {
        this.store.updatePersona(run.personaId, { lifecycle: "crashed" });
      }
      this.#observe(run.personaId, "diagnostic", { code: "queue_not_restored", runId: run.id }, run.id);
    }
    for (const intent of this.store.allPreparedCheckpointIntents()) {
      if (!claimedPersonaIds.has(intent.personaId)) continue;
      const persona = this.store.getPersona(intent.personaId);
      if (!persona) {
        this.store.failCheckpointIntent(intent.id, now);
        continue;
      }
      try {
        const lease = recoveryLeases.get(persona.id);
        if (!lease) continue;
        this.store.assertLease(persona.id, lease.ownerId, lease.fence);
        const repository = await PersonaRepository.open(persona.repositoryPath, this.credentialBoundary);
        const plan = checkpointPlan(intent.plan);
        const laterRepositoryOperation = reconciledRepositoryOperations.get(persona.id);
        const preserveRestoredSelection =
          laterRepositoryOperation?.kind === "restore" &&
          laterRepositoryOperation.createdAt >= intent.createdAt &&
          (await repository.head()) !== plan.commit;
        if (preserveRestoredSelection) await repository.verifyAnchoredCheckpointPlan(plan);
        else await repository.advanceCheckpoint(plan);
        this.store.assertLease(persona.id, lease.ownerId, lease.fence);
        const event = intent.eventId === null ? null : this.store.requireEvent(intent.eventId);
        this.store.completeCheckpointIntent({
          intentId: intent.id,
          personaId: persona.id,
          ...(event === null ? {} : { eventId: event.id }),
          commit: plan.commit,
          summary: event?.summary ?? plan.message,
          root: intent.kind === "root",
          preservePersonaSelection: preserveRestoredSelection,
          now,
        });
      } catch {
        this.store.failCheckpointIntent(intent.id, now);
        this.store.updatePersona(persona.id, { lifecycle: "faulted" });
        claimedPersonaIds.delete(persona.id);
        this.#observe(persona.id, "diagnostic", { code: "checkpoint_recovery_conflict" });
      }
    }
    await this.#memory.recoverAll(async (personaId) => {
      const lease = recoveryLeases.get(personaId);
      if (!lease) throw new Error("Memory recovery requires a Persona writer lease.");
      this.store.assertLease(personaId, lease.ownerId, lease.fence);
      return PersonaRepository.open(this.#persona(personaId).repositoryPath, this.credentialBoundary);
    }, claimedPersonaIds);
    for (const personaId of claimedPersonaIds) {
      const lease = recoveryLeases.get(personaId);
      if (!lease) continue;
      this.store.assertLease(personaId, lease.ownerId, lease.fence);
      this.store.recoverInterruptedHippocampusJobs(now, personaId);
    }
    for (const persona of this.store
      .listPersonas()
      .filter((candidate) => claimedPersonaIds.has(candidate.id))) {
      for (const event of this.store
        .listEvents(persona.id)
        .filter((candidate) => candidate.status === "checkpointed")) {
        if (!this.store.observationExists(event.id, "event_committed")) {
          this.#observe(
            event.personaId,
            "event_committed",
            committedObservation(event),
            event.runId,
            event.id,
          );
        }
        const publication = this.store.publicationForEvent(event.id);
        if (publication && !this.store.observationExists(event.id, "publication")) {
          this.#observe(
            event.personaId,
            "publication",
            publicationObservation(event, publication.sequence, true),
            event.runId,
            event.id,
          );
        }
      }
    }
    for (const event of this.store
      .committedEventsMissingHippocampusJob()
      .filter((candidate) => claimedPersonaIds.has(candidate.personaId))) {
      const run = this.store.requireRun(event.runId);
      this.store.createHippocampusJob({
        personaId: event.personaId,
        eventId: event.id,
        sourceCheckpoint: event.checkpoint as string,
        model: run.model,
        promptLocale:
          this.store.promptLocaleForEvent(event.id) ?? this.#persona(event.personaId).promptLocale,
        now,
      });
    }
    for (const event of this.store
      .committedEventsMissingPublication()
      .filter((candidate) => claimedPersonaIds.has(candidate.personaId))) {
      const sequence = this.store.publishEvent(event.personaId, event.id, eventPublication(event), now);
      this.#observe(
        event.personaId,
        "publication",
        publicationObservation(event, sequence, true),
        event.runId,
        event.id,
      );
    }
    for (const persona of this.store
      .listPersonas()
      .filter((candidate) => claimedPersonaIds.has(candidate.id))) {
      for (const job of this.store.listHippocampusJobs(persona.id)) {
        const event = this.store.requireEvent(job.eventId);
        const latest = this.store.latestObservation(event.id, "hippocampus");
        const latestState = jsonField(latest?.payload, "state");
        const canonicalState = hippocampusPublicState(job);
        if (!latest || latestState !== canonicalState) {
          this.#observe(
            persona.id,
            "hippocampus",
            hippocampusObservation(job, canonicalState),
            event.runId,
            event.id,
          );
        }
      }
    }
    for (const persona of this.store
      .listPersonas()
      .filter((candidate) => claimedPersonaIds.has(candidate.id))) {
      const context = await this.#context(persona);
      const lease = recoveryLeases.get(persona.id);
      if (!lease) continue;
      context.lease = lease;
      this.#startHWorker(persona.id, context);
      context.hSignal.notify();
    }
  }

  async #context(persona: PersonaFact): Promise<PersonaContext> {
    let existing = this.#contexts.get(persona.id);
    if (!existing) {
      existing = (async () => {
        const repository = await PersonaRepository.open(persona.repositoryPath, this.credentialBoundary);
        const mutex = new AsyncMutex();
        const queueSignal = new AsyncSignal();
        const hSignal = new AsyncSignal();
        const engine = new EventEngine({
          store: this.store,
          providers: this.providers,
          tools: this.tools,
          authorization: this.#authorization,
          ...(this.#messageDelivery === undefined ? {} : { messageDelivery: this.#messageDelivery }),
          now: this.#now,
          ...(this.#eventFault === undefined ? {} : { fault: this.#eventFault }),
          repositoryMutex: mutex,
          callbacks: this.callbacks,
          onHippocampusQueued: () => hSignal.notify(),
          credentialBoundary: this.credentialBoundary,
        });
        const hippocampus = new HippocampusRunner({
          store: this.store,
          providers: this.providers,
          memory: this.#memory,
          repositoryMutex: mutex,
          now: this.#now,
          credentialBoundary: this.credentialBoundary,
          assertWriterLease: () => {
            const lease = this.#ownedLeases.get(persona.id);
            if (!lease) throw new Error("Persona writer lease is missing.");
            this.store.assertLease(persona.id, lease.ownerId, lease.fence);
          },
        });
        return { repository, mutex, engine, hippocampus, queueSignal, hSignal };
      })();
      this.#contexts.set(persona.id, existing);
    }
    return existing;
  }

  #reconcileCommittedObligations(personaId: string, now: number): void {
    const events = this.store
      .listEvents(personaId)
      .filter((candidate) => candidate.status === "checkpointed");
    for (const event of events) {
      if (!this.store.observationExists(event.id, "event_committed")) {
        this.#observe(event.personaId, "event_committed", committedObservation(event), event.runId, event.id);
      }
    }
    for (const event of this.store
      .committedEventsMissingHippocampusJob()
      .filter((candidate) => candidate.personaId === personaId)) {
      const run = this.store.requireRun(event.runId);
      this.store.createHippocampusJob({
        personaId: event.personaId,
        eventId: event.id,
        sourceCheckpoint: requireCheckpoint(event.checkpoint),
        model: run.model,
        promptLocale: this.store.promptLocaleForEvent(event.id) ?? this.#persona(personaId).promptLocale,
        now,
      });
    }
    for (const event of events) {
      const existing = this.store.publicationForEvent(event.id);
      if (existing) {
        if (!this.store.observationExists(event.id, "publication")) {
          this.#observe(
            event.personaId,
            "publication",
            publicationObservation(event, existing.sequence, true),
            event.runId,
            event.id,
          );
        }
        continue;
      }
      const sequence = this.store.publishEvent(event.personaId, event.id, eventPublication(event), now);
      this.#observe(
        event.personaId,
        "publication",
        publicationObservation(event, sequence, true),
        event.runId,
        event.id,
      );
    }
    for (const job of this.store.listHippocampusJobs(personaId)) {
      const event = this.store.requireEvent(job.eventId);
      const latest = this.store.latestObservation(event.id, "hippocampus");
      const canonicalState = hippocampusPublicState(job);
      if (!latest || jsonField(latest.payload, "state") !== canonicalState) {
        this.#observe(
          personaId,
          "hippocampus",
          hippocampusObservation(job, canonicalState),
          event.runId,
          event.id,
        );
      }
    }
  }

  async #recoverRepositoryOperations(
    leases: Map<string, { ownerId: string; fence: number }>,
    now: number,
  ): Promise<{
    reconciled: Map<string, { kind: "restore" | "delete"; createdAt: number }>;
    blockedPersonaIds: Set<string>;
  }> {
    const reconciled = new Map<string, { kind: "restore" | "delete"; createdAt: number }>();
    const blockedPersonaIds = new Set<string>();
    for (const operation of this.store.preparedRepositoryOperations()) {
      if (blockedPersonaIds.has(operation.personaId)) continue;
      const lease = leases.get(operation.personaId);
      if (!lease) continue;
      const source = this.store.getPersona(operation.personaId);
      if (!source) continue;
      try {
        this.store.assertLease(source.id, lease.ownerId, lease.fence);
        const payload = jsonObject(operation.payload, "repository operation");
        if (operation.kind === "restore") {
          const checkpoint = jsonString(payload["checkpoint"], "checkpoint");
          const discardChanges = jsonBoolean(payload["discardChanges"], "discardChanges");
          const registered = this.store.registeredCheckpoint(source.id, checkpoint);
          if (!registered) throw new Error("Restore recovery requires a registered Checkpoint.");
          if (discardChanges) {
            const repository = await PersonaRepository.open(source.repositoryPath, this.credentialBoundary);
            await repository.ensureCheckpointRef(checkpoint);
            await repository.restore(checkpoint, true);
          } else {
            await PersonaRepository.recoverRestoreExact(
              source.repositoryPath,
              source.repositoryPath,
              checkpoint,
              jsonString(payload["expectedWorkingTreeDigest"], "expectedWorkingTreeDigest"),
              jsonString(payload["transactionDirectory"], "transactionDirectory"),
              this.credentialBoundary,
            );
          }
          this.store.assertLease(source.id, lease.ownerId, lease.fence);
          this.store.transaction(() => {
            this.store.updatePersona(source.id, {
              lifecycle: "ready",
              currentCheckpoint: checkpoint,
              selectedCheckpoint: checkpoint,
            });
            this.store.completeRepositoryOperation(operation.id, now);
          });
          reconciled.set(source.id, { kind: "restore", createdAt: operation.createdAt });
        } else if (operation.kind === "branch") {
          const repository = await PersonaRepository.open(source.repositoryPath, this.credentialBoundary);
          const checkpoint = jsonString(payload["checkpoint"], "checkpoint");
          if (!this.store.registeredCheckpoint(source.id, checkpoint)) {
            throw new Error("Branch recovery requires a registered Checkpoint.");
          }
          await repository.ensureCheckpointRef(checkpoint);
          await repository.createBranch(jsonString(payload["branchName"], "branchName"), checkpoint);
          this.store.assertLease(source.id, lease.ownerId, lease.fence);
          this.store.completeRepositoryOperation(operation.id, now);
        } else if (operation.kind === "clone") {
          const repository = await PersonaRepository.open(source.repositoryPath, this.credentialBoundary);
          const checkpoint = jsonString(payload["checkpoint"], "checkpoint");
          const registered = this.store.registeredCheckpoint(source.id, checkpoint);
          if (!registered) throw new Error("Clone recovery requires a registered Checkpoint.");
          await repository.ensureCheckpointRef(checkpoint);
          const newPersonaId = jsonString(payload["newPersonaId"], "newPersonaId");
          assertPersonaId(newPersonaId);
          if (newPersonaId === source.id) throw new Error("Clone recovery requires a new Persona id.");
          const persistedDestination = path.resolve(
            jsonString(payload["destination"], "destination"),
          );
          const expectedDestination = path.resolve(path.join(this.personaDirectory, newPersonaId));
          if (
            path.basename(persistedDestination) !== newPersonaId ||
            !(await filesystemDirectoriesEqual(
              path.dirname(persistedDestination),
              this.personaDirectory,
            ))
          ) {
            throw new Error("Clone recovery destination does not match its Persona id.");
          }
          // Persisted Windows paths can use a filesystem-equivalent spelling
          // that differs from the canonical real path established on reopen.
          const destination = expectedDestination;
          await assertAuthorityDestination(
            destination,
            [this.stateDirectory, source.repositoryPath],
            "Clone recovery destination overlaps Runtime authority.",
          );
          const displayName = jsonString(payload["displayName"], "displayName");
          if (displayName.trim() === "") throw new Error("Clone recovery display name is empty.");
          const uiLocale = requireUiLocale(jsonString(payload["uiLocale"], "uiLocale"));
          const promptLocale = requirePromptLocale(jsonString(payload["promptLocale"], "promptLocale"));
          let clone: PersonaRepository;
          const transactionDirectory = PersonaRepository.operationTransactionDirectory(
            destination,
            operation.id,
          );
          if (await pathExists(path.join(transactionDirectory, "q"))) {
            clone = await PersonaRepository.recoverPartialCloneCheckout(
              destination,
              checkpoint,
              transactionDirectory,
              this.credentialBoundary,
            );
          } else if (await pathExists(destination)) {
            try {
              clone = await PersonaRepository.inspect(destination, this.credentialBoundary);
            } catch (error) {
              if (!(error instanceof RepositoryError) || error.code !== "not_initialized") throw error;
              clone = await PersonaRepository.initializeEmptyClone(destination, this.credentialBoundary);
            }
            await clone.ensureExactCheckout(checkpoint, repository.root, transactionDirectory);
          } else {
            clone = await repository.cloneAt(checkpoint, destination, {}, transactionDirectory);
          }
          await clone.assertExactCheckout(checkpoint);
          await assertAuthorityDestination(
            clone.root,
            [this.stateDirectory, repository.root],
            "Clone recovery destination overlaps Runtime authority.",
          );
          this.store.assertLease(source.id, lease.ownerId, lease.fence);
          this.store.adoptCloneOperation({
            operationId: operation.id,
            sourcePersonaId: source.id,
            personaId: newPersonaId,
            displayName,
            repositoryPath: destination,
            uiLocale,
            promptLocale,
            commit: checkpoint,
            summary: registered.summary,
            now,
          });
        } else {
          const repositoryPath = jsonString(payload["repositoryPath"], "repositoryPath");
          const discardChanges = jsonBoolean(payload["discardChanges"], "discardChanges");
          if (discardChanges) {
            if (await pathExists(repositoryPath)) {
              await PersonaRepository.deleteExact(repositoryPath, source.repositoryPath);
            }
          } else {
            await PersonaRepository.deleteExactWithSnapshot(
              repositoryPath,
              source.repositoryPath,
              jsonString(payload["expectedWorkingTreeDigest"], "expectedWorkingTreeDigest"),
              jsonString(payload["transactionDirectory"], "transactionDirectory"),
              {},
              this.credentialBoundary,
            );
          }
          this.store.assertLease(source.id, lease.ownerId, lease.fence);
          this.store.transaction(() => {
            this.store.settleDeletedPersonaObligations(source.id, now);
            this.store.markPersonaDeleted(source.id, now);
            this.store.completeRepositoryOperation(operation.id, now);
          });
          this.store.releaseLease(source.id, lease.ownerId, lease.fence);
          this.#ownedLeases.delete(source.id);
          leases.delete(source.id);
          reconciled.set(source.id, { kind: "delete", createdAt: operation.createdAt });
        }
      } catch {
        this.store.failRepositoryOperation(operation.id, now);
        if (operation.kind === "restore" || operation.kind === "delete") {
          this.store.updatePersona(source.id, { lifecycle: "faulted" });
          blockedPersonaIds.add(source.id);
        }
        this.#observe(source.id, "diagnostic", {
          code: "repository_operation_recovery_conflict",
          operationId: operation.id,
          operationKind: operation.kind,
        });
      }
    }
    return { reconciled, blockedPersonaIds };
  }

  #startQueueWorker(personaId: string, runId: string, context: PersonaContext): void {
    if (context.queuePromise)
      throw new RuntimeStateError("invalid_state", "A queue worker is already active.");
    const controller = new AbortController();
    context.queueController = controller;
    const promise = this.#queueLoop(personaId, runId, context, controller.signal).finally(() => {
      if (context.queuePromise === promise) {
        delete context.queuePromise;
        delete context.queueController;
      }
    });
    void promise.catch(() => {
      // The loop records operational failures itself. Shutdown and Force
      // deliberately detach cancellation from the process rejection channel.
    });
    context.queuePromise = promise;
  }

  async #queueLoop(
    personaId: string,
    runId: string,
    context: PersonaContext,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const run = this.store.requireRun(runId);
      if (
        run.phase === "forced" ||
        run.phase === "forcing" ||
        run.phase === "crashed" ||
        run.phase === "faulted" ||
        run.phase === "stopped"
      )
        return;
      if (run.phase === "pausing") {
        this.store.updateRun(run.id, { phase: "paused", currentQueueItemId: null, waitingCode: null });
        this.store.updatePersona(personaId, { lifecycle: "paused" });
        this.#observe(personaId, "lifecycle", { phase: "paused", runId, reason: null }, runId);
        continue;
      }
      if (run.phase === "paused") {
        await context.queueSignal.wait(signal);
        continue;
      }
      const item = this.store.nextQueued(runId);
      if (!item) {
        if (run.phase === "stopping") {
          this.store.updateRun(run.id, {
            phase: "stopped",
            currentQueueItemId: null,
            waitingCode: null,
            endedAt: this.#now(),
          });
          this.store.updatePersona(personaId, { lifecycle: "stopped" });
          this.#releaseLeaseIfIdle(personaId, context);
          this.#observe(personaId, "lifecycle", { phase: "stopped", runId, reason: null }, runId);
          return;
        }
        await context.queueSignal.wait(signal);
        continue;
      }
      if (run.phase === "stopping" && item.sequence > (run.stopCutoffSequence ?? 0)) {
        this.store.discardRunQueue(runId, this.#now());
        continue;
      }
      try {
        const lease = context.lease;
        if (!lease) throw new Error("Runtime lease is missing.");
        this.store.assertLease(personaId, lease.ownerId, lease.fence);
        this.store.markQueueStarted(item.id, this.#now());
        this.store.updateRun(run.id, { currentQueueItemId: item.id, waitingCode: null });
        this.#observe(personaId, "queue", { action: "activated", workItemId: item.id }, runId);
        const result = await context.engine.process({
          persona: this.#persona(personaId),
          run: this.store.requireRun(run.id),
          item,
          repository: context.repository,
          signal,
        });
        // Force/close owns the terminal queue facts after cancellation. A late
        // Event continuation must not turn a discarded work item back into a
        // completed item or append observations after termination returns.
        if (signal.aborted || this.store.requireRun(run.id).phase === "forcing") return;
        this.store.markQueueCompleted(item.id, this.#now());
        this.store.updateRun(run.id, { currentQueueItemId: null, waitingCode: null });
        this.#observe(
          personaId,
          "queue",
          { action: "completed", workItemId: item.id },
          runId,
          result.event.id,
        );
        const current = this.store.requireRun(run.id);
        if (result.continuation && (current.phase === "running" || current.phase === "pausing")) {
          const continuation = this.store.enqueue({
            runId,
            kind: "continuation",
            payload: { focus: result.continuation.focus },
            sourceEventId: result.event.id,
            sourceToolCallId: result.continuation.sourceToolCallId,
            now: this.#now(),
          });
          this.#observe(
            personaId,
            "queue",
            {
              action: current.phase === "pausing" ? "frozen" : "accepted",
              workItemId: continuation.id,
              source: "continuation",
            },
            runId,
            result.event.id,
          );
        }
        context.hSignal.notify();
      } catch (error) {
        if (signal.aborted) return;
        const event = this.store.eventForQueueItem(item.id);
        if (event) this.store.faultEvent(event.id, this.#now());
        this.store.updateRun(run.id, {
          phase: "faulted",
          currentQueueItemId: null,
          waitingCode: null,
          fault: { code: safeRuntimeCode(error) },
          endedAt: this.#now(),
        });
        this.store.updatePersona(personaId, { lifecycle: "faulted" });
        this.#releaseLeaseIfIdle(personaId, context);
        this.#observe(
          personaId,
          "diagnostic",
          { code: safeRuntimeCode(error), severity: "error" },
          runId,
          event?.id,
        );
        return;
      }
    }
  }

  #startHWorker(personaId: string, context: PersonaContext): void {
    if (this.#hDisabled.has(personaId) || context.hPromise) return;
    const controller = new AbortController();
    context.hController = controller;
    const promise = this.#hLoop(personaId, context, controller.signal).finally(() => {
      if (context.hPromise === promise) {
        delete context.hPromise;
        delete context.hController;
      }
    });
    void promise.catch(() => {
      // Lifecycle cancellation is already handled by the worker loop.
    });
    context.hPromise = promise;
  }

  async #hLoop(personaId: string, context: PersonaContext, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted || this.#hDisabled.has(personaId)) return;
      try {
        if (!this.store.hasRunnableHippocampusWork(personaId)) {
          this.#releaseLeaseIfIdle(personaId, context);
          await context.hSignal.wait(signal);
          continue;
        }
        if (!this.#ensureLease(personaId, context)) {
          await context.hSignal.wait(signal, 250);
          continue;
        }
        if (await context.hippocampus.runNext(personaId, context.repository, signal)) continue;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof MemoryTransactionRecoveryRequiredError) {
          const lease = context.lease;
          if (!lease) throw new Error("Memory recovery requires a Persona writer lease.");
          await context.mutex.run(async () => {
            this.store.assertLease(personaId, lease.ownerId, lease.fence);
            await this.#memory.recoverAll(
              async (id) => PersonaRepository.open(this.#persona(id).repositoryPath, this.credentialBoundary),
              new Set([personaId]),
            );
            this.store.assertLease(personaId, lease.ownerId, lease.fence);
            this.store.recoverInterruptedHippocampusJobs(this.#now(), personaId);
          });
          continue;
        }
        this.#observe(personaId, "diagnostic", { code: safeRuntimeCode(error), severity: "error" });
      }
      this.#releaseLeaseIfIdle(personaId, context);
      await context.hSignal.wait(signal, 250);
    }
  }

  #activeRun(personaId: string): RunFact {
    this.#persona(personaId);
    const run = this.store.activeRun(personaId);
    if (!run) throw new RuntimeStateError("invalid_state", "The Persona has no active run.");
    return run;
  }

  #persona(id: string): PersonaFact {
    const persona = this.store.getPersona(id);
    if (!persona) throw new RuntimeStateError("not_found", "Persona was not found.");
    return persona;
  }

  async #registeredCheckpointInfo(
    personaId: string,
    checkpoint: string,
    repository: PersonaRepository,
  ): Promise<CheckpointInfo> {
    const registered = this.store.registeredCheckpoint(personaId, checkpoint);
    if (!registered) {
      throw new RuntimeStateError("not_found", "The Checkpoint is not registered for this Persona.");
    }
    try {
      const info = await repository.checkpointInfo(checkpoint);
      return { ...info, message: registered.summary };
    } catch (error) {
      if (error instanceof RepositoryError && error.code === "invalid_checkpoint") {
        throw new RuntimeStateError("not_found", "The registered Checkpoint is unavailable.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async #requireModel(model: ModelRef): Promise<void> {
    const provider = this.providers.require(model);
    const before = await captureCredentialSnapshot(
      this.credentialBoundary,
      "Runtime Provider capability boundary",
    );
    const capabilities = await provider.listModels();
    before.assertCredentialFree(JSON.stringify(capabilities), "Provider capabilities");
    (
      await captureCredentialSnapshot(this.credentialBoundary, "Runtime Provider capability boundary")
    ).assertCredentialFree(JSON.stringify(capabilities), "Provider capabilities");
    const capability = capabilities.find((candidate) => candidate.model === model.model);
    if (!capability || !capability.authenticated)
      throw new RuntimeStateError("unavailable", "The selected model is unavailable.");
  }

  #observe(personaId: string, kind: string, payload: JsonValue, runId?: string, eventId?: string): void {
    this.store.appendObservation({
      personaId,
      ...(runId === undefined ? {} : { runId }),
      ...(eventId === undefined ? {} : { eventId }),
      kind,
      payload,
      now: this.#now(),
    });
  }

  #observeUnknownToolCalls(calls: readonly ToolCallFact[], reason: string): void {
    for (const call of calls) {
      const event = this.store.requireEvent(call.eventId);
      this.#observe(
        event.personaId,
        "tool_outcome",
        {
          toolCallId: call.id,
          dispatchId: `dispatch-${call.id}`,
          state: "unknown",
          externalEffect: "unknown",
          result: null,
          code: "external_outcome_unknown",
          reason,
        },
        event.runId,
        event.id,
      );
    }
  }

  #releaseLease(personaId: string, context: PersonaContext): void {
    const lease = context.lease;
    if (!lease) return;
    this.store.releaseLease(personaId, lease.ownerId, lease.fence);
    this.#ownedLeases.delete(personaId);
    delete context.lease;
  }

  #ensureLease(personaId: string, context: PersonaContext): boolean {
    if (context.lease) {
      try {
        this.store.assertLease(personaId, context.lease.ownerId, context.lease.fence);
        return true;
      } catch {
        this.#ownedLeases.delete(personaId);
        delete context.lease;
      }
    }
    const lease = this.store.acquireLease(personaId, this.incarnation, process.pid, this.#now());
    if (!lease.acquired) return false;
    context.lease = { ownerId: this.incarnation, fence: lease.fence };
    this.#ownedLeases.set(personaId, context.lease);
    return true;
  }

  #assertContextLease(personaId: string, context: PersonaContext): void {
    const lease = context.lease;
    if (!lease) throw new Error("Persona writer lease is missing.");
    this.store.assertLease(personaId, lease.ownerId, lease.fence);
  }

  #releaseLeaseIfIdle(personaId: string, context: PersonaContext): void {
    const run = this.store.activeRun(personaId);
    if (
      run?.incarnation === this.incarnation &&
      (run.phase === "running" ||
        run.phase === "pausing" ||
        run.phase === "paused" ||
        run.phase === "stopping" ||
        run.phase === "forcing")
    )
      return;
    if (this.store.hasRunnableHippocampusWork(personaId)) return;
    this.#releaseLease(personaId, context);
  }

  #releaseOwnedLeases(): void {
    for (const [personaId, lease] of this.#ownedLeases) {
      this.store.releaseLease(personaId, lease.ownerId, lease.fence);
    }
    this.#ownedLeases.clear();
  }

  #personaIdForContext(context: PersonaContext): string | undefined {
    return this.store
      .listPersonas()
      .find((persona) => path.resolve(persona.repositoryPath) === context.repository.root)?.id;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RuntimeStateError("invalid_state", "The Kokoro Runtime is closed.");
  }
}

function requireUiLocale(locale: string): UiLocale {
  if (!isSupportedLocale(locale))
    throw new RuntimeStateError("invalid_request", `Unsupported UI locale: ${locale}`);
  return locale;
}

function requirePromptLocale(locale: string): PromptLocale {
  if (!isSupportedLocale(locale))
    throw new RuntimeStateError("invalid_request", `Unsupported Prompt locale: ${locale}`);
  return locale;
}

function assertPersonaId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) {
    throw new RuntimeStateError("invalid_request", "Persona id must be a portable identifier.");
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return isInside(relativeLeft) || isInside(relativeRight);
}

async function prepareAuthorityDirectories(
  stateDirectory: string,
  personaDirectory: string,
): Promise<{ stateDirectory: string; personaDirectory: string }> {
  const resolvedState = path.resolve(stateDirectory);
  const resolvedPersona = path.resolve(personaDirectory);
  if (pathsOverlap(resolvedState, resolvedPersona)) {
    throw separateAuthorityDirectoriesError();
  }
  try {
    // Materialize both roots before comparing them. This lets the filesystem,
    // rather than a platform guess, decide case and Unicode name equivalence.
    await mkdir(resolvedState, { recursive: true });
    await mkdir(resolvedPersona, { recursive: true });
    const [stateIdentity, personaIdentity] = await Promise.all([
      filesystemDirectoryIdentity(resolvedState),
      filesystemDirectoryIdentity(resolvedPersona),
    ]);
    if (await filesystemDirectoriesOverlap(stateIdentity, personaIdentity)) {
      throw separateAuthorityDirectoriesError();
    }
    return {
      stateDirectory: stateIdentity.realPath,
      personaDirectory: personaIdentity.realPath,
    };
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError(
      "invalid_request",
      "Runtime authority directories could not be established safely.",
      { cause: error },
    );
  }
}

function separateAuthorityDirectoriesError(): RuntimeStateError {
  return new RuntimeStateError(
    "invalid_request",
    "Runtime state and Persona repositories must use separate directories.",
  );
}

async function assertAuthorityDestination(
  destination: string,
  protectedDirectories: readonly string[],
  overlapMessage: string,
): Promise<void> {
  try {
    const overlaps = await Promise.all(
      protectedDirectories.map((protectedDirectory) =>
        filesystemPathOverlapsDirectory(destination, protectedDirectory),
      ),
    );
    if (overlaps.some(Boolean)) {
      throw new RuntimeStateError("invalid_request", overlapMessage);
    }
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError(
      "invalid_request",
      "The Runtime authority destination could not be validated safely.",
      { cause: error },
    );
  }
}

function isInside(relative: string): boolean {
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function checkpointPlan(value: JsonValue): CheckpointPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid checkpoint plan.");
  const parent = value["parent"];
  if (
    value["version"] !== 1 ||
    (parent !== null && typeof parent !== "string") ||
    typeof value["tree"] !== "string" ||
    typeof value["commit"] !== "string" ||
    typeof value["message"] !== "string" ||
    typeof value["timestamp"] !== "string"
  ) {
    throw new Error("Invalid checkpoint plan.");
  }
  return {
    version: 1,
    parent,
    tree: value["tree"],
    commit: value["commit"],
    message: value["message"],
    timestamp: value["timestamp"],
  };
}

function eventPublication(event: EventFact): JsonValue {
  return {
    version: 1,
    eventId: event.id,
    personaId: event.personaId,
    sequence: event.sequence,
    committed: true,
    checkpoint: event.checkpoint,
    summary: event.summary,
    sourceKind: event.sourceKind,
    internalEvidence: event.frozen,
    memoryDecision: event.memoryDecision,
    checkpointedAt: event.checkpointedAt,
  };
}

function committedObservation(event: EventFact): JsonValue {
  const checkpoint = requireCheckpoint(event.checkpoint);
  const summary = event.summary ?? "Committed Event";
  const timestamp = new Date(event.checkpointedAt ?? event.createdAt).toISOString();
  return {
    eventId: event.id,
    sourceWorkItemIds: [event.queueItemId],
    summary,
    needsMemory: event.memoryDecision === "maintain",
    checkpoint: {
      checkpointId: checkpoint,
      commitId: checkpoint,
      summary,
      createdAt: timestamp,
    },
    committedAt: timestamp,
    reconciled: true,
  };
}

function publicationObservation(event: EventFact, sequence: number, reconciled: boolean): JsonValue {
  return {
    publicationId: `publication-${sequence}`,
    eventId: event.id,
    checkpointId: requireCheckpoint(event.checkpoint),
    state: "delivered",
    attempt: 1,
    retryAt: null,
    receipt: { cursor: sequence },
    error: null,
    reconciled,
  };
}

type HippocampusPublicState = "queued" | "running" | "applied" | "retry_wait" | "failed" | "conflict";

function hippocampusPublicState(job: HippocampusJobFact): HippocampusPublicState {
  if (job.status === "completed") return "applied";
  if (job.status === "failed") return "failed";
  if (job.status === "conflict") return "conflict";
  if (job.status === "retry") return "retry_wait";
  if (job.status === "running" || job.status === "applying") return "running";
  return "queued";
}

function hippocampusObservation(
  job: HippocampusJobFact,
  state: HippocampusPublicState,
): Record<string, JsonValue> {
  return {
    jobId: job.id,
    eventId: job.eventId,
    checkpointId: job.sourceCheckpoint,
    state,
    attempt: job.attempts,
    retryAt: null,
    error: job.error,
    reconciled: true,
  };
}

function jsonField(value: JsonValue | undefined, field: string): JsonValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value[field] : undefined;
}

function jsonObject(value: JsonValue, name: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function jsonString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a string.`);
  return value;
}

function jsonBoolean(value: JsonValue | undefined, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`);
  return value;
}

function authorityFingerprint(views: readonly RuntimePersonaView[]): string {
  return createHash("sha256").update(JSON.stringify(views)).digest("hex");
}

function workingTreeMapsEqual(
  left: ReadonlyMap<string, RuntimePersonaView["workingTree"]>,
  right: ReadonlyMap<string, RuntimePersonaView["workingTree"]>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [personaId, snapshot] of left) {
    const candidate = right.get(personaId);
    if (!candidate || candidate.state !== snapshot.state || candidate.digest !== snapshot.digest)
      return false;
  }
  return true;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function safeRuntimeCode(error: unknown): string {
  if (error instanceof RuntimeStateError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "runtime_operation_failed";
}

function requireCheckpoint(checkpoint: string | null): string {
  if (checkpoint === null) throw new RuntimeStateError("invalid_state", "A complete Checkpoint is required.");
  return checkpoint;
}
