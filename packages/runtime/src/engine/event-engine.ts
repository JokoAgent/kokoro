import { randomUUID } from "node:crypto";
import type { AsyncMutex } from "../async.js";
import type { CallbackCoordinator, RecordedToolCallback } from "../callbacks.js";
import {
  agentValidationText,
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  buildCloseoutPrompt,
  buildCompactionPrompt,
  buildPersonaPrompt,
  builtinToolText,
  emptyDocumentsText,
  isSupportedLocale,
  type PromptLocale,
  renderBuiltinToolResult,
} from "../i18n/index.js";
import { MemoryTransactionRecoveryRequiredError } from "../memory/index.js";
import type {
  JsonValue,
  ModelCapability,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ProviderRegistry,
} from "../model.js";
import { StructuredOutputError } from "../model.js";
import type { PersonaRepository } from "../repository/index.js";
import { parseCloseoutDecision, parseCompactionDecision } from "../roles/index.js";
import { assertCredentialFree, type CredentialBoundary, captureCredentialSnapshot } from "../security.js";
import {
  estimateRequestTokens,
  formatCloseoutCausalFacts,
  formatCloseoutEventEvidence,
  formatCompactionSessionHistory,
  formatDocuments,
  formatPersonaCausalFacts,
  formatPersonaStimulus,
  requestFact,
  responseFact,
  sessionEntriesForCompaction,
  sessionMessages,
} from "../session/index.js";
import type {
  EventFact,
  PersonaFact,
  QueueItemFact,
  RunFact,
  RuntimeFactStore,
  ToolCallFact,
} from "../store/index.js";
import type {
  AuthorizationPolicy,
  MessageDelivery,
  RuntimeTool,
  ToolExecutionResult,
  ToolRegistry,
} from "../tools/index.js";

export type RuntimeFaultPoint =
  | "before_checkpoint"
  | "checkpoint_intent_recorded"
  | "checkpoint_ref_advanced"
  | "checkpoint_fact_completed"
  | "before_publication"
  | "publication_completed"
  | "hippocampus_job_created";

export interface EventEngineOptions {
  store: RuntimeFactStore;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  authorization: AuthorizationPolicy;
  messageDelivery?: MessageDelivery;
  now?: () => number;
  maxModelAttempts?: number;
  maxPersonaTurns?: number;
  compactAtRatio?: number;
  fault?: (point: RuntimeFaultPoint) => Promise<void> | void;
  repositoryMutex?: AsyncMutex;
  callbacks?: CallbackCoordinator;
  onHippocampusQueued?: () => void;
  credentialBoundary: CredentialBoundary;
}

export interface ProcessedEvent {
  event: EventFact;
  continuation: { sourceToolCallId: string; focus: string | null } | null;
}

export class RuntimeExecutionError extends Error {
  readonly code:
    | "aborted"
    | "checkpoint_required"
    | "context_too_large"
    | "credential_detected"
    | "model_failed"
    | "model_unavailable"
    | "persona_turn_limit"
    | "structured_output_failed";

  constructor(code: RuntimeExecutionError["code"], message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeExecutionError";
    this.code = code;
  }
}

class RetryableModelOutputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RetryableModelOutputError";
    this.code = code;
  }
}

export class EventEngine {
  readonly #store: RuntimeFactStore;
  readonly #providers: ProviderRegistry;
  readonly #tools: ToolRegistry;
  readonly #authorization: AuthorizationPolicy;
  readonly #messageDelivery: MessageDelivery | undefined;
  readonly #now: () => number;
  readonly #maxModelAttempts: number;
  readonly #maxPersonaTurns: number;
  readonly #compactAtRatio: number;
  readonly #fault: EventEngineOptions["fault"] | undefined;
  readonly #repositoryMutex: AsyncMutex | undefined;
  readonly #callbacks: CallbackCoordinator | undefined;
  readonly #onHippocampusQueued: (() => void) | undefined;
  readonly #credentialBoundary: CredentialBoundary;

