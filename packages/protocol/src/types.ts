/** JSON values accepted at the public Kokoro boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Revision = number;
export type IsoTimestamp = string;
export type PersonaId = string;
export type CheckpointId = string;
export type EventId = string;
export type ObservationCursor = string;

export type LifecyclePhase =
  | "draft"
  | "initialized"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "forcing"
  | "failed";

export type WaitingFact =
  | { readonly kind: "tool_callback"; readonly toolCallId: string }
  | { readonly kind: "provider_retry"; readonly attemptId: string; readonly retryAt: IsoTimestamp }
  | { readonly kind: "publication_retry"; readonly publicationId: string; readonly retryAt: IsoTimestamp }
  | { readonly kind: "hippocampus_retry"; readonly jobId: string; readonly retryAt: IsoTimestamp }
  | { readonly kind: "owner_action"; readonly reason: string };

export interface CheckpointRef {
  readonly checkpointId: CheckpointId;
  readonly commitId: string;
  readonly summary: string;
  readonly createdAt: IsoTimestamp;
}

/** An Owner-visible Markdown document. Paths are repository-relative and never expose host roots. */
export interface OwnerDocument {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly mtimeMs: number;
}

export interface QueueItemSnapshot {
  readonly workItemId: string;
  readonly source: "stimulus" | "continuation";
  readonly state: "pending" | "frozen_by_pause" | "active";
  readonly acceptedAt: IsoTimestamp;
  readonly stimulusKind: StimulusKind | null;
}

export interface PublicationSummary {
  readonly pending: number;
  readonly delivering: number;
  readonly retryWaiting: number;
  readonly failed: number;
}

export interface HippocampusSummary {
  readonly queued: number;
  readonly running: boolean;
  readonly retryWaiting: number;
  readonly failed: number;
  readonly conflicted: number;
}

export interface PersonaSnapshot {
  readonly personaId: PersonaId;
  readonly displayName: string;
  readonly uiLocale: string;
  readonly promptLocale: string;
  readonly phase: LifecyclePhase;
  readonly runId: string | null;
  readonly activeEventId: EventId | null;
  readonly waiting: WaitingFact | null;
  readonly queue: readonly QueueItemSnapshot[];
  readonly latestCheckpoint: CheckpointRef | null;
  /** The checkpoint represented by the current working tree and used by Start unless overridden. */
  readonly currentCheckpointId: CheckpointId | null;
  readonly selectedStartCheckpointId: CheckpointId | null;
  readonly workingTree: {
    readonly state: "clean" | "dirty" | "unknown";
    readonly digest: string | null;
  };
  readonly publication: PublicationSummary;
  readonly hippocampus: HippocampusSummary;
  readonly updatedAt: IsoTimestamp;
}

/**
 * A complete server-authoritative view for everything visible to this connection.
 * Revisions are monotonically increasing. Equal revisions must describe identical facts.
 */
export interface AuthoritySnapshot {
  readonly revision: Revision;
  readonly capturedAt: IsoTimestamp;
  readonly personas: readonly PersonaSnapshot[];
}

export interface LocaleCapability {
  readonly locale: string;
  readonly label: string;
  readonly ui: boolean;
  readonly prompt: boolean;
}

/** Stable machine-readable capability reason code. Clients localize it for display. */
export type ProviderUnavailableReasonCode = "authentication_required";

export interface ProviderCapability {
  readonly providerId: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason: ProviderUnavailableReasonCode | null;
  readonly models: readonly {
    readonly modelId: string;
    readonly label: string;
    readonly contextWindow: number | null;
  }[];
}

export interface ToolCapability {
  readonly toolName: string;
  readonly description: string;
  readonly available: boolean;
  readonly externalEffect: "none" | "possible";
  readonly authorizationRequiredAtDispatch: boolean;
}

export interface AuthorityDecisionSnapshot {
  readonly decisionId: string;
  readonly stage: "proposal" | "dispatch";
  readonly allowed: boolean;
  readonly revision: string;
  readonly reason: string | null;
  readonly checkedAt: IsoTimestamp;
}

export interface CapabilitySnapshot {
  readonly protocol: "kokoro/1";
  readonly serverVersion: string;
  readonly maxFrameBytes: number;
  readonly commands: readonly CommandType[];
  /** Commands supported by this server and currently admissible for the selected Persona lifecycle. */
  readonly availableCommands: readonly CommandType[];
  readonly observationKinds: readonly ObservationKind[];
  readonly locales: readonly LocaleCapability[];
  readonly providers: readonly ProviderCapability[];
  readonly tools: readonly ToolCapability[];
  readonly features: {
    readonly continuation: boolean;
    readonly publication: boolean;
    readonly hippocampus: boolean;
  };
}

