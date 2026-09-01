import type { JsonValue, ModelRef } from "../model.js";

export type PersonaLifecycle =
  | "draft"
  | "ready"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "forcing"
  | "stopped"
  | "forced"
  | "crashed"
  | "faulted";

export interface PersonaFact {
  id: string;
  displayName: string;
  repositoryPath: string;
  lifecycle: PersonaLifecycle;
  uiLocale: string;
  promptLocale: string;
  initialized: boolean;
  currentCheckpoint: string | null;
  selectedCheckpoint: string | null;
  revision: number;
  createdAt: number;
}

export type RunPhase =
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "forcing"
  | "stopped"
  | "forced"
  | "crashed"
  | "faulted";

export interface RunFact {
  id: string;
  personaId: string;
  incarnation: string;
  phase: RunPhase;
  model: ModelRef;
  sessionId: string;
  startingCheckpoint: string;
  currentQueueItemId: string | null;
  waitingCode: string | null;
  fault: JsonValue | null;
  stopCutoffSequence: number | null;
  startedAt: number;
  endedAt: number | null;
}

export type QueueKind = "start" | "stimulus" | "continuation";
export type QueueStatus = "queued" | "started" | "completed" | "discarded";

export interface QueueItemFact {
  id: string;
  runId: string;
  sequence: number;
  kind: QueueKind;
  payload: JsonValue;
  stimulusId: string | null;
  sourceEventId: string | null;
  sourceToolCallId: string | null;
  status: QueueStatus;
  acceptedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type EventStatus = "open" | "frozen" | "closed" | "checkpointed" | "faulted";

export interface EventFact {
  id: string;
  personaId: string;
  runId: string;
  sessionId: string;
  queueItemId: string;
  sequence: number;
  status: EventStatus;
  sourceKind: QueueKind;
  frozen: JsonValue | null;
  summary: string | null;
  memoryDecision: "none" | "maintain" | null;
  checkpoint: string | null;
  createdAt: number;
  frozenAt: number | null;
  closedAt: number | null;
  checkpointedAt: number | null;
}

export interface RegisteredCheckpointFact {
  commit: string;
  personaId: string;
  summary: string;
  root: boolean;
  createdAt: number;
}

export interface SessionEntryFact {
  id: string;
  sessionId: string;
  eventId: string | null;
  sequence: number;
  kind: "user" | "assistant" | "tool" | "compaction";
  payload: JsonValue;
  createdAt: number;
}

export interface TurnFact {
  id: string;
  /** The Event-owned execution graph. Null for derived closeout/compaction/Hippocampus work. */
  eventId: string | null;
  /** Immutable causal source, including for derived work. */
  sourceEventId: string;
  scope: "event" | "closeout" | "compaction" | "hippocampus";
  sessionId: string;
  sequence: number;
  role: string;
  startingCheckpoint: string;
  promptLocale: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  completedAt: number | null;
}

export interface ToolCallFact {
  id: string;
  eventId: string;
  turnId: string;
  sequence: number;
  providerCallId: string;
  name: string;
  arguments: Record<string, JsonValue>;
  effect: "none" | "repository" | "external";
  status:
    | "proposed"
    | "blocked"
    | "intent_recorded"
    | "dispatching"
    | "awaiting_callback"
    | "succeeded"
    | "failed"
    | "unknown";
  authorizationRevision: string | null;
  /** Immutable acceptance/receipt returned before a final callback. */
  dispatchResult: JsonValue | null;
  result: JsonValue | null;
  proposedAt: number;
  intentAt: number | null;
  dispatchAt: number | null;
  outcomeAt: number | null;
}

export interface AuthorizationDecisionFact {
  id: string;
  toolCallId: string;
  sequence: number;
  stage: "proposal" | "dispatch";
  allow: boolean;
  revision: string;
  reason: string | null;
  checkedAt: number;
}

export interface ObservationFact {
  sequence: number;
  personaId: string;
  runId: string | null;
  eventId: string | null;
  kind: string;
  payload: JsonValue;
  createdAt: number;
}

export interface HippocampusJobFact {
  id: string;
  personaId: string;
  eventId: string;
  sourceCheckpoint: string;
  model: ModelRef;
  promptLocale: string;
  status: "queued" | "running" | "retry" | "applying" | "completed" | "failed" | "conflict";
  attempts: number;
  proposal: JsonValue | null;
  error: JsonValue | null;
  createdAt: number;
  updatedAt: number;
}