  constructor(options: EventEngineOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#tools = options.tools;
    this.#authorization = options.authorization;
    this.#messageDelivery = options.messageDelivery;
    this.#now = options.now ?? Date.now;
    this.#maxModelAttempts = clampInteger(options.maxModelAttempts ?? 3, 1, 10);
    this.#maxPersonaTurns = clampInteger(options.maxPersonaTurns ?? 32, 1, 256);
    this.#compactAtRatio = Math.max(0.4, Math.min(0.95, options.compactAtRatio ?? 0.72));
    this.#fault = options.fault;
    this.#repositoryMutex = options.repositoryMutex;
    this.#callbacks = options.callbacks;
    this.#onHippocampusQueued = options.onHippocampusQueued;
    this.#credentialBoundary = options.credentialBoundary;
    if (this.#maxModelAttempts < 1) throw new Error("maxModelAttempts must be positive.");
  }

  async process(input: {
    persona: PersonaFact;
    run: RunFact;
    item: QueueItemFact;
    repository: PersonaRepository;
    signal: AbortSignal;
  }): Promise<ProcessedEvent> {
    const locale = requirePromptLocale(input.persona.promptLocale);
    const { provider, capability } = await this.#model(input.run);
    input.signal.throwIfAborted();
    const event = this.#store.createEvent({
      personaId: input.persona.id,
      run: input.run,
      item: input.item,
      now: this.#now(),
    });
    const source = sourceFact(input.item, this.#store);
    this.#store.appendSessionEntry({
      sessionId: input.run.sessionId,
      eventId: event.id,
      kind: "user",
      payload: {
        content: JSON.stringify(source),
        dynamicPersonaInstruction: true,
      },
      now: this.#now(),
    });

    const continuation = await this.#runPersona({
      ...input,
      event,
      locale,
      provider,
      capability,
      source,
    });
    const frozen = this.#freezeEvidence(event, source);
    this.#store.freezeEvent(event.id, frozen, this.#now());

    const closeoutPersona = this.#store.requirePersona(input.persona.id);
    const closeoutLocale = requirePromptLocale(closeoutPersona.promptLocale);
    const closeout = await this.#runCloseout({
      persona: closeoutPersona,
      run: input.run,
      event,
      locale: closeoutLocale,
      provider,
      capability,
      frozen,
      signal: input.signal,
    });
    assertCredentialFree(closeout.summary, "Event summary");
    this.#store.closeEvent(event.id, closeout.summary, closeout.memory, this.#now());

    const checkpoint = async () => {
      // Entering the shared Repository mutex is the first termination fence.
      // Preparing a commit is still speculative: Force may cancel it without
      // creating a durable intent or advancing Repo/Persona/Event state.
      input.signal.throwIfAborted();
      const pendingMemoryTransaction = this.#store.pendingMemoryTransaction(input.persona.id);
      if (pendingMemoryTransaction !== undefined) {
        throw new MemoryTransactionRecoveryRequiredError(pendingMemoryTransaction);
      }
      const plan = await input.repository.prepareCheckpoint(
        closeout.summary,
        new Date(this.#now()).toISOString(),
      );
      input.signal.throwIfAborted();
      // The synchronously persisted intent is the Checkpoint linearization
      // point. Once it exists, recovery requires this worker to finish the
      // Repo -> Persona/Event boundary even if Force has just cancelled it.
      const intentId = this.#store.saveCheckpointIntent({
        personaId: input.persona.id,
        eventId: event.id,
        kind: "event",
        commit: plan.commit,
        plan: responseFact(plan),
        now: this.#now(),
      });
      await this.#fault?.("checkpoint_intent_recorded");
      await input.repository.advanceCheckpoint(plan);
      await this.#fault?.("checkpoint_ref_advanced");
      this.#store.completeCheckpointIntent({
        intentId,
        personaId: input.persona.id,
        eventId: event.id,
        commit: plan.commit,
        summary: closeout.summary,
        root: false,
        now: this.#now(),
      });
      await this.#fault?.("checkpoint_fact_completed");
      return plan;
    };
    await this.#fault?.("before_checkpoint");
    const plan = this.#repositoryMutex ? await this.#repositoryMutex.run(checkpoint) : await checkpoint();
    input.signal.throwIfAborted();

    const committed = this.#store.requireEvent(event.id);
    const observationContext = { persona: input.persona, run: input.run, event };
    this.#observe(observationContext, "event_committed", {
      eventId: committed.id,
      sourceWorkItemIds: [committed.queueItemId],
      summary: committed.summary ?? closeout.summary,
      needsMemory: committed.memoryDecision === "maintain",
      checkpoint: {
        checkpointId: plan.commit,
        commitId: plan.commit,
        summary: committed.summary ?? closeout.summary,
        createdAt: plan.timestamp,
      },
      committedAt: new Date(committed.checkpointedAt ?? this.#now()).toISOString(),
    });
    if (closeout.memory === "maintain") {
      input.signal.throwIfAborted();
      const job = this.#store.createHippocampusJob({
        personaId: input.persona.id,
        eventId: event.id,
        sourceCheckpoint: plan.commit,
        model: input.run.model,
        promptLocale: requirePromptLocale(this.#store.requirePersona(input.persona.id).promptLocale),
        now: this.#now(),
      });
      this.#observe(observationContext, "hippocampus", {
        jobId: job.id,
        eventId: committed.id,
        checkpointId: plan.commit,
        state: "queued",
        attempt: job.attempts,
        retryAt: null,
        error: null,
      });
      await this.#fault?.("hippocampus_job_created");
      this.#onHippocampusQueued?.();
      input.signal.throwIfAborted();
    }
    await this.#fault?.("before_publication");
    input.signal.throwIfAborted();
    const publicationSequence = this.#store.publishEvent(
      input.persona.id,
      event.id,
      publicationFact(committed),
      this.#now(),
    );
    this.#observe(observationContext, "publication", {
      publicationId: `publication-${publicationSequence}`,
      eventId: committed.id,
      checkpointId: plan.commit,
      state: "delivered",
      attempt: 1,
      retryAt: null,
      receipt: { cursor: publicationSequence },
      error: null,
    });
    await this.#fault?.("publication_completed");
    return { event: committed, continuation };
  }

  async #runPersona(input: {
    persona: PersonaFact;
    run: RunFact;
    item: QueueItemFact;
    event: EventFact;
    repository: PersonaRepository;
    locale: PromptLocale;
    provider: ModelProvider;
    capability: ModelCapability;
    source: JsonValue;
    signal: AbortSignal;
  }): Promise<ProcessedEvent["continuation"]> {
    for (let turnNumber = 1; turnNumber <= this.#maxPersonaTurns; turnNumber += 1) {
      input.signal.throwIfAborted();
      const locale = requirePromptLocale(this.#store.requirePersona(input.persona.id).promptLocale);
      const [personaDocuments, memoryDocuments] = await Promise.all([
        input.repository.readPersonaDocuments(),
        input.repository.readMemoryDocuments(),
      ]);
      const emptyDocuments = emptyDocumentsText(locale);
      const personaText = formatDocuments(personaDocuments, emptyDocuments);
      const memoryText = formatDocuments(memoryDocuments, emptyDocuments);
      (await captureCredentialSnapshot(this.#credentialBoundary)).assertCredentialFree(
        `${personaText}\n${memoryText}`,
        "Persona Context",
      );
      const causalFacts = formatPersonaCausalFacts(this.#store.toolCallsForPersona(input.persona.id));
      const prompt = buildPersonaPrompt(locale, {
        personaDocuments: personaText,
        memoryDocuments: memoryText,
        stimulus: formatPersonaStimulus(input.source),
        causalFacts,
      });

      await this.#compactIfNeeded({
        ...input,
        locale,
        prompt,
        causalFacts,
      });
      const maxOutputTokens = input.capability.maxOutputTokens;
      const completedCall = await this.#callModel({
        persona: input.persona,
        run: input.run,
        event: input.event,
        provider: input.provider,
        capability: input.capability,
        role: "persona",
        signal: input.signal,
        createRequest: (attemptLocale) => {
          const attemptPrompt = buildPersonaPrompt(attemptLocale, {
            personaDocuments: formatDocuments(personaDocuments, emptyDocumentsText(attemptLocale)),
            memoryDocuments: formatDocuments(memoryDocuments, emptyDocumentsText(attemptLocale)),
            stimulus: formatPersonaStimulus(input.source),
            causalFacts,
          });
          const messages = sessionMessages(this.#store.sessionEntries(input.run.sessionId), {
            eventId: input.event.id,
            instruction: attemptPrompt.instruction,
            promptLocale: attemptLocale,
          });
          const tools = this.#tools.list().map((tool) => tool.describe(attemptLocale));
          assertFits(input.capability, attemptPrompt.system, messages, tools, maxOutputTokens);
          return {
            id: randomUUID(),
            role: "persona",
            model: input.run.model,
            promptLocale: attemptLocale,
            system: attemptPrompt.system,
            messages,
            tools,
            maxOutputTokens,
            continuation: turnNumber > 1,
          };
        },
        validate: (response) => {
          if (response.stopReason === "length") throw new RetryableModelOutputError("response_truncated");
          const ids = new Set<string>();
          for (const call of response.toolCalls) {
            if (call.id.trim() === "" || ids.has(call.id)) {
              throw new RetryableModelOutputError("duplicate_or_empty_tool_call_id");
            }
            ids.add(call.id);
          }
          return response;
        },
      });
      const result = completedCall.value;
      this.#store.appendSessionEntry({
        sessionId: input.run.sessionId,
        eventId: input.event.id,
        kind: "assistant",
        payload: {
          content: result.text,
          ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
          ...(result.toolCalls.length === 0 ? {} : { toolCalls: responseFact(result.toolCalls) }),
        },
        now: this.#now(),
      });
      if (result.toolCalls.length === 0) return null;
      const continuation = await this.#executeToolBatch({
        ...input,
        locale: completedCall.locale,
        response: result,
        attemptId: completedCall.attemptId,
        turnId: completedCall.turnId,
      });
      if (continuation !== null) return continuation;
    }
    throw new RuntimeExecutionError("persona_turn_limit");
  }

  async #executeToolBatch(input: {
    persona: PersonaFact;
    run: RunFact;
    event: EventFact;
    repository: PersonaRepository;
    locale: PromptLocale;
    response: ModelResponse;
    attemptId: string;
    turnId: string;
    signal: AbortSignal;
  }): Promise<ProcessedEvent["continuation"]> {
    const planned: Array<{ fact: ToolCallFact; tool?: RuntimeTool; validationCode?: string }> = [];
    for (const call of input.response.toolCalls) {
      const tool = this.#tools.get(call.name);
      let validationCode: string | undefined;
      if (!tool) validationCode = "tool_unavailable";
      else {
        try {
          tool.validate(call.arguments);
        } catch {
          validationCode = "tool_arguments_invalid";
        }
      }
      const fact = this.#store.proposeToolCall({
        eventId: input.event.id,
        turnId: input.turnId,
        providerCallId: call.id,
        name: call.name,
        arguments: call.arguments,
        effect: tool?.effect ?? "none",
        now: this.#now(),
      });
      this.#observe(input, "tool_proposal", {
        attemptId: input.attemptId,
        toolCallId: fact.id,
        providerCallId: fact.providerCallId,
        toolName: fact.name,
        arguments: fact.arguments,
        proposedAt: fact.proposedAt,
      });
      planned.push({
        fact,
        ...(tool === undefined ? {} : { tool }),
        ...(validationCode === undefined ? {} : { validationCode }),
      });
    }

    let continuation: ProcessedEvent["continuation"] = null;
    for (const item of planned) {
      input.signal.throwIfAborted();
      if (!item.tool || item.validationCode !== undefined) {
        const result = { code: item.validationCode ?? "tool_unavailable" };
        this.#store.setToolCallState(item.fact.id, "failed", { result, now: this.#now() });
        this.#observe(input, "tool_outcome", {
          toolCallId: item.fact.id,
          dispatchId: `dispatch-${item.fact.id}`,
          state: "failed",
          externalEffect: "none",
          result,
        });
        this.#appendToolResult(input, item.fact, result, true);
        continue;
      }
      const authorizationRequest = {
        personaId: input.persona.id,
        runId: input.run.id,
        eventId: input.event.id,
        toolCallId: item.fact.id,
        toolName: item.tool.name,
        arguments: item.fact.arguments,
        effect: item.tool.effect,
      } as const;
      const proposalCredentials = await captureCredentialSnapshot(
        this.#credentialBoundary,
        "Authorization proposal boundary",
      );
      input.signal.throwIfAborted();
      proposalCredentials.assertCredentialFree(JSON.stringify(authorizationRequest), "authorization request");
      const initial = await this.#authorization.authorize(authorizationRequest);
      input.signal.throwIfAborted();
      proposalCredentials.assertCredentialFree(JSON.stringify(initial), "authorization decision");
      (await captureCredentialSnapshot(this.#credentialBoundary)).assertCredentialFree(
        JSON.stringify(initial),
        "authorization decision",
      );
      input.signal.throwIfAborted();
      this.#store.recordAuthorizationDecision({
        toolCallId: item.fact.id,
        stage: "proposal",
        allow: initial.allow,
        revision: initial.revision,
        ...(initial.reason === undefined ? {} : { reason: initial.reason }),
        now: this.#now(),
      });
      if (!initial.allow) {
        const result = { code: "permission_denied" };
        this.#store.setToolCallState(item.fact.id, "blocked", {
          authorizationRevision: initial.revision,
          result,
          now: this.#now(),
        });
        this.#observe(input, "tool_dispatch", {
          toolCallId: item.fact.id,
          dispatchId: `dispatch-${item.fact.id}`,
          intentId: `intent-${item.fact.id}`,
          state: "blocked",
          authorizationRevision: initial.revision,
          externalEffect: item.tool.effect === "external" ? "possible" : "none",
          code: "permission_denied",
          authority: authorityDecisionFacts(this.#store, item.fact.id),
        });
        this.#appendToolResult(input, item.fact, result, true);
        continue;
      }
      this.#store.setToolCallState(item.fact.id, "intent_recorded", {
        authorizationRevision: initial.revision,
        now: this.#now(),
      });
      const dispatchCredentials = await captureCredentialSnapshot(
        this.#credentialBoundary,
        "Authorization dispatch boundary",
      );
      input.signal.throwIfAborted();
      dispatchCredentials.assertCredentialFree(JSON.stringify(authorizationRequest), "authorization request");
      const dispatchDecision = await this.#authorization.authorize(authorizationRequest);
      input.signal.throwIfAborted();
      dispatchCredentials.assertCredentialFree(JSON.stringify(dispatchDecision), "authorization decision");
      (await captureCredentialSnapshot(this.#credentialBoundary)).assertCredentialFree(
        JSON.stringify(dispatchDecision),
        "authorization decision",
      );
      input.signal.throwIfAborted();
      this.#store.recordAuthorizationDecision({
        toolCallId: item.fact.id,
        stage: "dispatch",
        allow: dispatchDecision.allow,
        revision: dispatchDecision.revision,
        ...(dispatchDecision.reason === undefined ? {} : { reason: dispatchDecision.reason }),
        now: this.#now(),
      });
      if (!dispatchDecision.allow) {
        const result = { code: "permission_revoked_before_dispatch" };
        this.#store.setToolCallState(item.fact.id, "blocked", {
          authorizationRevision: dispatchDecision.revision,
          result,
          now: this.#now(),
        });
        this.#observe(input, "tool_dispatch", {
          toolCallId: item.fact.id,
          dispatchId: `dispatch-${item.fact.id}`,
          intentId: `intent-${item.fact.id}`,
          state: "blocked",
          authorizationRevision: dispatchDecision.revision,
          externalEffect: item.tool.effect === "external" ? "possible" : "none",
          code: "permission_revoked_before_dispatch",
          authority: authorityDecisionFacts(this.#store, item.fact.id),
        });
        this.#appendToolResult(input, item.fact, result, true);
        continue;
      }
      this.#store.setToolCallState(item.fact.id, "dispatching", {
        authorizationRevision: dispatchDecision.revision,
        now: this.#now(),
      });
      this.#observe(input, "tool_dispatch", {
        toolCallId: item.fact.id,
        dispatchId: `dispatch-${item.fact.id}`,
        intentId: `intent-${item.fact.id}`,
        state: "dispatched",
        authorizationRevision: dispatchDecision.revision,
        externalEffect: item.tool.effect === "external" ? "possible" : "none",
        authority: authorityDecisionFacts(this.#store, item.fact.id),
      });
      try {
        const executionCredentials = await captureCredentialSnapshot(
          this.#credentialBoundary,
          "Tool execution boundary",
        );
        input.signal.throwIfAborted();
        executionCredentials.assertCredentialFree(
          JSON.stringify(item.fact.arguments),
          "Tool execution input",
        );
        const execution = await item.tool.execute(item.fact.arguments, {
          personaId: input.persona.id,
          runId: input.run.id,
          eventId: input.event.id,
          toolCallId: item.fact.id,
          repository: toolRepositoryAccess(input.repository),
          signal: input.signal,
          ...(this.#messageDelivery === undefined ? {} : { messageDelivery: this.#messageDelivery }),
        });
        input.signal.throwIfAborted();
        const persisted = executionFact(execution);
        executionCredentials.assertCredentialFree(JSON.stringify(persisted), "Tool execution result");
        const postExecutionCredentials = await captureCredentialSnapshot(this.#credentialBoundary);
        input.signal.throwIfAborted();
        postExecutionCredentials.assertCredentialFree(JSON.stringify(persisted), "Tool execution result");
        if (execution.callbackPending) {
          this.#store.setToolCallState(item.fact.id, "awaiting_callback", {
            dispatchResult: persisted,
            now: this.#now(),
          });
          this.#observe(input, "tool_dispatch", {
            toolCallId: item.fact.id,
            dispatchId: `dispatch-${item.fact.id}`,
            intentId: `intent-${item.fact.id}`,
            state: "dispatched",
            authorizationRevision: dispatchDecision.revision,
            externalEffect: item.tool.effect === "external" ? "possible" : "none",
            receipt: persisted,
            authority: authorityDecisionFacts(this.#store, item.fact.id),
          });
          if (!this.#callbacks) {
            const unavailable = { code: "callback_channel_unavailable" };
            this.#store.setToolCallState(item.fact.id, "unknown", { result: unavailable, now: this.#now() });
            this.#observe(input, "tool_outcome", {
              toolCallId: item.fact.id,
              dispatchId: `dispatch-${item.fact.id}`,
              state: "unknown",
              externalEffect: "unknown",
              result: null,
              code: "callback_channel_unavailable",
            });
            this.#appendToolResult(input, item.fact, unavailable, true);
            continue;
          }
          this.#store.updateRun(input.run.id, { waitingCode: `tool_callback:${item.fact.id}` });
          let callback: RecordedToolCallback;
          try {
            callback = await this.#callbacks.wait(item.fact.id, input.signal);
            input.signal.throwIfAborted();
          } finally {
            if (!input.signal.aborted) this.#store.updateRun(input.run.id, { waitingCode: null });
          }
          input.signal.throwIfAborted();
          const callbackError = callbackState(callback.payload) !== "succeeded";
          this.#appendToolResult(input, item.fact, callback.payload, callbackError);
        } else {
          this.#store.setToolCallState(item.fact.id, "succeeded", { result: persisted, now: this.#now() });
          this.#observe(input, "tool_outcome", {
            toolCallId: item.fact.id,
            dispatchId: `dispatch-${item.fact.id}`,
            state: "succeeded",
            externalEffect: item.tool.effect === "external" ? "confirmed" : "none",
            result: persisted,
          });
          this.#appendToolResult(input, item.fact, persisted, false);
        }
        if (
          item.fact.name === "continue_experience" &&
          !execution.callbackPending &&
          execution.continuation !== undefined &&
          continuation === null
        ) {
          continuation = { sourceToolCallId: item.fact.id, focus: execution.continuation.focus };
        }
      } catch (error) {
        // Force owns the terminal ToolCall/Run facts. An old worker must not
        // translate cancellation into a late Tool outcome or Session entry.
        input.signal.throwIfAborted();
        const recordedCallback = this.#store.callbackForToolCall(item.fact.id);
        if (recordedCallback) {
          if (!input.signal.aborted) {
            this.#appendToolResult(
              input,
              item.fact,
              recordedCallback.payload,
              callbackState(recordedCallback.payload) !== "succeeded",
            );
          }
          continue;
        }
        const currentCall = this.#store.requireToolCall(item.fact.id);
        if (currentCall.status === "unknown") {
          if (!input.signal.aborted) {
            this.#appendToolResult(
              input,
              item.fact,
              currentCall.result ?? { code: "external_outcome_unknown" },
              true,
            );
          }
          continue;
        }
        const status = item.tool.effect === "external" ? "unknown" : "failed";
        const result = { code: status === "unknown" ? "external_outcome_unknown" : safeErrorCode(error) };
        this.#store.setToolCallState(item.fact.id, status, { result, now: this.#now() });
        this.#observe(input, "tool_outcome", {
          toolCallId: item.fact.id,
          dispatchId: `dispatch-${item.fact.id}`,
          state: status,
          externalEffect: status === "unknown" ? "unknown" : "none",
          result: status === "unknown" ? null : result,
          code: result.code,
        });
        this.#appendToolResult(input, item.fact, result, true);
      }
    }
    return continuation;
  }

  #appendToolResult(
    input: { run: RunFact; event: EventFact; locale: PromptLocale },
    call: ToolCallFact,
    result: JsonValue,
    isError: boolean,
  ): void {
    const raw = JSON.stringify(result);
    const content = isBuiltinToolName(call.name)
      ? renderBuiltinToolResult(input.locale, call.name, raw)
      : raw;
    this.#store.appendSessionEntry({
      sessionId: input.run.sessionId,
      eventId: input.event.id,
      kind: "tool",
      payload: {
        content,
        rawResult: result,
        toolName: call.name,
        toolCallId: call.providerCallId,
        ...(isError ? { isError: true } : {}),
      },
      now: this.#now(),
    });
  }

  async #compactIfNeeded(input: {
    persona: PersonaFact;
    run: RunFact;
    event: EventFact;
    locale: PromptLocale;
    provider: ModelProvider;
    capability: ModelCapability;
    prompt: { system: string; instruction: string };
    causalFacts: string;
    signal: AbortSignal;
  }): Promise<void> {
    for (let pass = 0; pass < 32; pass += 1) {
      const entries = this.#store.sessionEntries(input.run.sessionId);
      const messages = sessionMessages(entries, {
        eventId: input.event.id,
        instruction: input.prompt.instruction,
        promptLocale: input.locale,
      });
      const tools = this.#tools.list().map((tool) => tool.describe(input.locale));
      const estimate = estimateRequestTokens({
        system: input.prompt.system,
        messages,
        tools,
        maxOutputTokens: input.capability.maxOutputTokens,
      });
      if (estimate <= input.capability.contextWindow * this.#compactAtRatio || entries.length < 3) return;

      let selected = sessionEntriesForCompaction(entries);
      if (selected.filter((entry) => entry.kind !== "compaction").length === 0) return;
      const historyFor = (source: typeof selected): string => formatCompactionSessionHistory(source);
      const fitsCompaction = (history: string): boolean => {
        const prompt = buildCompactionPrompt(input.locale, {
          sessionHistory: history,
          causalFacts: input.causalFacts,
          validationError: "",
        });
        return (
          estimateRequestTokens({
            system: prompt.system,
            messages: [{ role: "user", content: prompt.instruction }],
            tools: [],
            maxOutputTokens: input.capability.maxOutputTokens,
          }) <= input.capability.contextWindow
        );
      };
      let history = historyFor(selected);
      while (!fitsCompaction(history) && selected.length > 1) {
        const summaryPrefix = selected[0]?.kind === "compaction" ? selected.slice(0, 1) : [];
        const raw = selected.slice(summaryPrefix.length);
        if (raw.length <= 1) break;
        selected = [...summaryPrefix, ...raw.slice(0, Math.max(1, Math.ceil(raw.length / 2)))];
        history = historyFor(selected);
      }
      if (!fitsCompaction(history)) {
        throw new RuntimeExecutionError("context_too_large", "compaction_source_too_large");
      }

      let validationFailure: unknown = null;
      const completedCall = await this.#callModel({
        persona: input.persona,
        run: input.run,
        event: input.event,
        provider: input.provider,
        capability: input.capability,
        role: "compaction",
        signal: input.signal,
        createRequest: (attemptLocale) => {
          const prompt = buildCompactionPrompt(attemptLocale, {
            sessionHistory: history,
            causalFacts: input.causalFacts,
            validationError:
              validationFailure === null ? "" : safeValidationMessage(attemptLocale, validationFailure),
          });
          const request: ModelRequest = {
            id: randomUUID(),
            role: "compaction",
            model: input.run.model,
            promptLocale: attemptLocale,
            system: prompt.system,
            messages: [{ role: "user", content: prompt.instruction }],
            tools: [],
            maxOutputTokens: input.capability.maxOutputTokens,
            continuation: false,
          };
          assertFits(
            input.capability,
            request.system,
            request.messages,
            request.tools,
            request.maxOutputTokens ?? input.capability.maxOutputTokens,
          );
          return request;
        },
        validate: (response, _attemptLocale) => {
          if (response.stopReason === "length" || response.toolCalls.length > 0) {
            validationFailure = new RetryableModelOutputError("compaction_response_contract_invalid");
            throw validationFailure;
          }
          try {
            return parseCompactionDecision(response.text);
          } catch (error) {
            validationFailure = error;
            throw error;
          }
        },
      });
      const rawSequences = selected
        .filter((entry) => entry.kind !== "compaction")
        .map((entry) => entry.sequence);
      this.#store.appendSessionEntry({
        sessionId: input.run.sessionId,
        kind: "compaction",
        payload: {
          summary: completedCall.value.summary,
          causalFacts: input.causalFacts,
          coversThrough: Math.max(...rawSequences),
        },
        now: this.#now(),
      });
    }
    throw new RuntimeExecutionError("context_too_large", "compaction_pass_limit_reached");
  }

  async #runCloseout(input: {
    persona: PersonaFact;
    run: RunFact;
    event: EventFact;
    locale: PromptLocale;
    provider: ModelProvider;
    capability: ModelCapability;
    frozen: JsonValue;
    signal: AbortSignal;
  }): Promise<{ summary: string; memory: "none" | "maintain" }> {
    const causalFacts = formatCloseoutCausalFacts(this.#store.toolCallsForEvent(input.event.id));
    let validationFailure: unknown = null;
    return (
      await this.#callModel({
        ...input,
        role: "closeout",
        createRequest: (attemptLocale) => {
          const prompt = buildCloseoutPrompt(attemptLocale, {
            eventEvidence: formatCloseoutEventEvidence(input.frozen),
            causalFacts,
            validationError:
              validationFailure === null ? "" : safeValidationMessage(attemptLocale, validationFailure),
          });
          const request: ModelRequest = {
            id: randomUUID(),
            role: "closeout",
            model: input.run.model,
            promptLocale: attemptLocale,
            system: prompt.system,
            messages: [{ role: "user", content: prompt.instruction }],
            tools: [],
            maxOutputTokens: input.capability.maxOutputTokens,
            continuation: false,
          };
          assertFits(
            input.capability,
            request.system,
            request.messages,
            request.tools,
            request.maxOutputTokens ?? input.capability.maxOutputTokens,
          );
          return request;
        },
        validate: (response) => {
          if (response.stopReason === "length" || response.toolCalls.length > 0) {
            validationFailure = new RetryableModelOutputError("closeout_response_contract_invalid");
            throw validationFailure;
          }
          try {
            return parseCloseoutDecision(response.text);
          } catch (error) {
            validationFailure = error;
            throw error;
          }
        },
      })
    ).value;
  }

  async #callModel<T>(input: {
    persona: PersonaFact;
    run: RunFact;
    event: EventFact;
    provider: ModelProvider;
    capability: ModelCapability;
    role: "persona" | "closeout" | "compaction";
    signal: AbortSignal;
    createRequest: (locale: PromptLocale) => ModelRequest;
    validate: (response: ModelResponse, locale: PromptLocale) => T;
  }): Promise<{ value: T; attemptId: string; turnId: string; locale: PromptLocale }> {
    const initialLocale = requirePromptLocale(this.#store.requirePersona(input.persona.id).promptLocale);
    const turnId = this.#store.createTurn({
      eventId: input.role === "persona" ? input.event.id : null,
      sourceEventId: input.event.id,
      scope: input.role === "persona" ? "event" : input.role,
      sessionId: input.run.sessionId,
      role: input.role,
      startingCheckpoint: requireEventStartingCheckpoint(input.persona),
      promptLocale: initialLocale,
      now: this.#now(),
    });
    let lastError: unknown;
    let turnTerminal = false;
    try {
      for (let attempt = 1; attempt <= this.#maxModelAttempts; attempt += 1) {
        let attemptId: string | undefined;
        let providerStarted = false;
        let request: ModelRequest | undefined;
        try {
          input.signal.throwIfAborted();
          const attemptLocale = requirePromptLocale(
            this.#store.requirePersona(input.persona.id).promptLocale,
          );
          request = input.createRequest(attemptLocale);
          const requestCredentials = await captureCredentialSnapshot(
            this.#credentialBoundary,
            "Event model boundary",
          );
          requestCredentials.assertCredentialFree(JSON.stringify(requestFact(request)), "model request");
          attemptId = this.#store.createModelAttempt({
            turnId,
            attempt,
            request: requestFact(request),
            now: this.#now(),
          });
          this.#observe(input, "model_request", {
            attemptId,
            turnId,
            attempt,
            role: input.role,
            request: requestFact(request),
          });
          this.#observe(input, "provider_attempt", {
            attemptId,
            turnId,
            attempt,
            providerId: request.model.provider,
            modelId: request.model.model,
            state: "started",
            retryAt: null,
            error: null,
          });
          providerStarted = true;
          input.signal.throwIfAborted();
          let acceptingStreams = true;
          let streamChain = Promise.resolve();
          let response: ModelResponse;
          try {
            response = await settleProviderCall(
              input.provider.complete(request, {
                signal: input.signal,
                emit: (event) => {
                  // Stream acceptance closes with the Provider call. Retained
                  // callbacks and Force-late fragments cannot append new facts.
                  if (!acceptingStreams || input.signal.aborted) return;
                  const accepted = event;
                  streamChain = streamChain.then(async () => {
                    requestCredentials.assertCredentialFree(
                      JSON.stringify(responseFact(accepted)),
                      "Provider stream",
                    );
                    const credentials = await captureCredentialSnapshot(
                      this.#credentialBoundary,
                      "Event Provider stream boundary",
                    );
                    credentials.assertCredentialFree(
                      JSON.stringify(responseFact(accepted)),
                      "Provider stream",
                    );
                    if (!input.signal.aborted)
                      this.#observeStream(input, attemptId as string, turnId, attempt, accepted);
                  });
                  return streamChain;
                },
              }),
              input.signal,
            );
          } finally {
            acceptingStreams = false;
            await streamChain;
          }
          input.signal.throwIfAborted();
          requestCredentials.assertCredentialFree(
            JSON.stringify(responseFact(response)),
            "Provider response",
          );
          (
            await captureCredentialSnapshot(this.#credentialBoundary, "Event model boundary")
          ).assertCredentialFree(JSON.stringify(responseFact(response)), "Provider response");
          const parsed = input.validate(response, attemptLocale);
          this.#store.completeModelAttempt(attemptId, responseFact(response), this.#now());
          this.#observe(input, "model_attempt_completed", {
            attemptId,
            turnId,
            attempt,
            role: input.role,
            response: responseFact(response),
          });
          if (response.reasoning) {
            this.#observe(input, "internal_cognition", {
              attemptId,
              channel: "reasoning",
              content: response.reasoning,
              attemptState: "completed",
              externalMessage: false,
            });
          }
          if (response.text) {
            this.#observe(input, "internal_cognition", {
              attemptId,
              channel: "assistant",
              content: response.text,
              attemptState: "completed",
              externalMessage: false,
            });
          }
          this.#observe(input, "provider_attempt", {
            attemptId,
            turnId,
            attempt,
            providerId: request.model.provider,
            modelId: request.model.model,
            state: "completed",
            retryAt: null,
            error: null,
          });
          if (response.usage) {
            this.#observe(input, "usage", {
              attemptId,
              inputTokens: response.usage.inputTokens ?? 0,
              outputTokens: response.usage.outputTokens ?? 0,
              cachedInputTokens: 0,
            });
          }
          this.#store.completeTurn(turnId, "completed", this.#now());
          turnTerminal = true;
          return { value: parsed, attemptId, turnId, locale: attemptLocale };
        } catch (error) {
          const aborted = input.signal.aborted;
          if (attemptId === undefined) {
            if (aborted) throw new RuntimeExecutionError("aborted", "aborted");
            throw error;
          }
          lastError = error;
          const code = aborted ? "aborted" : safeErrorCode(error);
          this.#store.failModelAttempt(attemptId, code, this.#now());
          this.#observe(input, "model_attempt_failed", {
            attemptId,
            turnId,
            attempt,
            role: input.role,
            code,
          });
          if (!providerStarted) {
            if (aborted) throw new RuntimeExecutionError("aborted", "aborted");
            throw error;
          }
          if (aborted) {
            this.#observe(input, "provider_attempt", {
              attemptId,
              turnId,
              attempt,
              providerId: request?.model.provider ?? input.run.model.provider,
              modelId: request?.model.model ?? input.run.model.model,
              state: "aborted",
              retryAt: null,
              error: { code },
            });
            throw new RuntimeExecutionError("aborted", "aborted");
          }
          let classification: ReturnType<NonNullable<ModelProvider["classifyError"]>> | undefined;
          let classifierFailed = false;
          try {
            const candidate = input.provider.classifyError?.(error) as unknown;
            if (
              candidate === undefined ||
              candidate === "transient" ||
              candidate === "permanent" ||
              candidate === "unknown_outcome"
            ) {
              classification = candidate;
            } else {
              classifierFailed = true;
            }
          } catch {
            // Provider classifiers are untrusted extension code. Their failure
            // is terminal and their error object never crosses a fact boundary.
            classifierFailed = true;
          }
          const outputError =
            error instanceof StructuredOutputError || error instanceof RetryableModelOutputError;
          const willRetry =
            !classifierFailed &&
            attempt < this.#maxModelAttempts &&
            (classification !== "permanent" || outputError);
          const retryAt = willRetry ? new Date(this.#now()).toISOString() : null;
          this.#observe(input, "provider_attempt", {
            attemptId,
            turnId,
            attempt,
            providerId: request?.model.provider ?? input.run.model.provider,
            modelId: request?.model.model ?? input.run.model.model,
            state: willRetry ? "retry_wait" : "failed",
            retryAt,
            error: { code },
          });
          if (!willRetry) break;
        }
      }
      this.#store.completeTurn(turnId, "failed", this.#now());
      turnTerminal = true;
      throw new RuntimeExecutionError(
        input.role === "persona" ? "model_failed" : "structured_output_failed",
        input.role === "persona" ? "model_failed" : "structured_output_failed",
        { cause: lastError },
      );
    } catch (error) {
      if (!turnTerminal) this.#store.completeTurn(turnId, "failed", this.#now());
      throw error;
    }
  }

  #observeStream(
    input: { persona: PersonaFact; run: RunFact; event: EventFact },
    attemptId: string,
    turnId: string,
    attempt: number,
    event: ModelStreamEvent,
  ): void {
    this.#observe(input, "model_stream", {
      attemptId,
      turnId,
      attempt,
      stream: responseFact(event),
    });
  }

  #observe(
    input: { persona: PersonaFact; run: RunFact; event: EventFact },
    kind: string,
    payload: JsonValue,
  ): void {
    this.#store.appendObservation({
      personaId: input.persona.id,
      runId: input.run.id,
      eventId: input.event.id,
      kind,
      payload,
      now: this.#now(),
    });
  }

  #freezeEvidence(event: EventFact, source: JsonValue): JsonValue {
    return {
      version: 1,
      eventId: event.id,
      source,
      sessionEntries: responseFact(
        this.#store.sessionEntriesForEvent(event.id).map((entry) => ({
          sequence: entry.sequence,
          kind: entry.kind,
          payload: entry.payload,
        })),
      ),
      toolCalls: responseFact(
        this.#store.toolCallsForEvent(event.id).map((call) => ({
          id: call.id,
          providerCallId: call.providerCallId,
          sequence: call.sequence,
          name: call.name,
          arguments: call.arguments,
          effect: call.effect,
          status: call.status,
          dispatchResult: call.dispatchResult,
          result: call.result,
        })),
      ),
    };
  }

  async #model(run: RunFact): Promise<{ provider: ModelProvider; capability: ModelCapability }> {
    const provider = this.#providers.require(run.model);
    const before = await captureCredentialSnapshot(this.#credentialBoundary, "Provider capability boundary");
    const capabilities = await provider.listModels();
    before.assertCredentialFree(JSON.stringify(capabilities), "Provider capabilities");
    (
      await captureCredentialSnapshot(this.#credentialBoundary, "Provider capability boundary")
    ).assertCredentialFree(JSON.stringify(capabilities), "Provider capabilities");
    const capability = capabilities.find((candidate) => candidate.model === run.model.model);
    if (!capability || !capability.authenticated) throw new RuntimeExecutionError("model_unavailable");
    return { provider, capability };
  }
}