export type StimulusKind = "user_message" | "system_event" | "scheduled" | "external_change";

export interface StimulusInput {
  readonly kind: StimulusKind;
  readonly content: JsonValue;
  readonly occurredAt: IsoTimestamp | null;
  readonly source: string | null;
}

export type ToolCallbackOutcome =
  | { readonly state: "succeeded"; readonly result: JsonValue }
  | { readonly state: "failed"; readonly error: PublicError }
  | { readonly state: "unknown"; readonly reason: string };

export interface CreateCommand {
  readonly type: "create";
  readonly templateId: string;
  readonly personaId: PersonaId | null;
  readonly displayName: string;
  readonly uiLocale: string;
  readonly promptLocale: string;
}

export interface InitCommand {
  readonly type: "init";
  readonly personaId: PersonaId;
  readonly expectedWorkingTreeDigest: string | null;
}

export interface StartCommand {
  readonly type: "start";
  readonly personaId: PersonaId;
  readonly from:
    | { readonly kind: "current_working_tree" }
    | { readonly kind: "checkpoint"; readonly checkpointId: CheckpointId };
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
  readonly promptLocale: string | null;
}

export interface PauseCommand {
  readonly type: "pause";
  readonly personaId: PersonaId;
}

export interface ResumeCommand {
  readonly type: "resume";
  readonly personaId: PersonaId;
}

export interface StopCommand {
  readonly type: "stop";
  readonly personaId: PersonaId;
}

export interface ForceCommand {
  readonly type: "force";
  readonly personaId: PersonaId;
}

export interface StimulusCommand {
  readonly type: "stimulus";
  readonly personaId: PersonaId;
  readonly idempotencyKey: string;
  readonly stimulus: StimulusInput;
}

/** A callback is only a fact about its original ToolCall. New external work uses a separate stimulus command. */
export interface CallbackCommand {
  readonly type: "callback";
  readonly personaId: PersonaId;
  readonly toolCallId: string;
  readonly callbackId: string;
  readonly outcome: ToolCallbackOutcome;
}

/** Null path lists every complete Owner document; a path reads exactly one document. */
export interface OwnerDocumentsCommand {
  readonly type: "owner_documents";
  readonly personaId: PersonaId;
  readonly path: string | null;
}

/** expectedSha256 is null only when creating a path that does not yet exist. */
export interface PutOwnerDocumentCommand {
  readonly type: "put_owner_document";
  readonly personaId: PersonaId;
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
}

export interface HistoryCommand {
  readonly type: "history";
  readonly personaId: PersonaId;
  readonly beforeCheckpointId: CheckpointId | null;
  readonly limit: number;
}

export interface BranchCommand {
  readonly type: "branch";
  readonly personaId: PersonaId;
  readonly checkpointId: CheckpointId;
  readonly branchName: string;
}

export interface CloneCommand {
  readonly type: "clone";
  readonly personaId: PersonaId;
  readonly checkpointId: CheckpointId;
  readonly newPersonaId: PersonaId | null;
  readonly displayName: string;
}

export interface RestoreCommand {
  readonly type: "restore";
  readonly personaId: PersonaId;
  readonly checkpointId: CheckpointId;
  readonly workingTreePolicy: "require_clean" | "discard_changes";
}

export interface DeleteCommand {
  readonly type: "delete";
  readonly personaId: PersonaId;
  readonly confirmationPersonaId: PersonaId;
  readonly workingTreePolicy: "require_clean" | "discard_changes";
}

export interface LocalesCommand {
  readonly type: "locales";
}

export interface SetLocalesCommand {
  readonly type: "set_locales";
  readonly personaId: PersonaId;
  readonly uiLocale: string | null;
  readonly promptLocale: string | null;
}

export type RetryTarget = { readonly kind: "hippocampus"; readonly jobId: string };

export interface RetryCommand {
  readonly type: "retry";
  readonly personaId: PersonaId;
  readonly target: RetryTarget;
}

export interface CapabilitiesCommand {
  readonly type: "capabilities";
  readonly personaId: PersonaId | null;
}

export interface ObservationsCommand {
  readonly type: "observations";
  readonly personaId: PersonaId;
  readonly afterCursor: ObservationCursor | null;
  readonly limit: number;
  readonly kinds: readonly ObservationKind[] | null;
}

export interface SnapshotCommand {
  readonly type: "snapshot";
}

