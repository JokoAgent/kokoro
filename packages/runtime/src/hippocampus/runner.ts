import { randomUUID } from "node:crypto";
import type { AsyncMutex } from "../async.js";
import {
  agentValidationText,
  buildHippocampusPrompt,
  emptyDocumentsText,
  isSupportedLocale,
  type PromptLocale,
} from "../i18n/index.js";
import {
  MemoryProposalError,
  type MemoryTransactionManager,
  MemoryTransactionRecoveryRequiredError,
  parseMemoryProposal,
} from "../memory/index.js";
import type { JsonValue, ModelCapability, ModelProvider, ModelRequest, ProviderRegistry } from "../model.js";
import type { PersonaRepository } from "../repository/index.js";
import { type CredentialBoundary, captureCredentialSnapshot } from "../security.js";
import {
  estimateRequestTokens,
  formatDocuments,
  formatHippocampusEventEvidence,
  requestFact,
  responseFact,
} from "../session/index.js";
import type { EventFact, HippocampusJobFact, RuntimeFactStore } from "../store/index.js";

export interface HippocampusRunnerOptions {
  store: RuntimeFactStore;
  providers: ProviderRegistry;
  memory: MemoryTransactionManager;
  repositoryMutex: AsyncMutex;
  now?: () => number;
  maxAttempts?: number;
  assertWriterLease?: () => void;
  credentialBoundary: CredentialBoundary;
}

export class HippocampusRunner {
  readonly #store: RuntimeFactStore;
  readonly #providers: ProviderRegistry;
  readonly #memory: MemoryTransactionManager;
  readonly #repositoryMutex: AsyncMutex;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #assertWriterLease: () => void;
  readonly #credentialBoundary: CredentialBoundary;

  constructor(options: HippocampusRunnerOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#memory = options.memory;
    this.#repositoryMutex = options.repositoryMutex;
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = Math.max(1, Math.min(10, Math.floor(options.maxAttempts ?? 3)));
    this.#assertWriterLease = options.assertWriterLease ?? (() => undefined);
    this.#credentialBoundary = options.credentialBoundary;
  }

  async runNext(personaId: string, repository: PersonaRepository, signal: AbortSignal): Promise<boolean> {
    const job = this.#store.nextHippocampusJob(personaId);
    if (!job) return false;
    await this.#run(job, repository, signal);
    return true;
  }