function toolRepositoryAccess(repository: PersonaRepository) {
  return Object.freeze({
    listFiles: (relativeDirectory?: string) => repository.listFiles(relativeDirectory),
    readText: (relativePath: string) => repository.readText(relativePath),
    writeText: (relativePath: string, content: string, expectedSha256: string | null) =>
      repository.writeText(relativePath, content, expectedSha256),
  });
}

function sourceFact(item: QueueItemFact, store: RuntimeFactStore): JsonValue {
  const origin = item.sourceToolCallId === null ? undefined : store.requireToolCall(item.sourceToolCallId);
  return {
    kind: item.kind,
    payload: item.payload,
    ...(item.stimulusId === null ? {} : { stimulusId: item.stimulusId }),
    ...(item.sourceEventId === null ? {} : { sourceEventId: item.sourceEventId }),
    ...(item.sourceToolCallId === null ? {} : { sourceToolCallId: item.sourceToolCallId }),
    ...(origin === undefined
      ? {}
      : {
          originAction: {
            name: origin.name,
            effect: origin.effect,
            status: origin.status,
          },
        }),
  };
}

function authorityDecisionFacts(store: RuntimeFactStore, toolCallId: string): JsonValue {
  return store.authorizationDecisionsForToolCall(toolCallId).map((decision) => ({
    decisionId: decision.id,
    stage: decision.stage,
    allowed: decision.allow,
    revision: decision.revision,
    reason: decision.reason,
    checkedAt: new Date(decision.checkedAt).toISOString(),
  }));
}