export type Command =
  | CreateCommand
  | InitCommand
  | StartCommand
  | PauseCommand
  | ResumeCommand
  | StopCommand
  | ForceCommand
  | StimulusCommand
  | CallbackCommand
  | OwnerDocumentsCommand
  | PutOwnerDocumentCommand
  | HistoryCommand
  | BranchCommand
  | CloneCommand
  | RestoreCommand
  | DeleteCommand
  | LocalesCommand
  | SetLocalesCommand
  | RetryCommand
  | CapabilitiesCommand
  | ObservationsCommand
  | SnapshotCommand;

export type CommandType = Command["type"];

export type OperationCommandType =
  | "init"
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "force"
  | "restore"
  | "delete"
  | "set_locales"
  | "retry";

export interface OperationAcceptedResult<TType extends OperationCommandType = OperationCommandType> {
  readonly type: TType;
  readonly operationId: string;
  readonly acceptedAt: IsoTimestamp;
}

export type CommandResult =
  | {
      readonly type: "create";
      readonly personaId: PersonaId;
      readonly operationId: string;
      readonly acceptedAt: IsoTimestamp;
    }
  | OperationAcceptedResult<"init">
  | OperationAcceptedResult<"start">
  | OperationAcceptedResult<"pause">
  | OperationAcceptedResult<"resume">
  | OperationAcceptedResult<"stop">
  | OperationAcceptedResult<"force">
  | OperationAcceptedResult<"restore">
  | OperationAcceptedResult<"delete">
  | OperationAcceptedResult<"set_locales">
  | OperationAcceptedResult<"retry">
  | {
      readonly type: "stimulus";
      readonly stimulusId: string;
      readonly workItemId: string;
      readonly acceptedAt: IsoTimestamp;
    }
  | {
      readonly type: "callback";
      readonly callbackId: string;
      readonly toolCallId: string;
      readonly recordedAt: IsoTimestamp;
    }
  | {
      readonly type: "owner_documents";
      readonly documents: readonly OwnerDocument[];
    }
  | {
      readonly type: "put_owner_document";
      readonly document: OwnerDocument;
    }
  | {
      readonly type: "history";
      readonly checkpoints: readonly CheckpointRef[];
      readonly nextBeforeCheckpointId: CheckpointId | null;
    }
  | {
      readonly type: "branch";
      readonly branchName: string;
      readonly checkpoint: CheckpointRef;
    }
  | {
      readonly type: "clone";
      readonly personaId: PersonaId;
      readonly checkpoint: CheckpointRef;
    }
  | {
      readonly type: "locales";
      readonly locales: readonly LocaleCapability[];
    }
  | {
      readonly type: "capabilities";
      readonly capabilities: CapabilitySnapshot;
    }
  | {
      readonly type: "observations";
      readonly observations: readonly ObservationRecord[];
      readonly nextCursor: ObservationCursor | null;
    }
  | { readonly type: "snapshot" };

export type ResultForCommand<TCommand extends Command> = Extract<
  CommandResult,
  { readonly type: TCommand["type"] }
>;

export type PublicErrorCode =
  | "invalid_request"
  | "unsupported_version"
  | "not_found"
  | "revision_conflict"
  | "invalid_state"
  | "permission_denied"
  | "working_tree_conflict"
  | "outcome_unknown"
  | "rate_limited"
  | "unavailable"
  | "internal_error";

export interface PublicError {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: JsonValue;
}

export type ObservationKind = Observation["kind"];