  retry(jobId: string): HippocampusJobFact {
    const job = this.#store.requireHippocampusJob(jobId);
    if (job.status !== "failed" && job.status !== "conflict") {
      throw new Error("Only failed or conflicted Hippocampus work can be retried manually.");
    }
    return this.#store.updateHippocampusJob(
      jobId,
      { status: "queued", attempts: 0, proposal: null, error: null },
      this.#now(),
    );
  }

  async #run(job: HippocampusJobFact, repository: PersonaRepository, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const event = this.#store.requireEvent(job.eventId);
    if (
      event.status !== "checkpointed" ||
      event.checkpoint !== job.sourceCheckpoint ||
      event.frozen === null
    ) {
      this.#store.updateHippocampusJob(
        job.id,
        { status: "failed", error: { code: "source_event_invalid" } },
        this.#now(),
      );
      this.#observeState(event, job, "failed", "source_event_invalid", job.attempts);
      return;
    }
    const attempt = job.attempts + 1;
    let locale: PromptLocale;
    let provider: ModelProvider;
    let capability: ModelCapability;
    try {
      ({ provider, capability } = await model(this.#providers, job, this.#credentialBoundary));
      signal.throwIfAborted();
      locale = requirePromptLocale(this.#store.requirePersona(job.personaId).promptLocale);
    } catch (error) {
      if (signal.aborted) return;
      this.#store.updateHippocampusJob(
        job.id,
        {
          status: attempt < this.#maxAttempts ? "retry" : "failed",
          attempts: attempt,
          error: { code: safeCode(error) },
        },
        this.#now(),
      );
      this.#observeState(
        event,
        job,
        attempt < this.#maxAttempts ? "retry_wait" : "failed",
        safeCode(error),
        attempt,
      );
      return;
    }
    this.#store.updateHippocampusJob(
      job.id,
      { status: "running", attempts: attempt, error: null },
      this.#now(),
    );
    this.#observeState(event, job, "running", null, attempt);
    const turnId = this.#store.createTurn({
      eventId: null,
      sourceEventId: event.id,
      scope: "hippocampus",
      sessionId: event.sessionId,
      role: "hippocampus",
      startingCheckpoint: job.sourceCheckpoint,
      promptLocale: locale,
      now: this.#now(),
    });
    // Each Hippocampus job attempt is a distinct Turn. Its job-global ordinal
    // belongs to the hippocampus observation; model/provider attempt ordinals
    // are Turn-local and therefore begin at one for every new Turn.
    const turnAttempt = 1;
    let modelAttemptId: string | undefined;
    let modelCompleted = false;
    let providerStarted = false;
    let turnCompleted = false;
    let streamSequence = 0;
    try {
      const review = await this.#memory.review(repository);
      signal.throwIfAborted();
      locale = requirePromptLocale(this.#store.requirePersona(job.personaId).promptLocale);
      const currentMemory = formatDocuments(review.documents, emptyDocumentsText(locale));
      (await captureCredentialSnapshot(this.#credentialBoundary)).assertCredentialFree(
        currentMemory,
        "Hippocampus Context",
      );
      const validationError = agentValidationText(locale, storedErrorCode(job.error));
      const prompt = buildHippocampusPrompt(locale, {
        eventEvidence: formatHippocampusEventEvidence(event.frozen),
        currentMemory,
        validationError,
      });
      const request: ModelRequest = {
        id: randomUUID(),
        role: "hippocampus",
        model: job.model,
        promptLocale: locale,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.instruction }],
        tools: [],
        maxOutputTokens: capability.maxOutputTokens,
        continuation: false,
      };
      if (
        estimateRequestTokens({
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          maxOutputTokens: capability.maxOutputTokens,
        }) > capability.contextWindow
      ) {
        throw new HippocampusRunError("context_too_large");
      }
      const requestCredentials = await captureCredentialSnapshot(
        this.#credentialBoundary,
        "Hippocampus model boundary",
      );
      requestCredentials.assertCredentialFree(JSON.stringify(requestFact(request)), "Hippocampus request");
      modelAttemptId = this.#store.createModelAttempt({
        turnId,
        attempt: turnAttempt,
        request: requestFact(request),
        now: this.#now(),
      });
      this.#observe(event, "hippocampus_model_request", {
        jobId: job.id,
        attemptId: modelAttemptId,
        attempt: turnAttempt,
        request: requestFact(request),
      });
      this.#observe(event, "provider_attempt", {
        attemptId: modelAttemptId,
        turnId,
        attempt: turnAttempt,
        providerId: request.model.provider,
        modelId: request.model.model,
        state: "started",
        retryAt: null,
        error: null,
      });
      providerStarted = true;
      signal.throwIfAborted();
      let acceptingStreams = true;
      let streamChain = Promise.resolve();
      let response: Awaited<ReturnType<ModelProvider["complete"]>>;
      try {
        response = await settleProviderCall(
          provider.complete(request, {
            signal,
            emit: (stream) => {
              if (!acceptingStreams || signal.aborted) return;
              const accepted = stream;
              streamChain = streamChain.then(async () => {
                requestCredentials.assertCredentialFree(
                  JSON.stringify(responseFact(accepted)),
                  "Hippocampus stream",
                );
                const credentials = await captureCredentialSnapshot(
                  this.#credentialBoundary,
                  "Hippocampus Provider stream boundary",
                );
                credentials.assertCredentialFree(
                  JSON.stringify(responseFact(accepted)),
                  "Hippocampus stream",
                );
                if (
                  !signal.aborted &&
                  (accepted.type === "reasoning_delta" || accepted.type === "text_delta")
                ) {
                  streamSequence += 1;
                  this.#observe(event, "internal_cognition", {
                    attemptId: modelAttemptId as string,
                    channel: accepted.type === "reasoning_delta" ? "reasoning" : "assistant",
                    sequence: streamSequence,
                    content: accepted.delta,
                    attemptState: "streaming",
                    externalMessage: false,
                  });
                }
              });
              return streamChain;
            },
          }),
          signal,
        );
      } finally {
        acceptingStreams = false;
        await streamChain;
      }
      signal.throwIfAborted();
      requestCredentials.assertCredentialFree(JSON.stringify(responseFact(response)), "Hippocampus response");
      (
        await captureCredentialSnapshot(this.#credentialBoundary, "Hippocampus model boundary")
      ).assertCredentialFree(JSON.stringify(responseFact(response)), "Hippocampus response");
      if (response.stopReason === "length" || response.toolCalls.length > 0) {
        throw new HippocampusRunError("proposal_response_contract_invalid");
      }
      const proposal = parseMemoryProposal(response.text);
      this.#store.completeModelAttempt(modelAttemptId, responseFact(response), this.#now());
      modelCompleted = true;
      this.#observe(event, "model_attempt_completed", {
        attemptId: modelAttemptId,
        turnId,
        attempt: turnAttempt,
        role: "hippocampus",
        response: responseFact(response),
      });
      if (response.reasoning) {
        this.#observe(event, "internal_cognition", {
          attemptId: modelAttemptId,
          channel: "reasoning",
          sequence: ++streamSequence,
          content: response.reasoning,
          attemptState: "completed",
          externalMessage: false,
        });
      }
      if (response.text) {
        this.#observe(event, "internal_cognition", {
          attemptId: modelAttemptId,
          channel: "assistant",
          sequence: ++streamSequence,
          content: response.text,
          attemptState: "completed",
          externalMessage: false,
        });
      }
      this.#observe(event, "provider_attempt", {
        attemptId: modelAttemptId,
        turnId,
        attempt: turnAttempt,
        providerId: request.model.provider,
        modelId: request.model.model,
        state: "completed",
        retryAt: null,
        error: null,
      });
      this.#observe(event, "usage", {
        attemptId: modelAttemptId,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        cachedInputTokens: 0,
      });
      this.#store.completeTurn(turnId, "completed", this.#now());
      turnCompleted = true;
      this.#store.updateHippocampusJob(
        job.id,
        { proposal: responseFact(proposal), error: null },
        this.#now(),
      );
      if (proposal.operations.length === 0) {
        this.#store.updateHippocampusJob(job.id, { status: "completed" }, this.#now());
        this.#observeState(event, job, "applied", null, attempt);
        return;
      }
      this.#store.updateHippocampusJob(job.id, { status: "applying" }, this.#now());
      signal.throwIfAborted();
      (
        await captureCredentialSnapshot(this.#credentialBoundary, "Hippocampus Memory apply boundary")
      ).assertCredentialFree(JSON.stringify(responseFact(proposal)), "Memory proposal");
      await this.#repositoryMutex.run(async () => {
        this.#assertWriterLease();
        try {
          await this.#memory.apply(job.id, repository, proposal, review.manifest, this.#assertWriterLease);
        } catch (error) {
          if (!(error instanceof MemoryTransactionRecoveryRequiredError)) throw error;
          // A recorded Memory swap must become terminal before releasing the
          // shared Repository mutex. Re-acquiring from the outer worker would
          // let an already queued Event Checkpoint observe the tree between
          // the two atomic renames.
          await this.#memory
            .recoverAll(
              async (personaId) => {
                if (personaId !== job.personaId) {
                  throw new Error("Memory recovery crossed a Persona boundary.");
                }
                return repository;
              },
              new Set([job.personaId]),
            )
            .catch((recoveryError: unknown) => {
              repository.invalidateWrites();
              throw new MemoryTransactionRecoveryRequiredError(error.transactionId, {
                cause: recoveryError,
              });
            });
          this.#assertWriterLease();
          this.#store.recoverInterruptedHippocampusJobs(this.#now(), job.personaId);
          const recovered = this.#store.requireHippocampusJob(job.id);
          if (recovered.status !== "completed") {
            repository.invalidateWrites();
            throw new MemoryProposalError(
              "conflict",
              "The recorded Memory transaction conflicted during recovery.",
            );
          }
        }
        this.#assertWriterLease();
      });
      signal.throwIfAborted();
      this.#store.updateHippocampusJob(job.id, { status: "completed", error: null }, this.#now());
      this.#observeState(event, job, "applied", null, attempt);
    } catch (error) {
      const aborted = signal.aborted;
      const code = aborted ? "aborted" : safeCode(error);
      if (modelAttemptId !== undefined && !modelCompleted) {
        this.#store.failModelAttempt(modelAttemptId, code, this.#now());
        this.#observe(event, "model_attempt_failed", {
          attemptId: modelAttemptId,
          turnId,
          attempt: turnAttempt,
          role: "hippocampus",
          error: { code },
        });
        if (providerStarted) {
          this.#observe(event, "provider_attempt", {
            attemptId: modelAttemptId,
            turnId,
            attempt: turnAttempt,
            providerId: job.model.provider,
            modelId: job.model.model,
            state: aborted ? "aborted" : "failed",
            retryAt: null,
            error: { code },
          });
        }
      }
      if (!turnCompleted) {
        this.#store.completeTurn(turnId, "failed", this.#now());
        turnCompleted = true;
      }
      if (aborted) return;
      if (error instanceof MemoryTransactionRecoveryRequiredError) throw error;
      const status =
        error instanceof MemoryProposalError && error.code === "conflict"
          ? attempt < this.#maxAttempts
            ? "retry"
            : "conflict"
          : attempt < this.#maxAttempts
            ? "retry"
            : "failed";
      this.#store.updateHippocampusJob(job.id, { status, error: { code } }, this.#now());
      this.#observeState(
        event,
        job,
        status === "retry" ? "retry_wait" : status === "conflict" ? "conflict" : "failed",
        code,
        attempt,
      );
    }
  }

  #observe(event: EventFact, kind: string, payload: JsonValue): void {
    this.#store.appendObservation({
      personaId: event.personaId,
      runId: event.runId,
      eventId: event.id,
      kind,
      payload,
      now: this.#now(),
    });
  }

  #observeState(
    event: EventFact,
    job: HippocampusJobFact,
    state: "running" | "applied" | "retry_wait" | "failed" | "conflict",
    errorCode: string | null,
    attempt: number,
  ): void {
    this.#observe(event, "hippocampus", {
      jobId: job.id,
      eventId: event.id,
      checkpointId: job.sourceCheckpoint,
      state,
      attempt,
      retryAt: null,
      error: errorCode === null ? null : { code: errorCode },
    });
  }
}