function publicationFact(event: EventFact): JsonValue {
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

function executionFact(execution: ToolExecutionResult): JsonValue {
  return {
    content: execution.content,
    ...(execution.details === undefined ? {} : { details: execution.details }),
    ...(execution.continuation === undefined ? {} : { continuation: execution.continuation }),
    ...(execution.callbackPending ? { callbackPending: true } : {}),
  };
}

function requirePromptLocale(locale: string): PromptLocale {
  if (!isSupportedLocale(locale))
    throw new RuntimeExecutionError("model_failed", "Unsupported Prompt locale.");
  return locale;
}

function assertFits(
  capability: ModelCapability,
  system: string,
  messages: ModelRequest["messages"],
  tools: ModelRequest["tools"],
  maxOutputTokens: number,
): void {
  const estimate = estimateRequestTokens({ system, messages, tools, maxOutputTokens });
  if (estimate > capability.contextWindow) throw new RuntimeExecutionError("context_too_large");
}

function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RetryableModelOutputError) return error.code;
  if (error instanceof StructuredOutputError) return "structured_output_invalid";
  if (error instanceof RuntimeExecutionError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "operation_failed";
}

function settleProviderCall<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      settle(() => reject(providerAbortError()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(operation).then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function providerAbortError(): Error {
  const error = new Error("Provider call aborted.");
  error.name = "AbortError";
  return error;
}

function safeValidationMessage(locale: PromptLocale, error: unknown): string {
  if (error instanceof StructuredOutputError) {
    return agentValidationText(locale, error.code, error.detail);
  }
  if (error instanceof RetryableModelOutputError) {
    return agentValidationText(locale, error.code);
  }
  return agentValidationText(locale, "structured_output_invalid");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function callbackState(payload: JsonValue): string | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload["state"] === "string"
    ? payload["state"]
    : undefined;
}

function requireEventStartingCheckpoint(persona: PersonaFact): string {
  if (persona.currentCheckpoint === null) {
    throw new RuntimeExecutionError("checkpoint_required", "checkpoint_required");
  }
  return persona.currentCheckpoint;
}

export function createBuiltinToolTextResolver(): (
  locale: string,
  name: string,
) => {
  label: string;
  description: string;
  properties: Record<string, string>;
  results: Record<string, string>;
} {
  return (locale, name) => {
    const promptLocale = requirePromptLocale(locale);
    if (!isBuiltinToolName(name)) throw new Error(`Unknown built-in Tool: ${name}`);
    const text = builtinToolText(promptLocale, name);
    return {
      label: text.label,
      description: text.description,
      properties: { ...text.properties },
      results: { default: text.result },
    };
  };
}