export type Observation =
  | {
      readonly kind: "model_input";
      readonly role: "persona" | "closeout" | "hippocampus" | "compaction";
      readonly attemptId: string;
      readonly content: string;
      readonly redacted: boolean;
    }
  | {
      readonly kind: "internal_cognition";
      readonly attemptId: string;
      readonly channel: "reasoning" | "assistant";
      readonly sequence: number;
      readonly content: string;
      readonly attemptState: "streaming" | "completed" | "failed" | "aborted";
      readonly externalMessage: false;
    }
  | {
      readonly kind: "provider_attempt";
      readonly attemptId: string;
      /** Stable execution Turn shared by every automatic attempt in one model call. */
      readonly turnId: string;
      /** One-based ordinal within turnId; ordinals restart for a new Turn. */
      readonly attempt: number;
      readonly providerId: string;
      readonly modelId: string;
      readonly state: "started" | "completed" | "retry_wait" | "failed" | "aborted";
      readonly retryAt: IsoTimestamp | null;
      readonly error: PublicError | null;
    }
  | {
      readonly kind: "usage";
      readonly attemptId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number;
    }
  | {
      readonly kind: "tool_proposal";
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: JsonValue;
      readonly proposedAt: IsoTimestamp;
    }
  | {
      readonly kind: "tool_dispatch";
      readonly toolCallId: string;
      readonly dispatchId: string;
      readonly intentId: string;
      readonly state: "blocked" | "dispatched";
      readonly checkedAt: IsoTimestamp;
      readonly externalEffect: "none" | "possible";
      readonly authority: readonly AuthorityDecisionSnapshot[];
      readonly receipt: JsonValue | null;
      readonly denial: PublicError | null;
    }
  | {
      readonly kind: "tool_outcome";
      readonly toolCallId: string;
      readonly dispatchId: string;
      readonly state: "succeeded" | "failed" | "unknown";
      readonly externalEffect: "none" | "confirmed" | "unknown";
      readonly result: JsonValue;
      readonly error: PublicError | null;
    }
  | {
      readonly kind: "tool_callback";
      readonly toolCallId: string;
      readonly callbackId: string;
      readonly outcome: ToolCallbackOutcome;
    }
  | {
      readonly kind: "event_committed";
      readonly eventId: EventId;
      readonly sourceWorkItemIds: readonly string[];
      readonly summary: string;
      readonly needsMemory: boolean;
      readonly checkpoint: CheckpointRef;
      readonly committedAt: IsoTimestamp;
    }
  | {
      readonly kind: "publication";
      readonly publicationId: string;
      readonly eventId: EventId;
      readonly checkpointId: CheckpointId;
      readonly state: "pending" | "delivering" | "delivered" | "retry_wait" | "failed";
      readonly attempt: number;
      readonly retryAt: IsoTimestamp | null;
      readonly receipt: JsonValue;
      readonly error: PublicError | null;
    }
  | {
      readonly kind: "hippocampus";
      readonly jobId: string;
      readonly eventId: EventId;
      readonly checkpointId: CheckpointId;
      readonly state: "queued" | "running" | "applied" | "retry_wait" | "failed" | "conflict";
      readonly attempt: number;
      readonly retryAt: IsoTimestamp | null;
      readonly error: PublicError | null;
    }
  | {
      readonly kind: "lifecycle";
      readonly phase: LifecyclePhase;
      readonly runId: string | null;
      readonly reason: string | null;
    }
  | {
      readonly kind: "queue";
      readonly workItem: QueueItemSnapshot;
      readonly action: "accepted" | "activated" | "frozen" | "completed" | "discarded";
    }
  | {
      readonly kind: "diagnostic";
      readonly severity: "info" | "warning" | "error";
      readonly code: string;
      readonly message: string;
      readonly details: JsonValue;
    };

export interface ObservationRecord {
  readonly observationId: string;
  readonly cursor: ObservationCursor;
  readonly personaId: PersonaId;
  readonly runId: string | null;
  readonly eventId: EventId | null;
  readonly occurredAt: IsoTimestamp;
  readonly correlationId: string;
  readonly observation: Observation;
}

export interface ClientHelloEnvelope {
  readonly protocol: "kokoro/1";
  readonly kind: "hello";
  readonly messageId: string;
  readonly correlationId: string;
  readonly client: {
    readonly name: string;
    readonly version: string;
  };
  readonly maxFrameBytes: number;
}

export interface RequestEnvelope<TCommand extends Command = Command> {
  readonly protocol: "kokoro/1";
  readonly kind: "request";
  readonly messageId: string;
  readonly correlationId: string;
  /** Global mutation-admission fence. Read-only commands require null. */
  readonly expectedRevision: Revision | null;
  readonly command: TCommand;
}

export type ClientEnvelope = ClientHelloEnvelope | RequestEnvelope;

export interface ServerHelloEnvelope {
  readonly protocol: "kokoro/1";
  readonly kind: "hello";
  readonly messageId: string;
  readonly correlationId: string;
  readonly replyTo: string;
  readonly snapshot: AuthoritySnapshot | null;
  readonly outcome:
    | {
        readonly status: "ok";
        readonly server: { readonly name: string; readonly version: string };
        readonly capabilities: CapabilitySnapshot;
      }
    | { readonly status: "error"; readonly error: PublicError };
}

export interface ResponseEnvelope {
  readonly protocol: "kokoro/1";
  readonly kind: "response";
  readonly messageId: string;
  readonly correlationId: string;
  readonly replyTo: string;
  readonly snapshot: AuthoritySnapshot;
  readonly outcome:
    | { readonly status: "ok"; readonly result: CommandResult }
    | { readonly status: "error"; readonly error: PublicError };
}

export interface EventEnvelope {
  readonly protocol: "kokoro/1";
  readonly kind: "event";
  readonly messageId: string;
  readonly correlationId: string;
  /** The request/event message that directly caused this event, or null for autonomous work. */
  readonly causationId: string | null;
  readonly snapshot: AuthoritySnapshot;
  readonly record: ObservationRecord;
}

export type ServerEnvelope = ServerHelloEnvelope | ResponseEnvelope | EventEnvelope;