class HippocampusRunError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "HippocampusRunError";
    this.code = code;
  }
}

async function model(
  providers: ProviderRegistry,
  job: HippocampusJobFact,
  credentialBoundary: CredentialBoundary,
): Promise<{ provider: ModelProvider; capability: ModelCapability }> {
  const provider = providers.require(job.model);
  const before = await captureCredentialSnapshot(credentialBoundary, "Provider capability boundary");
  const capabilities = await provider.listModels();
  before.assertCredentialFree(JSON.stringify(capabilities), "Provider capabilities");
  (await captureCredentialSnapshot(credentialBoundary, "Provider capability boundary")).assertCredentialFree(
    JSON.stringify(capabilities),
    "Provider capabilities",
  );
  const capability = capabilities.find((candidate) => candidate.model === job.model.model);
  if (!capability || !capability.authenticated) throw new HippocampusRunError("model_unavailable");
  return { provider, capability };
}

function requirePromptLocale(locale: string): PromptLocale {
  if (!isSupportedLocale(locale)) throw new HippocampusRunError("prompt_locale_unsupported");
  return locale;
}

function safeCode(error: unknown): string {
  if (error instanceof HippocampusRunError || error instanceof MemoryProposalError) return error.code;
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

function storedErrorCode(error: JsonValue | null): string {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return "";
  return typeof error["code"] === "string" ? error["code"] : "";
}
