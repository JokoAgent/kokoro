import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { JsonValue, ModelRef } from "../model.js";
import { assertCredentialFree } from "../security.js";
import type {
  AuthorizationDecisionFact,
  EventFact,
  HippocampusJobFact,
  ObservationFact,
  PersonaFact,
  PersonaLifecycle,
  QueueItemFact,
  QueueKind,
  RegisteredCheckpointFact,
  RunFact,
  RunPhase,
  SessionEntryFact,
  ToolCallFact,
  TurnFact,
} from "./facts.js";

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  repository_path TEXT NOT NULL UNIQUE,
  lifecycle TEXT NOT NULL,
  ui_locale TEXT NOT NULL,
  prompt_locale TEXT NOT NULL,
  initialized INTEGER NOT NULL,
  current_checkpoint TEXT,
  selected_checkpoint TEXT,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  incarnation TEXT NOT NULL,
  phase TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  starting_checkpoint TEXT NOT NULL,
  current_queue_item_id TEXT,
  waiting_code TEXT,
  fault_json TEXT,
  stop_cutoff_sequence INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  stimulus_id TEXT,
  source_event_id TEXT,
  source_tool_call_id TEXT,
  status TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS stimuli (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  queue_item_id TEXT NOT NULL UNIQUE REFERENCES queue_items(id),
  idempotency_key TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  UNIQUE(persona_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  session_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL UNIQUE REFERENCES queue_items(id),
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  frozen_json TEXT,
  summary TEXT,
  memory_decision TEXT,
  checkpoint TEXT,
  created_at INTEGER NOT NULL,
  frozen_at INTEGER,
  closed_at INTEGER,
  checkpointed_at INTEGER,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  scope TEXT NOT NULL CHECK (scope IN ('event','closeout','compaction','hippocampus')),
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  starting_checkpoint TEXT NOT NULL,
  prompt_locale TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(source_event_id, sequence)
);

CREATE TABLE IF NOT EXISTS model_attempts (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  attempt INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(turn_id, attempt)
);

CREATE TABLE IF NOT EXISTS session_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_id TEXT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  sequence INTEGER NOT NULL,
  provider_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  effect TEXT NOT NULL,
  status TEXT NOT NULL,
  authorization_revision TEXT,
  dispatch_result_json TEXT,
  result_json TEXT,
  proposed_at INTEGER NOT NULL,
  intent_at INTEGER,
  dispatch_at INTEGER,
  outcome_at INTEGER,
  UNIQUE(turn_id, provider_call_id)
);

CREATE TABLE IF NOT EXISTS tool_callbacks (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(id),
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorization_decisions (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('proposal','dispatch')),
  allowed INTEGER NOT NULL,
  revision TEXT NOT NULL,
  reason TEXT,
  checked_at INTEGER NOT NULL,
  UNIQUE(tool_call_id, sequence)
);

CREATE TABLE IF NOT EXISTS checkpoint_intents (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  event_id TEXT UNIQUE,
  kind TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS checkpoints (
  commit_hash TEXT NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  event_id TEXT UNIQUE,
  summary TEXT NOT NULL,
  is_root INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(persona_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS publications (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hippocampus_jobs (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  source_checkpoint TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_locale TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  proposal_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_transactions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES hippocampus_jobs(id),
  phase TEXT NOT NULL,
  directory TEXT NOT NULL,
  before_manifest_json TEXT NOT NULL,
  after_manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  captured_checkpoint TEXT,
  force_reverted_at INTEGER
);

CREATE TABLE IF NOT EXISTS repository_operations (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  kind TEXT NOT NULL CHECK (kind IN ('restore','branch','clone','delete')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS observations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  run_id TEXT,
  event_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  persona_id TEXT PRIMARY KEY REFERENCES personas(id),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authority_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  snapshot_fingerprint TEXT
);
INSERT OR IGNORE INTO authority_state (singleton, revision, updated_at) VALUES (1, 1, 0);

CREATE INDEX IF NOT EXISTS queue_pending ON queue_items(run_id, status, sequence);
CREATE INDEX IF NOT EXISTS observations_persona ON observations(persona_id, sequence);
CREATE INDEX IF NOT EXISTS hippocampus_pending ON hippocampus_jobs(persona_id, status, created_at);
`;

const AUTHORITY_TABLES = [
  "personas",
  "runs",
  "queue_items",
  "stimuli",
  "events",
  "turns",
  "model_attempts",
  "session_entries",
  "tool_calls",
  "tool_callbacks",
  "authorization_decisions",
  "checkpoint_intents",
  "checkpoints",
  "publications",
  "hippocampus_jobs",
  "memory_transactions",
  "repository_operations",
  "observations",
  "leases",
] as const;

const AUTHORITY_TRIGGERS = AUTHORITY_TABLES.flatMap((table) =>
  (["INSERT", "UPDATE", "DELETE"] as const).map(
    (operation) => `
      CREATE TRIGGER IF NOT EXISTS authority_${table}_${operation.toLowerCase()}
      AFTER ${operation} ON ${table}
      BEGIN
        UPDATE authority_state
        SET revision = revision + 1,
            updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE singleton = 1;
      END;`,
  ),
).join("\n");

function encode(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function decode(value: unknown): JsonValue {
  return JSON.parse(String(value)) as JsonValue;
}

function nullableDecode(value: unknown): JsonValue | null {
  return value === null || value === undefined ? null : decode(value);
}

function isEmptyHippocampusProposal(value: unknown): boolean {
  const proposal = nullableDecode(value);
  return (
    typeof proposal === "object" &&
    proposal !== null &&
    !Array.isArray(proposal) &&
    Array.isArray(proposal["operations"]) &&
    proposal["operations"].length === 0
  );
}

function asNumber(value: unknown): number {
  return Number(value);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

type Row = Record<string, unknown>;

export class RuntimeFactStore {
  readonly path: string;
  readonly #database: DatabaseSync;
  readonly #observationListeners = new Set<(observation: ObservationFact) => void>();

  constructor(stateDirectory: string) {
    const directory = path.resolve(stateDirectory);
    mkdirSync(directory, { recursive: true });
    this.path = path.join(directory, "kokoro.sqlite3");
    this.#database = new DatabaseSync(this.path);
    this.#database.exec(SCHEMA);
    this.#migrateSchema();
    this.#database.exec(AUTHORITY_TRIGGERS);
  }

  #migrateSchema(): void {
    // BEGIN IMMEDIATE makes the inspection and alteration one cross-process
    // operation. Two runtimes may legitimately open an older state directory
    // at the same time.
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (
        !this.all("PRAGMA table_info(authority_state)").some(
          (column) => String(column["name"]) === "snapshot_fingerprint",
        )
      ) {
        this.#database.exec("ALTER TABLE authority_state ADD COLUMN snapshot_fingerprint TEXT");
      }
      const memoryTransactionColumns = new Set(
        this.all("PRAGMA table_info(memory_transactions)").map((column) => String(column["name"])),
      );
      if (!memoryTransactionColumns.has("captured_checkpoint")) {
        this.#database.exec("ALTER TABLE memory_transactions ADD COLUMN captured_checkpoint TEXT");
      }
      if (!memoryTransactionColumns.has("force_reverted_at")) {
        this.#database.exec("ALTER TABLE memory_transactions ADD COLUMN force_reverted_at INTEGER");
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    this.#migrateCheckpointPrimaryKey();

    const turnsSql = String(
      this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'")?.["sql"] ?? "",
    );
    if (turnsSql.includes("'compaction'")) return;

    // SQLite cannot widen a CHECK constraint in place. legacy_alter_table
    // keeps dependent foreign keys aimed at the replacement table name while
    // the old table is renamed and copied.
    this.#database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE");
    try {
      const lockedSql = String(
        this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'")?.["sql"] ?? "",
      );
      if (!lockedSql.includes("'compaction'")) {
        this.#database.exec(`
          ALTER TABLE turns RENAME TO turns_before_compaction_scope;
          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            event_id TEXT REFERENCES events(id),
            source_event_id TEXT NOT NULL REFERENCES events(id),
            scope TEXT NOT NULL CHECK (scope IN ('event','closeout','compaction','hippocampus')),
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            role TEXT NOT NULL,
            starting_checkpoint TEXT NOT NULL,
            prompt_locale TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            UNIQUE(source_event_id, sequence)
          );
          INSERT INTO turns
            (id, event_id, source_event_id, scope, session_id, sequence, role,
             starting_checkpoint, prompt_locale, status, created_at, completed_at)
          SELECT id, event_id, source_event_id, scope, session_id, sequence, role,
                 starting_checkpoint, prompt_locale, status, created_at, completed_at
          FROM turns_before_compaction_scope;
          DROP TABLE turns_before_compaction_scope;
        `);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#database.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON");
    }
    const violations = this.all("PRAGMA foreign_key_check");
    if (violations.length > 0) throw new Error("Store migration left invalid foreign-key references.");
  }

  #migrateCheckpointPrimaryKey(): void {
    const hasPersonaScopedPrimaryKey = () => {
      const columns = this.all("PRAGMA table_info(checkpoints)");
      const primaryKey = new Map(columns.map((column) => [String(column["name"]), asNumber(column["pk"])]));
      return primaryKey.get("persona_id") === 1 && primaryKey.get("commit_hash") === 2;
    };
    if (hasPersonaScopedPrimaryKey()) return;

    // A Git commit may legitimately seed more than one Persona through Clone.
    // Older stores made commit_hash globally unique, so rebuild the table with
    // the Persona-scoped key before any Clone can be registered silently as a
    // no-op. The locked recheck makes concurrent openers idempotent.
    this.#database.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE");
    try {
      if (!hasPersonaScopedPrimaryKey()) {
        this.#database.exec(`
          ALTER TABLE checkpoints RENAME TO checkpoints_before_persona_key;
          CREATE TABLE checkpoints (
            commit_hash TEXT NOT NULL,
            persona_id TEXT NOT NULL REFERENCES personas(id),
            event_id TEXT UNIQUE,
            summary TEXT NOT NULL,
            is_root INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(persona_id, commit_hash)
          );
          INSERT INTO checkpoints
            (commit_hash, persona_id, event_id, summary, is_root, created_at)
          SELECT commit_hash, persona_id, event_id, summary, is_root, created_at
          FROM checkpoints_before_persona_key;
          DROP TABLE checkpoints_before_persona_key;
        `);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#database.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON");
    }
    const violations = this.all("PRAGMA foreign_key_check");
    if (violations.length > 0) throw new Error("Checkpoint migration left invalid foreign-key references.");
  }

  close(): void {
    this.#database.close();
  }

  subscribeObservations(listener: (observation: ObservationFact) => void): () => void {
    this.#observationListeners.add(listener);
    return () => this.#observationListeners.delete(listener);
  }

  authorityState(): { revision: number; updatedAt: number } {
    const row = this.get("SELECT revision, updated_at FROM authority_state WHERE singleton = 1");
    if (!row) throw new Error("Authority state is unavailable.");
    return { revision: asNumber(row["revision"]), updatedAt: asNumber(row["updated_at"]) };
  }

  touchAuthority(now: number): { revision: number; updatedAt: number } {
    this.run("UPDATE authority_state SET revision = revision + 1, updated_at = ? WHERE singleton = 1", now);
    return this.authorityState();
  }

  reserveAuthorityRevision(
    expectedRevision: number,
    now: number,
  ): { accepted: boolean; actualRevision: number } {
    return this.transaction(() => {
      const current = this.authorityState();
      if (current.revision !== expectedRevision) {
        return { accepted: false, actualRevision: current.revision };
      }
      this.run("UPDATE authority_state SET revision = revision + 1, updated_at = ? WHERE singleton = 1", now);
      return { accepted: true, actualRevision: expectedRevision + 1 };
    });
  }

  /** Must be called while the caller holds this Store's write transaction. */
  stampAuthoritySnapshot(fingerprint: string, now: number): { revision: number; updatedAt: number } {
    const row = this.get(
      "SELECT revision, updated_at, snapshot_fingerprint FROM authority_state WHERE singleton = 1",
    );
    if (!row) throw new Error("Authority state is unavailable.");
    if (row["snapshot_fingerprint"] !== fingerprint) {
      this.run(
        `UPDATE authority_state
         SET revision = revision + 1, updated_at = ?, snapshot_fingerprint = ?
         WHERE singleton = 1`,
        now,
        fingerprint,
      );
      return this.authorityState();
    }
    return { revision: asNumber(row["revision"]), updatedAt: asNumber(row["updated_at"]) };
  }

  transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  createPersona(input: {
    id?: string;
    displayName?: string;
    repositoryPath: string;
    uiLocale: string;
    promptLocale: string;
    now: number;
  }): PersonaFact {
    const id = input.id ?? randomUUID();
    this.run(
      `INSERT INTO personas
       (id, display_name, repository_path, lifecycle, ui_locale, prompt_locale, initialized, revision, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?, 0, 1, ?)`,
      id,
      input.displayName ?? id,
      path.resolve(input.repositoryPath),
      input.uiLocale,
      input.promptLocale,
      input.now,
    );
    return this.requirePersona(id);
  }

  listPersonas(): PersonaFact[] {
    return this.all("SELECT * FROM personas WHERE deleted_at IS NULL ORDER BY created_at, id").map(
      personaFromRow,
    );
  }

  getPersona(id: string): PersonaFact | undefined {
    const row = this.get("SELECT * FROM personas WHERE id = ? AND deleted_at IS NULL", id);
    return row ? personaFromRow(row) : undefined;
  }

  requirePersona(id: string): PersonaFact {
    const persona = this.getPersona(id);
    if (!persona) throw new Error(`Persona not found: ${id}`);
    return persona;
  }

  updatePersona(
    id: string,
    patch: Partial<{
      lifecycle: PersonaLifecycle;
      uiLocale: string;
      promptLocale: string;
      initialized: boolean;
      currentCheckpoint: string | null;
      selectedCheckpoint: string | null;
    }>,
  ): PersonaFact {
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null): void => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.lifecycle !== undefined) add("lifecycle", patch.lifecycle);
    if (patch.uiLocale !== undefined) add("ui_locale", patch.uiLocale);
    if (patch.promptLocale !== undefined) add("prompt_locale", patch.promptLocale);
    if (patch.initialized !== undefined) add("initialized", patch.initialized ? 1 : 0);
    if ("currentCheckpoint" in patch) add("current_checkpoint", patch.currentCheckpoint ?? null);
    if ("selectedCheckpoint" in patch) add("selected_checkpoint", patch.selectedCheckpoint ?? null);
    if (columns.length === 0) return this.requirePersona(id);
    columns.push("revision = revision + 1");
    this.run(`UPDATE personas SET ${columns.join(", ")} WHERE id = ?`, ...values, id);
    return this.requirePersona(id);
  }

  markPersonaDeleted(id: string, now: number): void {
    this.run("UPDATE personas SET deleted_at = ?, revision = revision + 1 WHERE id = ?", now, id);
  }

  /** Must be called in the same transaction that tombstones the Persona. */
  settleDeletedPersonaObligations(personaId: string, now: number): void {
    this.run(
      `UPDATE tool_calls SET status = 'unknown', outcome_at = ?
       WHERE status IN ('dispatching','awaiting_callback')
         AND event_id IN (SELECT id FROM events WHERE persona_id = ?)`,
      now,
      personaId,
    );
    this.run(
      `UPDATE queue_items SET status = 'discarded', finished_at = ?
       WHERE status IN ('queued','started')
         AND run_id IN (SELECT id FROM runs WHERE persona_id = ?)`,
      now,
      personaId,
    );
    this.run(
      `UPDATE runs SET phase = 'crashed', current_queue_item_id = NULL,
         waiting_code = NULL, ended_at = COALESCE(ended_at, ?)
       WHERE persona_id = ? AND phase IN ('running','pausing','paused','stopping','forcing','faulted')`,
      now,
      personaId,
    );
    this.run(
      `UPDATE checkpoint_intents SET status = 'failed', completed_at = ?
       WHERE persona_id = ? AND status = 'prepared'`,
      now,
      personaId,
    );
    this.run(
      `UPDATE memory_transactions SET phase = 'conflict', completed_at = ?
       WHERE phase NOT IN ('completed','conflict','reverted')
         AND job_id IN (SELECT id FROM hippocampus_jobs WHERE persona_id = ?)`,
      now,
      personaId,
    );
    this.run(
      `UPDATE hippocampus_jobs SET status = 'conflict', error_json = ?, updated_at = ?
       WHERE persona_id = ? AND status != 'completed'`,
      encode({ code: "persona_deleted" }),
      now,
      personaId,
    );
  }

  createRun(input: {
    id?: string;
    personaId: string;
    incarnation: string;
    model: ModelRef;
    startingCheckpoint: string;
    now: number;
  }): RunFact {
    const id = input.id ?? randomUUID();
    const sessionId = randomUUID();
    this.transaction(() => {
      this.run(
        `INSERT INTO runs
         (id, persona_id, incarnation, phase, model_provider, model_id, session_id, starting_checkpoint, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        id,
        input.personaId,
        input.incarnation,
        input.model.provider,
        input.model.model,
        sessionId,
        input.startingCheckpoint,
        input.now,
      );
      this.updatePersona(input.personaId, {
        lifecycle: "running",
        selectedCheckpoint: input.startingCheckpoint,
      });
    });
    return this.requireRun(id);
  }

  getRun(id: string): RunFact | undefined {
    const row = this.get("SELECT * FROM runs WHERE id = ?", id);
    return row ? runFromRow(row) : undefined;
  }

  requireRun(id: string): RunFact {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  activeRun(personaId: string): RunFact | undefined {
    const row = this.get(
      `SELECT * FROM runs WHERE persona_id = ? AND phase IN ('running','pausing','paused','stopping','forcing','faulted')
       ORDER BY started_at DESC LIMIT 1`,
      personaId,
    );
    return row ? runFromRow(row) : undefined;
  }

  updateRun(
    id: string,
    patch: Partial<{
      phase: RunPhase;
      currentQueueItemId: string | null;
      waitingCode: string | null;
      fault: JsonValue | null;
      stopCutoffSequence: number | null;
      endedAt: number | null;
    }>,
  ): RunFact {
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null): void => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.phase !== undefined) add("phase", patch.phase);
    if ("currentQueueItemId" in patch) add("current_queue_item_id", patch.currentQueueItemId ?? null);
    if ("waitingCode" in patch) add("waiting_code", patch.waitingCode ?? null);
    if ("fault" in patch) add("fault_json", patch.fault === null ? null : encode(patch.fault as JsonValue));
    if ("stopCutoffSequence" in patch) add("stop_cutoff_sequence", patch.stopCutoffSequence ?? null);
    if ("endedAt" in patch) add("ended_at", patch.endedAt ?? null);
    if (columns.length > 0) this.run(`UPDATE runs SET ${columns.join(", ")} WHERE id = ?`, ...values, id);
    return this.requireRun(id);
  }

  enqueue(input: {
    runId: string;
    kind: QueueKind;
    payload: JsonValue;
    stimulusId?: string;
    sourceEventId?: string;
    sourceToolCallId?: string;
    now: number;
  }): QueueItemFact {
    return this.transaction(() => this.enqueueDirect(input));
  }

  acceptStimulus(input: {
    personaId: string;
    runId: string;
    kind: string;
    payload: JsonValue;
    idempotencyKey?: string;
    now: number;
  }): { stimulusId: string; item: QueueItemFact } {
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.personaId !== input.personaId) {
        throw new Error("The active run does not belong to the selected Persona.");
      }
      if (input.idempotencyKey !== undefined) {
        const existing = this.get(
          "SELECT * FROM stimuli WHERE persona_id = ? AND idempotency_key = ?",
          input.personaId,
          input.idempotencyKey,
        );
        if (existing) {
          if (
            String(existing["kind"]) !== input.kind ||
            String(existing["payload_json"]) !== encode(input.payload)
          ) {
            throw new Error("The stimulus idempotency key was already used for different content.");
          }
          return {
            stimulusId: String(existing["id"]),
            item: this.requireQueueItem(String(existing["queue_item_id"])),
          };
        }
      }
      const stimulusId = randomUUID();
      const item = this.enqueueDirect({
        runId: input.runId,
        kind: "stimulus",
        payload: { kind: input.kind, payload: input.payload },
        stimulusId,
        now: input.now,
      });
      this.run(
        `INSERT INTO stimuli (id, persona_id, run_id, queue_item_id, idempotency_key, kind, payload_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        stimulusId,
        input.personaId,
        input.runId,
        item.id,
        input.idempotencyKey ?? null,
        input.kind,
        encode(input.payload),
        input.now,
      );
      return { stimulusId, item };
    });
  }

  replayStimulus(input: {
    personaId: string;
    idempotencyKey: string;
    kind: string;
    payload: JsonValue;
  }): { stimulusId: string; item: QueueItemFact } | undefined {
    const existing = this.get(
      "SELECT * FROM stimuli WHERE persona_id = ? AND idempotency_key = ?",
      input.personaId,
      input.idempotencyKey,
    );
    if (!existing) return undefined;
    if (
      String(existing["kind"]) !== input.kind ||
      String(existing["payload_json"]) !== encode(input.payload)
    ) {
      throw new Error("The stimulus idempotency key was already used for different content.");
    }
    return {
      stimulusId: String(existing["id"]),
      item: this.requireQueueItem(String(existing["queue_item_id"])),
    };
  }

  nextQueued(runId: string): QueueItemFact | undefined {
    const row = this.get(
      "SELECT * FROM queue_items WHERE run_id = ? AND status = 'queued' ORDER BY sequence LIMIT 1",
      runId,
    );
    return row ? queueFromRow(row) : undefined;
  }

  requireQueueItem(id: string): QueueItemFact {
    const row = this.get("SELECT * FROM queue_items WHERE id = ?", id);
    if (!row) throw new Error(`Queue item not found: ${id}`);
    return queueFromRow(row);
  }

  listQueue(runId: string): QueueItemFact[] {
    return this.all("SELECT * FROM queue_items WHERE run_id = ? ORDER BY sequence", runId).map(queueFromRow);
  }

  maxQueueSequence(runId: string): number {
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) AS maximum FROM queue_items WHERE run_id = ?",
      runId,
    );
    return asNumber(row?.["maximum"] ?? 0);
  }

  markQueueStarted(id: string, now: number): void {
    this.run(
      "UPDATE queue_items SET status = 'started', started_at = ? WHERE id = ? AND status = 'queued'",
      now,
      id,
    );
  }

  markQueueCompleted(id: string, now: number): void {
    this.run("UPDATE queue_items SET status = 'completed', finished_at = ? WHERE id = ?", now, id);
  }

  discardRunQueue(runId: string, now: number): void {
    this.run(
      "UPDATE queue_items SET status = 'discarded', finished_at = ? WHERE run_id = ? AND status IN ('queued','started')",
      now,
      runId,
    );
  }

  createEvent(input: {
    id?: string;
    personaId: string;
    run: RunFact;
    item: QueueItemFact;
    now: number;
  }): EventFact {
    const id = input.id ?? randomUUID();
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE run_id = ?",
      input.run.id,
    );
    const sequence = asNumber(row?.["next"] ?? 1);
    this.run(
      `INSERT INTO events
       (id, persona_id, run_id, session_id, queue_item_id, sequence, status, source_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      input.personaId,
      input.run.id,
      input.run.sessionId,
      input.item.id,
      sequence,
      input.item.kind,
      input.now,
    );
    return this.requireEvent(id);
  }

  requireEvent(id: string): EventFact {
    const row = this.get("SELECT * FROM events WHERE id = ?", id);
    if (!row) throw new Error(`Event not found: ${id}`);
    return eventFromRow(row);
  }

  listEvents(personaId: string): EventFact[] {
    return this.all("SELECT * FROM events WHERE persona_id = ? ORDER BY created_at, sequence", personaId).map(
      eventFromRow,
    );
  }

  eventForQueueItem(queueItemId: string): EventFact | undefined {
    const row = this.get("SELECT * FROM events WHERE queue_item_id = ?", queueItemId);
    return row ? eventFromRow(row) : undefined;
  }

  latestCheckpoint(personaId: string): { commit: string; summary: string; createdAt: number } | undefined {
    const row = this.get(
      "SELECT commit_hash, summary, created_at FROM checkpoints WHERE persona_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      personaId,
    );
    return row
      ? {
          commit: String(row["commit_hash"]),
          summary: String(row["summary"]),
          createdAt: asNumber(row["created_at"]),
        }
      : undefined;
  }

  registeredCheckpoint(personaId: string, commit: string): RegisteredCheckpointFact | undefined {
    const row = this.get(
      `SELECT commit_hash, persona_id, summary, is_root, created_at
       FROM checkpoints WHERE persona_id = ? AND commit_hash = ?`,
      personaId,
      commit,
    );
    return row ? registeredCheckpointFromRow(row) : undefined;
  }

  registeredCheckpoints(
    personaId: string,
    before: string | null,
    limit: number,
  ): RegisteredCheckpointFact[] | undefined {
    const count = Math.max(1, Math.min(10_000, Math.floor(limit)));
    if (before === null) {
      return this.all(
        `SELECT commit_hash, persona_id, summary, is_root, created_at
         FROM checkpoints WHERE persona_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        personaId,
        count,
      ).map(registeredCheckpointFromRow);
    }
    const cursor = this.get(
      `SELECT created_at, rowid AS checkpoint_rowid
       FROM checkpoints WHERE persona_id = ? AND commit_hash = ?`,
      personaId,
      before,
    );
    if (!cursor) return undefined;
    return this.all(
      `SELECT commit_hash, persona_id, summary, is_root, created_at
       FROM checkpoints
       WHERE persona_id = ?
         AND (created_at < ? OR (created_at = ? AND rowid < ?))
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      personaId,
      asNumber(cursor["created_at"]),
      asNumber(cursor["created_at"]),
      asNumber(cursor["checkpoint_rowid"]),
      count,
    ).map(registeredCheckpointFromRow);
  }

  registerExistingCheckpoint(input: {
    personaId: string;
    commit: string;
    summary: string;
    root: boolean;
    now: number;
  }): void {
    this.transaction(() => {
      this.run(
        `INSERT OR IGNORE INTO checkpoints (commit_hash, persona_id, event_id, summary, is_root, created_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
        input.commit,
        input.personaId,
        input.summary,
        input.root ? 1 : 0,
        input.now,
      );
      this.updatePersona(input.personaId, {
        initialized: true,
        currentCheckpoint: input.commit,
        selectedCheckpoint: input.commit,
        lifecycle: "ready",
      });
    });
  }

  adoptCloneOperation(input: {
    operationId: string;
    sourcePersonaId: string;
    personaId: string;
    displayName: string;
    repositoryPath: string;
    uiLocale: string;
    promptLocale: string;
    commit: string;
    summary: string;
    now: number;
  }): PersonaFact {
    return this.transaction(() => {
      const operation = this.get(
        "SELECT persona_id, kind, status FROM repository_operations WHERE id = ?",
        input.operationId,
      );
      if (
        !operation ||
        String(operation["persona_id"]) !== input.sourcePersonaId ||
        String(operation["kind"]) !== "clone" ||
        String(operation["status"]) !== "prepared"
      ) {
        throw new Error("Clone adoption requires its matching prepared Repository operation.");
      }
      const repositoryPath = path.resolve(input.repositoryPath);
      const existingRow = this.get("SELECT * FROM personas WHERE id = ?", input.personaId);
      if (!existingRow) {
        this.run(
          `INSERT INTO personas
           (id, display_name, repository_path, lifecycle, ui_locale, prompt_locale, initialized, revision, created_at)
           VALUES (?, ?, ?, 'draft', ?, ?, 0, 1, ?)`,
          input.personaId,
          input.displayName,
          repositoryPath,
          input.uiLocale,
          input.promptLocale,
          input.now,
        );
      } else {
        const existing = personaFromRow(existingRow);
        const exactDraft =
          existing.lifecycle === "draft" &&
          !existing.initialized &&
          existing.currentCheckpoint === null &&
          existing.selectedCheckpoint === null;
        const exactCompleted =
          existing.lifecycle === "ready" &&
          existing.initialized &&
          existing.currentCheckpoint === input.commit &&
          existing.selectedCheckpoint === input.commit;
        if (
          existingRow["deleted_at"] !== null ||
          existing.displayName !== input.displayName ||
          existing.repositoryPath !== repositoryPath ||
          existing.uiLocale !== input.uiLocale ||
          existing.promptLocale !== input.promptLocale ||
          (!exactDraft && !exactCompleted)
        ) {
          throw new Error("The Clone Persona identity conflicts with an existing Persona.");
        }
      }
      const existingCheckpoint = this.get(
        `SELECT summary, is_root FROM checkpoints
         WHERE persona_id = ? AND commit_hash = ?`,
        input.personaId,
        input.commit,
      );
      if (
        existingCheckpoint &&
        (String(existingCheckpoint["summary"]) !== input.summary ||
          asNumber(existingCheckpoint["is_root"]) !== 1)
      ) {
        throw new Error("The Clone root Checkpoint conflicts with an existing fact.");
      }
      this.run(
        `INSERT OR IGNORE INTO checkpoints
         (commit_hash, persona_id, event_id, summary, is_root, created_at)
         VALUES (?, ?, NULL, ?, 1, ?)`,
        input.commit,
        input.personaId,
        input.summary,
        input.now,
      );
      this.updatePersona(input.personaId, {
        initialized: true,
        currentCheckpoint: input.commit,
        selectedCheckpoint: input.commit,
        lifecycle: "ready",
      });
      this.completeRepositoryOperation(input.operationId, input.now);
      return this.requirePersona(input.personaId);
    });
  }

  promptLocaleForEvent(eventId: string): string | undefined {
    const row = this.get(
      "SELECT prompt_locale FROM turns WHERE event_id = ? AND role = 'persona' ORDER BY sequence LIMIT 1",
      eventId,
    );
    return row ? String(row["prompt_locale"]) : undefined;
  }

  committedEventsMissingPublication(): EventFact[] {
    return this.all(
      `SELECT events.* FROM events
       LEFT JOIN publications ON publications.event_id = events.id
       WHERE events.status = 'checkpointed' AND publications.event_id IS NULL
       ORDER BY events.checkpointed_at, events.id`,
    ).map(eventFromRow);
  }

  pendingPublicationCount(personaId: string): number {
    const row = this.get(
      `SELECT COUNT(*) AS pending FROM events
       LEFT JOIN publications ON publications.event_id = events.id
       WHERE events.persona_id = ? AND events.status = 'checkpointed'
         AND publications.event_id IS NULL`,
      personaId,
    );
    return asNumber(row?.["pending"] ?? 0);
  }

  committedEventsMissingHippocampusJob(): EventFact[] {
    return this.all(
      `SELECT events.* FROM events
       LEFT JOIN hippocampus_jobs ON hippocampus_jobs.event_id = events.id
       WHERE events.status = 'checkpointed' AND events.memory_decision = 'maintain'
         AND hippocampus_jobs.event_id IS NULL
       ORDER BY events.checkpointed_at, events.id`,
    ).map(eventFromRow);
  }

  freezeEvent(id: string, frozen: JsonValue, now: number): void {
    assertCredentialFree(encode(frozen), "frozen Event");
    this.run(
      "UPDATE events SET status = 'frozen', frozen_json = ?, frozen_at = ? WHERE id = ? AND status = 'open'",
      encode(frozen),
      now,
      id,
    );
  }

  closeEvent(id: string, summary: string, memory: "none" | "maintain", now: number): void {
    assertCredentialFree(summary, "Event closeout");
    this.run(
      `UPDATE events SET status = 'closed', summary = ?, memory_decision = ?, closed_at = ?
       WHERE id = ? AND status = 'frozen'`,
      summary,
      memory,
      now,
      id,
    );
  }

  checkpointEvent(id: string, commit: string, now: number): void {
    this.run(
      `UPDATE events SET status = 'checkpointed', checkpoint = ?, checkpointed_at = ?
       WHERE id = ? AND status IN ('closed','faulted')`,
      commit,
      now,
      id,
    );
  }

  faultEvent(id: string, now: number): void {
    this.run(
      "UPDATE events SET status = 'faulted', closed_at = COALESCE(closed_at, ?) WHERE id = ? AND status != 'checkpointed'",
      now,
      id,
    );
  }

  createTurn(input: {
    eventId: string | null;
    sourceEventId: string;
    scope: "event" | "closeout" | "compaction" | "hippocampus";
    sessionId: string;
    role: string;
    startingCheckpoint: string;
    promptLocale: string;
    now: number;
  }): string {
    const source = this.requireEvent(input.sourceEventId);
    if (input.scope === "event") {
      if (input.eventId !== input.sourceEventId || source.status !== "open") {
        throw new Error("Event-owned Turns may only be added while their Event is open.");
      }
    } else {
      if (input.eventId !== null) throw new Error("Derived Turns cannot be Event-owned children.");
      if (input.scope === "closeout" && source.status !== "frozen") {
        throw new Error("Closeout Turns require a frozen source Event.");
      }
      if (input.scope === "compaction" && source.status !== "open") {
        throw new Error("Compaction Turns require an open source Event.");
      }
      if (input.scope === "hippocampus" && source.status !== "checkpointed") {
        throw new Error("Hippocampus Turns require a checkpointed source Event.");
      }
    }
    const id = randomUUID();
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE source_event_id = ?",
      input.sourceEventId,
    );
    this.run(
      `INSERT INTO turns
       (id, event_id, source_event_id, scope, session_id, sequence, role, starting_checkpoint,
        prompt_locale, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      id,
      input.eventId,
      input.sourceEventId,
      input.scope,
      input.sessionId,
      asNumber(row?.["next"] ?? 1),
      input.role,
      input.startingCheckpoint,
      input.promptLocale,
      input.now,
    );
    return id;
  }

  completeTurn(id: string, status: "completed" | "failed", now: number): void {
    this.run("UPDATE turns SET status = ?, completed_at = ? WHERE id = ?", status, now, id);
  }

  turnsForEvent(eventId: string): TurnFact[] {
    return this.all("SELECT * FROM turns WHERE event_id = ? ORDER BY sequence", eventId).map(turnFromRow);
  }

  turnsForSourceEvent(eventId: string): TurnFact[] {
    return this.all("SELECT * FROM turns WHERE source_event_id = ? ORDER BY sequence", eventId).map(
      turnFromRow,
    );
  }

  createModelAttempt(input: { turnId: string; attempt: number; request: JsonValue; now: number }): string {
    assertCredentialFree(encode(input.request), "model request");
    const id = randomUUID();
    this.run(
      `INSERT INTO model_attempts (id, turn_id, attempt, request_json, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      id,
      input.turnId,
      input.attempt,
      encode(input.request),
      input.now,
    );
    return id;
  }

  completeModelAttempt(id: string, response: JsonValue, now: number): void {
    assertCredentialFree(encode(response), "model response");
    this.run(
      "UPDATE model_attempts SET response_json = ?, status = 'completed', completed_at = ? WHERE id = ?",
      encode(response),
      now,
      id,
    );
  }

  failModelAttempt(id: string, errorCode: string, now: number): void {
    this.run(
      "UPDATE model_attempts SET status = 'failed', error_code = ?, completed_at = ? WHERE id = ?",
      errorCode,
      now,
      id,
    );
  }

  appendSessionEntry(input: {
    sessionId: string;
    eventId?: string;
    kind: SessionEntryFact["kind"];
    payload: JsonValue;
    now: number;
  }): SessionEntryFact {
    assertCredentialFree(encode(input.payload), "Session entry");
    const id = randomUUID();
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM session_entries WHERE session_id = ?",
      input.sessionId,
    );
    this.run(
      `INSERT INTO session_entries (id, session_id, event_id, sequence, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId,
      input.eventId ?? null,
      asNumber(row?.["next"] ?? 1),
      input.kind,
      encode(input.payload),
      input.now,
    );
    return this.sessionEntries(input.sessionId).at(-1) as SessionEntryFact;
  }

  sessionEntries(sessionId: string): SessionEntryFact[] {
    return this.all("SELECT * FROM session_entries WHERE session_id = ? ORDER BY sequence", sessionId).map(
      sessionEntryFromRow,
    );
  }

  sessionEntriesForEvent(eventId: string): SessionEntryFact[] {
    return this.all("SELECT * FROM session_entries WHERE event_id = ? ORDER BY sequence", eventId).map(
      sessionEntryFromRow,
    );
  }

  proposeToolCall(input: {
    eventId: string;
    turnId: string;
    providerCallId: string;
    name: string;
    arguments: Record<string, JsonValue>;
    effect: ToolCallFact["effect"];
    now: number;
  }): ToolCallFact {
    assertCredentialFree(encode(input.arguments), "Tool proposal");
    const id = randomUUID();
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM tool_calls WHERE event_id = ?",
      input.eventId,
    );
    this.run(
      `INSERT INTO tool_calls
       (id, event_id, turn_id, sequence, provider_call_id, name, arguments_json, effect, status, proposed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      id,
      input.eventId,
      input.turnId,
      asNumber(row?.["next"] ?? 1),
      input.providerCallId,
      input.name,
      encode(input.arguments),
      input.effect,
      input.now,
    );
    return this.requireToolCall(id);
  }

  requireToolCall(id: string): ToolCallFact {
    const row = this.get("SELECT * FROM tool_calls WHERE id = ?", id);
    if (!row) throw new Error(`Tool call not found: ${id}`);
    return toolCallFromRow(row);
  }

  toolCallsForEvent(eventId: string): ToolCallFact[] {
    return this.all("SELECT * FROM tool_calls WHERE event_id = ? ORDER BY sequence", eventId).map(
      toolCallFromRow,
    );
  }

  toolCallsForPersona(personaId: string): ToolCallFact[] {
    return this.all(
      `SELECT tool_calls.* FROM tool_calls
       JOIN events ON events.id = tool_calls.event_id
       WHERE events.persona_id = ? ORDER BY tool_calls.proposed_at, tool_calls.id`,
      personaId,
    ).map(toolCallFromRow);
  }

  setToolCallState(
    id: string,
    status: ToolCallFact["status"],
    patch: { authorizationRevision?: string; dispatchResult?: JsonValue; result?: JsonValue; now: number },
  ): ToolCallFact {
    if (patch.dispatchResult !== undefined)
      assertCredentialFree(encode(patch.dispatchResult), "Tool dispatch receipt");
    if (patch.result !== undefined) assertCredentialFree(encode(patch.result), "Tool result");
    const timeColumn =
      status === "intent_recorded" ? "intent_at" : status === "dispatching" ? "dispatch_at" : "outcome_at";
    this.run(
      `UPDATE tool_calls SET status = ?, authorization_revision = COALESCE(?, authorization_revision),
       dispatch_result_json = COALESCE(?, dispatch_result_json),
       result_json = COALESCE(?, result_json), ${timeColumn} = ? WHERE id = ?`,
      status,
      patch.authorizationRevision ?? null,
      patch.dispatchResult === undefined ? null : encode(patch.dispatchResult),
      patch.result === undefined ? null : encode(patch.result),
      patch.now,
      id,
    );
    return this.requireToolCall(id);
  }

  markDispatchingUnknown(now: number, runId?: string): ToolCallFact[] {
    return this.transaction(() => {
      const rows = runId
        ? this.all(
            `SELECT tool_calls.* FROM tool_calls
             JOIN events ON events.id = tool_calls.event_id
             WHERE tool_calls.status IN ('dispatching','awaiting_callback') AND events.run_id = ?
             ORDER BY tool_calls.proposed_at, tool_calls.id`,
            runId,
          )
        : this.all(
            `SELECT * FROM tool_calls WHERE status IN ('dispatching','awaiting_callback')
             ORDER BY proposed_at, id`,
          );
      if (rows.length === 0) return [];
      if (runId) {
        this.run(
          `UPDATE tool_calls SET status = 'unknown', outcome_at = ?
           WHERE status IN ('dispatching','awaiting_callback')
             AND event_id IN (SELECT id FROM events WHERE run_id = ?)`,
          now,
          runId,
        );
      } else {
        this.run(
          `UPDATE tool_calls SET status = 'unknown', outcome_at = ?
           WHERE status IN ('dispatching','awaiting_callback')`,
          now,
        );
      }
      return rows.map((row) => this.requireToolCall(String(row["id"])));
    });
  }

  recordCallback(input: {
    callbackId: string;
    toolCallId: string;
    payload: JsonValue;
    status: "succeeded" | "failed" | "unknown";
    now: number;
  }): { callbackId: string; recorded: boolean } {
    assertCredentialFree(encode(input.payload), "Tool callback");
    return this.transaction(() => {
      const byId = this.get("SELECT * FROM tool_callbacks WHERE id = ?", input.callbackId);
      if (byId) {
        if (
          String(byId["tool_call_id"]) !== input.toolCallId ||
          String(byId["payload_json"]) !== encode(input.payload)
        ) {
          throw new Error("The callback id was already used for different content.");
        }
        return { callbackId: input.callbackId, recorded: false };
      }
      const byTool = this.get("SELECT * FROM tool_callbacks WHERE tool_call_id = ?", input.toolCallId);
      if (byTool) throw new Error("The ToolCall already has a final callback.");
      const call = this.requireToolCall(input.toolCallId);
      if (call.status !== "awaiting_callback" && call.status !== "unknown") {
        throw new Error("The ToolCall is not awaiting a callback.");
      }
      this.run(
        `INSERT INTO tool_callbacks (id, tool_call_id, payload_json, received_at)
         VALUES (?, ?, ?, ?)`,
        input.callbackId,
        input.toolCallId,
        encode(input.payload),
        input.now,
      );
      this.setToolCallState(input.toolCallId, input.status, { result: input.payload, now: input.now });
      return { callbackId: input.callbackId, recorded: true };
    });
  }

  callbackForToolCall(
    toolCallId: string,
  ): { callbackId: string; payload: JsonValue; receivedAt: number } | undefined {
    const row = this.get("SELECT * FROM tool_callbacks WHERE tool_call_id = ?", toolCallId);
    return row
      ? {
          callbackId: String(row["id"]),
          payload: decode(row["payload_json"]),
          receivedAt: asNumber(row["received_at"]),
        }
      : undefined;
  }

  recordAuthorizationDecision(input: {
    toolCallId: string;
    stage: "proposal" | "dispatch";
    allow: boolean;
    revision: string;
    reason?: string;
    now: number;
  }): AuthorizationDecisionFact {
    assertCredentialFree(input.revision, "authorization revision");
    if (input.reason !== undefined) assertCredentialFree(input.reason, "authorization reason");
    const id = randomUUID();
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM authorization_decisions WHERE tool_call_id = ?",
      input.toolCallId,
    );
    this.run(
      `INSERT INTO authorization_decisions
       (id, tool_call_id, sequence, stage, allowed, revision, reason, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.toolCallId,
      asNumber(row?.["next"] ?? 1),
      input.stage,
      input.allow ? 1 : 0,
      input.revision,
      input.reason ?? null,
      input.now,
    );
    return this.authorizationDecisionsForToolCall(input.toolCallId).at(-1) as AuthorizationDecisionFact;
  }

  authorizationDecisionsForToolCall(toolCallId: string): AuthorizationDecisionFact[] {
    return this.all(
      "SELECT * FROM authorization_decisions WHERE tool_call_id = ? ORDER BY sequence",
      toolCallId,
    ).map(authorizationDecisionFromRow);
  }

  saveCheckpointIntent(input: {
    personaId: string;
    eventId?: string;
    kind: "root" | "event";
    commit: string;
    plan: JsonValue;
    now: number;
  }): string {
    const id = randomUUID();
    this.transaction(() => {
      this.run(
        `INSERT INTO checkpoint_intents (id, persona_id, event_id, kind, plan_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'prepared', ?)`,
        id,
        input.personaId,
        input.eventId ?? null,
        input.kind,
        encode(input.plan),
        input.now,
      );
      // Event Checkpoint preparation and Memory apply share the Repository
      // mutex. Persisting the intent is the Checkpoint linearization point:
      // the prepared plan is immutable and recovery must complete it. Only
      // transactions already complete at this exact point are therefore
      // known to be represented (or superseded by Owner bytes) in its tree.
      this.run(
        `UPDATE memory_transactions
         SET captured_checkpoint = ?
         WHERE phase = 'completed'
           AND captured_checkpoint IS NULL
           AND force_reverted_at IS NULL
           AND job_id IN (SELECT id FROM hippocampus_jobs WHERE persona_id = ?)`,
        input.commit,
        input.personaId,
      );
    });
    return id;
  }

  completeCheckpointIntent(input: {
    intentId: string;
    personaId: string;
    eventId?: string;
    commit: string;
    summary: string;
    root: boolean;
    preservePersonaSelection?: boolean;
    now: number;
  }): void {
    this.transaction(() => {
      this.run(
        "UPDATE checkpoint_intents SET status = 'completed', completed_at = ? WHERE id = ?",
        input.now,
        input.intentId,
      );
      this.run(
        `INSERT OR IGNORE INTO checkpoints (commit_hash, persona_id, event_id, summary, is_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.commit,
        input.personaId,
        input.eventId ?? null,
        input.summary,
        input.root ? 1 : 0,
        input.now,
      );
      if (!input.preservePersonaSelection) {
        this.updatePersona(input.personaId, {
          initialized: true,
          currentCheckpoint: input.commit,
          selectedCheckpoint: input.commit,
          lifecycle: input.root ? "ready" : this.requirePersona(input.personaId).lifecycle,
        });
      }
      if (input.eventId) this.checkpointEvent(input.eventId, input.commit, input.now);
    });
  }

  preparedCheckpointIntents(
    personaId: string,
  ): Array<{ id: string; eventId: string | null; kind: string; plan: JsonValue }> {
    return this.all(
      "SELECT id, event_id, kind, plan_json FROM checkpoint_intents WHERE persona_id = ? AND status = 'prepared' ORDER BY created_at",
      personaId,
    ).map((row) => ({
      id: String(row["id"]),
      eventId: row["event_id"] ? String(row["event_id"]) : null,
      kind: String(row["kind"]),
      plan: decode(row["plan_json"]),
    }));
  }

  allPreparedCheckpointIntents(): Array<{
    id: string;
    personaId: string;
    eventId: string | null;
    kind: string;
    plan: JsonValue;
    createdAt: number;
  }> {
    return this.all(
      "SELECT id, persona_id, event_id, kind, plan_json, created_at FROM checkpoint_intents WHERE status = 'prepared' ORDER BY created_at",
    ).map((row) => ({
      id: String(row["id"]),
      personaId: String(row["persona_id"]),
      eventId: row["event_id"] ? String(row["event_id"]) : null,
      kind: String(row["kind"]),
      plan: decode(row["plan_json"]),
      createdAt: asNumber(row["created_at"]),
    }));
  }

  failCheckpointIntent(id: string, now: number): void {
    this.run("UPDATE checkpoint_intents SET status = 'failed', completed_at = ? WHERE id = ?", now, id);
  }

  publishEvent(personaId: string, eventId: string, payload: JsonValue, now: number): number {
    assertCredentialFree(encode(payload), "event publication");
    this.run(
      "INSERT OR IGNORE INTO publications (persona_id, event_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
      personaId,
      eventId,
      encode(payload),
      now,
    );
    const row = this.get("SELECT sequence FROM publications WHERE event_id = ?", eventId);
    return asNumber(row?.["sequence"]);
  }

  publications(
    personaId: string,
    after = 0,
  ): Array<{ sequence: number; eventId: string; payload: JsonValue; createdAt: number }> {
    return this.all(
      "SELECT * FROM publications WHERE persona_id = ? AND sequence > ? ORDER BY sequence",
      personaId,
      after,
    ).map((row) => ({
      sequence: asNumber(row["sequence"]),
      eventId: String(row["event_id"]),
      payload: decode(row["payload_json"]),
      createdAt: asNumber(row["created_at"]),
    }));
  }

  publicationForEvent(eventId: string): { sequence: number; createdAt: number } | undefined {
    const row = this.get("SELECT sequence, created_at FROM publications WHERE event_id = ?", eventId);
    return row ? { sequence: asNumber(row["sequence"]), createdAt: asNumber(row["created_at"]) } : undefined;
  }

  appendObservation(input: {
    personaId: string;
    runId?: string;
    eventId?: string;
    kind: string;
    payload: JsonValue;
    now: number;
  }): ObservationFact {
    const encoded = encode(input.payload);
    assertCredentialFree(encoded, "observation");
    const result = this.run(
      `INSERT INTO observations (persona_id, run_id, event_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.personaId,
      input.runId ?? null,
      input.eventId ?? null,
      input.kind,
      encoded,
      input.now,
    );
    const row = this.get("SELECT * FROM observations WHERE sequence = ?", Number(result.lastInsertRowid));
    if (!row) throw new Error("Observation insert was not visible.");
    const observation = observationFromRow(row);
    for (const listener of this.#observationListeners) {
      try {
        listener(observation);
      } catch {
        // Observation consumers cannot alter committed Runtime facts.
      }
    }
    return observation;
  }

  observations(personaId: string, after = 0, limit = 1_000): ObservationFact[] {
    return this.all(
      "SELECT * FROM observations WHERE persona_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      personaId,
      after,
      Math.max(1, Math.min(10_000, Math.floor(limit))),
    ).map(observationFromRow);
  }

  observationExists(eventId: string, kind: string): boolean {
    return (
      this.get(
        "SELECT 1 AS present FROM observations WHERE event_id = ? AND kind = ? LIMIT 1",
        eventId,
        kind,
      ) !== undefined
    );
  }

  latestObservation(eventId: string, kind: string): ObservationFact | undefined {
    const row = this.get(
      "SELECT * FROM observations WHERE event_id = ? AND kind = ? ORDER BY sequence DESC LIMIT 1",
      eventId,
      kind,
    );
    return row ? observationFromRow(row) : undefined;
  }

  createHippocampusJob(input: {
    personaId: string;
    eventId: string;
    sourceCheckpoint: string;
    model: ModelRef;
    promptLocale: string;
    now: number;
  }): HippocampusJobFact {
    const existing = this.get("SELECT * FROM hippocampus_jobs WHERE event_id = ?", input.eventId);
    if (existing) return hippocampusFromRow(existing);
    const event = this.requireEvent(input.eventId);
    if (
      event.personaId !== input.personaId ||
      event.status !== "checkpointed" ||
      event.checkpoint !== input.sourceCheckpoint ||
      event.memoryDecision !== "maintain"
    ) {
      throw new Error("Hippocampus work requires its matching checkpointed maintain Event.");
    }
    const id = randomUUID();
    this.run(
      `INSERT INTO hippocampus_jobs
       (id, persona_id, event_id, source_checkpoint, model_provider, model_id, prompt_locale, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      id,
      input.personaId,
      input.eventId,
      input.sourceCheckpoint,
      input.model.provider,
      input.model.model,
      input.promptLocale,
      input.now,
      input.now,
    );
    return this.requireHippocampusJob(id);
  }

  requireHippocampusJob(id: string): HippocampusJobFact {
    const row = this.get("SELECT * FROM hippocampus_jobs WHERE id = ?", id);
    if (!row) throw new Error(`Hippocampus job not found: ${id}`);
    return hippocampusFromRow(row);
  }

  nextHippocampusJob(personaId: string): HippocampusJobFact | undefined {
    const row = this.get(
      `SELECT hippocampus_jobs.* FROM hippocampus_jobs
       JOIN events ON events.id = hippocampus_jobs.event_id
       WHERE hippocampus_jobs.persona_id = ? AND hippocampus_jobs.status != 'completed'
       ORDER BY events.checkpointed_at, events.id LIMIT 1`,
      personaId,
    );
    if (!row) return undefined;
    const job = hippocampusFromRow(row);
    return job.status === "queued" || job.status === "retry" ? job : undefined;
  }

  listHippocampusJobs(personaId: string): HippocampusJobFact[] {
    return this.all("SELECT * FROM hippocampus_jobs WHERE persona_id = ? ORDER BY created_at", personaId).map(
      hippocampusFromRow,
    );
  }

  hasRunnableHippocampusWork(personaId: string): boolean {
    const row = this.get(
      `SELECT hippocampus_jobs.status FROM hippocampus_jobs
       JOIN events ON events.id = hippocampus_jobs.event_id
       WHERE hippocampus_jobs.persona_id = ? AND hippocampus_jobs.status != 'completed'
       ORDER BY events.checkpointed_at, events.id LIMIT 1`,
      personaId,
    );
    const status = row ? String(row["status"]) : null;
    return status === "queued" || status === "retry" || status === "running" || status === "applying";
  }

  updateHippocampusJob(
    id: string,
    patch: Partial<{
      status: HippocampusJobFact["status"];
      attempts: number;
      proposal: JsonValue | null;
      error: JsonValue | null;
    }>,
    now: number,
  ): HippocampusJobFact {
    const columns: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [now];
    const add = (column: string, value: string | number | null): void => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.attempts !== undefined) add("attempts", patch.attempts);
    if ("proposal" in patch)
      add("proposal_json", patch.proposal === null ? null : encode(patch.proposal as JsonValue));
    if ("error" in patch) add("error_json", patch.error === null ? null : encode(patch.error as JsonValue));
    this.run(`UPDATE hippocampus_jobs SET ${columns.join(", ")} WHERE id = ?`, ...values, id);
    return this.requireHippocampusJob(id);
  }

  saveMemoryTransaction(input: {
    id: string;
    jobId: string;
    phase: string;
    directory: string;
    beforeManifest: JsonValue;
    afterManifest: JsonValue;
    now: number;
  }): void {
    this.run(
      `INSERT INTO memory_transactions
       (id, job_id, phase, directory, before_manifest_json, after_manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.jobId,
      input.phase,
      input.directory,
      encode(input.beforeManifest),
      encode(input.afterManifest),
      input.now,
    );
  }

  updateMemoryTransaction(id: string, phase: string, now?: number): void {
    this.run(
      "UPDATE memory_transactions SET phase = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?",
      phase,
      now ?? null,
      id,
    );
  }

  memoryTransactions(): Array<{
    id: string;
    jobId: string;
    phase: string;
    directory: string;
    beforeManifest: JsonValue;
    afterManifest: JsonValue;
  }> {
    return this.all(
      "SELECT * FROM memory_transactions WHERE phase NOT IN ('completed','conflict','reverted') ORDER BY created_at",
    ).map((row) => ({
      id: String(row["id"]),
      jobId: String(row["job_id"]),
      phase: String(row["phase"]),
      directory: String(row["directory"]),
      beforeManifest: decode(row["before_manifest_json"]),
      afterManifest: decode(row["after_manifest_json"]),
    }));
  }

  pendingMemoryTransaction(personaId: string): string | undefined {
    const row = this.get(
      `SELECT memory_transactions.id
       FROM memory_transactions
       JOIN hippocampus_jobs ON hippocampus_jobs.id = memory_transactions.job_id
       WHERE hippocampus_jobs.persona_id = ?
         AND memory_transactions.phase NOT IN ('completed','conflict','reverted')
       ORDER BY memory_transactions.created_at, memory_transactions.id
       LIMIT 1`,
      personaId,
    );
    return row === undefined ? undefined : String(row["id"]);
  }

  memoryTransactionForJob(jobId: string):
    | {
        id: string;
        phase: string;
        capturedCheckpoint: string | null;
        forceRevertedAt: number | null;
      }
    | undefined {
    const row = this.get(
      `SELECT id, phase, captured_checkpoint, force_reverted_at
       FROM memory_transactions WHERE job_id = ?
       ORDER BY (force_reverted_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1`,
      jobId,
    );
    return row
      ? {
          id: String(row["id"]),
          phase: String(row["phase"]),
          capturedCheckpoint: row["captured_checkpoint"] === null ? null : String(row["captured_checkpoint"]),
          forceRevertedAt: asNullableNumber(row["force_reverted_at"]),
        }
      : undefined;
  }

  saveRepositoryOperation(input: {
    id?: string;
    personaId: string;
    kind: "restore" | "branch" | "clone" | "delete";
    payload: JsonValue;
    now: number;
  }): string {
    assertCredentialFree(encode(input.payload), "repository operation");
    const id = input.id ?? randomUUID();
    this.run(
      `INSERT INTO repository_operations (id, persona_id, kind, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, 'prepared', ?)`,
      id,
      input.personaId,
      input.kind,
      encode(input.payload),
      input.now,
    );
    return id;
  }

  preparedRepositoryOperations(): Array<{
    id: string;
    personaId: string;
    kind: "restore" | "branch" | "clone" | "delete";
    payload: JsonValue;
    createdAt: number;
  }> {
    return this.all(
      "SELECT * FROM repository_operations WHERE status = 'prepared' ORDER BY created_at, id",
    ).map((row) => ({
      id: String(row["id"]),
      personaId: String(row["persona_id"]),
      kind: String(row["kind"]) as "restore" | "branch" | "clone" | "delete",
      payload: decode(row["payload_json"]),
      createdAt: asNumber(row["created_at"]),
    }));
  }

  completeRepositoryOperation(id: string, now: number): void {
    this.run("UPDATE repository_operations SET status = 'completed', completed_at = ? WHERE id = ?", now, id);
  }

  failRepositoryOperation(id: string, now: number): void {
    this.run(
      "UPDATE repository_operations SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'prepared'",
      now,
      id,
    );
  }

  recoverInterruptedHippocampusJobs(now: number, personaId?: string): void {
    this.transaction(() => {
      this.run(
        `UPDATE hippocampus_jobs SET status = 'completed', updated_at = ?
         WHERE status = 'applying' AND id IN (
           SELECT job_id FROM memory_transactions WHERE phase = 'completed'
         ) AND (? IS NULL OR persona_id = ?)`,
        now,
        personaId ?? null,
        personaId ?? null,
      );
      this.run(
        `UPDATE hippocampus_jobs SET status = 'conflict', updated_at = ?
         WHERE status = 'applying' AND id IN (
           SELECT job_id FROM memory_transactions WHERE phase = 'conflict'
         ) AND (? IS NULL OR persona_id = ?)`,
        now,
        personaId ?? null,
        personaId ?? null,
      );
      this.run(
        `UPDATE hippocampus_jobs SET status = 'retry', updated_at = ?
         WHERE (status = 'running'
            OR (status = 'applying' AND id NOT IN (
               SELECT job_id FROM memory_transactions WHERE phase NOT IN ('completed','conflict','reverted')
            ))) AND (? IS NULL OR persona_id = ?)`,
        now,
        personaId ?? null,
        personaId ?? null,
      );
    });
  }

  requeueHippocampusAfterForce(
    personaId: string,
    now: number,
    interruptedJobIds: readonly string[] = [],
  ): HippocampusJobFact[] {
    return this.transaction(() => {
      const interrupted = new Set(interruptedJobIds);
      const ids: string[] = [];
      for (const row of this.all(
        `SELECT id, status, proposal_json FROM hippocampus_jobs
         WHERE persona_id = ? ORDER BY created_at, id`,
        personaId,
      )) {
        const id = String(row["id"]);
        const status = String(row["status"]);
        const transaction = this.get(
          `SELECT id, phase, captured_checkpoint, force_reverted_at
           FROM memory_transactions WHERE job_id = ?
           ORDER BY (force_reverted_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1`,
          id,
        );
        const capturedTransaction =
          transaction !== undefined &&
          String(transaction["phase"]) === "completed" &&
          transaction["captured_checkpoint"] !== null &&
          transaction["force_reverted_at"] === null;
        const completedNoop = status === "completed" && isEmptyHippocampusProposal(row["proposal_json"]);
        const completedAndDurable = status === "completed" && (completedNoop || capturedTransaction);
        if (completedAndDurable || (!interrupted.has(id) && status !== "completed")) continue;

        if (
          transaction !== undefined &&
          String(transaction["phase"]) === "completed" &&
          transaction["captured_checkpoint"] === null &&
          transaction["force_reverted_at"] === null
        ) {
          this.run(
            `UPDATE memory_transactions
             SET phase = 'reverted', force_reverted_at = ?
             WHERE id = ? AND phase = 'completed'
               AND captured_checkpoint IS NULL AND force_reverted_at IS NULL`,
            now,
            String(transaction["id"]),
          );
        }
        ids.push(id);
      }
      if (ids.length === 0) return [];
      for (const id of ids) {
        this.run(
          `UPDATE hippocampus_jobs
           SET status = 'queued', attempts = 0, proposal_json = NULL, error_json = NULL, updated_at = ?
           WHERE id = ? AND persona_id = ?`,
          now,
          id,
          personaId,
        );
      }
      return ids.map((id) => this.requireHippocampusJob(id));
    });
  }

  acquireLease(
    personaId: string,
    ownerId: string,
    ownerPid: number,
    now: number,
  ): { acquired: boolean; fence: number } {
    return this.transaction(() => {
      const row = this.get("SELECT * FROM leases WHERE persona_id = ?", personaId);
      if (row && String(row["owner_id"]) !== ownerId && processAlive(asNumber(row["owner_pid"]))) {
        return { acquired: false, fence: asNumber(row["fence"]) };
      }
      const fence = row ? asNumber(row["fence"]) + 1 : 1;
      this.run(
        `INSERT INTO leases (persona_id, owner_id, owner_pid, fence, acquired_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(persona_id) DO UPDATE SET owner_id=excluded.owner_id, owner_pid=excluded.owner_pid,
         fence=excluded.fence, acquired_at=excluded.acquired_at`,
        personaId,
        ownerId,
        ownerPid,
        fence,
        now,
      );
      return { acquired: true, fence };
    });
  }

  assertLease(personaId: string, ownerId: string, fence: number): void {
    const row = this.get("SELECT owner_id, fence FROM leases WHERE persona_id = ?", personaId);
    if (!row || String(row["owner_id"]) !== ownerId || asNumber(row["fence"]) !== fence) {
      throw new Error("The Persona runtime writer lease is stale.");
    }
  }

  releaseLease(personaId: string, ownerId: string, fence: number): void {
    this.run(
      "DELETE FROM leases WHERE persona_id = ? AND owner_id = ? AND fence = ?",
      personaId,
      ownerId,
      fence,
    );
  }

  staleActiveRuns(incarnation: string): RunFact[] {
    return this.all(
      `SELECT * FROM runs WHERE incarnation != ? AND phase IN ('running','pausing','paused','stopping','forcing','faulted')`,
      incarnation,
    ).map(runFromRow);
  }

  activeRunsForIncarnation(incarnation: string): RunFact[] {
    return this.all(
      `SELECT * FROM runs WHERE incarnation = ?
       AND phase IN ('running','pausing','paused','stopping','forcing','faulted')`,
      incarnation,
    ).map(runFromRow);
  }

  recoverableActiveRuns(incarnation: string): RunFact[] {
    return this.staleActiveRuns(incarnation).filter((run) => {
      const lease = this.get("SELECT owner_pid FROM leases WHERE persona_id = ?", run.personaId);
      return !lease || !processAlive(asNumber(lease["owner_pid"]));
    });
  }

  private run(sql: string, ...parameters: Array<string | number | null>): ReturnType<StatementSync["run"]> {
    return this.#database.prepare(sql).run(...parameters);
  }

  private get(sql: string, ...parameters: Array<string | number | null>): Row | undefined {
    return this.#database.prepare(sql).get(...parameters) as Row | undefined;
  }

  private all(sql: string, ...parameters: Array<string | number | null>): Row[] {
    return this.#database.prepare(sql).all(...parameters) as Row[];
  }

  private enqueueDirect(input: {
    runId: string;
    kind: QueueKind;
    payload: JsonValue;
    stimulusId?: string;
    sourceEventId?: string;
    sourceToolCallId?: string;
    now: number;
  }): QueueItemFact {
    const id = randomUUID();
    const row = this.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM queue_items WHERE run_id = ?",
      input.runId,
    );
    const sequence = asNumber(row?.["next"] ?? 1);
    this.run(
      `INSERT INTO queue_items
       (id, run_id, sequence, kind, payload_json, stimulus_id, source_event_id, source_tool_call_id, status, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      id,
      input.runId,
      sequence,
      input.kind,
      encode(input.payload),
      input.stimulusId ?? null,
      input.sourceEventId ?? null,
      input.sourceToolCallId ?? null,
      input.now,
    );
    return this.requireQueueItem(id);
  }
}

function personaFromRow(row: Row): PersonaFact {
  return {
    id: String(row["id"]),
    displayName: String(row["display_name"]),
    repositoryPath: String(row["repository_path"]),
    lifecycle: String(row["lifecycle"]) as PersonaLifecycle,
    uiLocale: String(row["ui_locale"]),
    promptLocale: String(row["prompt_locale"]),
    initialized: asNumber(row["initialized"]) === 1,
    currentCheckpoint: row["current_checkpoint"] === null ? null : String(row["current_checkpoint"]),
    selectedCheckpoint: row["selected_checkpoint"] === null ? null : String(row["selected_checkpoint"]),
    revision: asNumber(row["revision"]),
    createdAt: asNumber(row["created_at"]),
  };
}

function registeredCheckpointFromRow(row: Row): RegisteredCheckpointFact {
  return {
    commit: String(row["commit_hash"]),
    personaId: String(row["persona_id"]),
    summary: String(row["summary"]),
    root: asNumber(row["is_root"]) === 1,
    createdAt: asNumber(row["created_at"]),
  };
}

function runFromRow(row: Row): RunFact {
  return {
    id: String(row["id"]),
    personaId: String(row["persona_id"]),
    incarnation: String(row["incarnation"]),
    phase: String(row["phase"]) as RunPhase,
    model: { provider: String(row["model_provider"]), model: String(row["model_id"]) },
    sessionId: String(row["session_id"]),
    startingCheckpoint: String(row["starting_checkpoint"]),
    currentQueueItemId: row["current_queue_item_id"] === null ? null : String(row["current_queue_item_id"]),
    waitingCode: row["waiting_code"] === null ? null : String(row["waiting_code"]),
    fault: nullableDecode(row["fault_json"]),
    stopCutoffSequence: asNullableNumber(row["stop_cutoff_sequence"]),
    startedAt: asNumber(row["started_at"]),
    endedAt: asNullableNumber(row["ended_at"]),
  };
}

function turnFromRow(row: Row): TurnFact {
  return {
    id: String(row["id"]),
    eventId: row["event_id"] === null ? null : String(row["event_id"]),
    sourceEventId: String(row["source_event_id"]),
    scope: String(row["scope"]) as TurnFact["scope"],
    sessionId: String(row["session_id"]),
    sequence: asNumber(row["sequence"]),
    role: String(row["role"]),
    startingCheckpoint: String(row["starting_checkpoint"]),
    promptLocale: String(row["prompt_locale"]),
    status: String(row["status"]) as TurnFact["status"],
    createdAt: asNumber(row["created_at"]),
    completedAt: asNullableNumber(row["completed_at"]),
  };
}

function queueFromRow(row: Row): QueueItemFact {
  return {
    id: String(row["id"]),
    runId: String(row["run_id"]),
    sequence: asNumber(row["sequence"]),
    kind: String(row["kind"]) as QueueItemFact["kind"],
    payload: decode(row["payload_json"]),
    stimulusId: row["stimulus_id"] === null ? null : String(row["stimulus_id"]),
    sourceEventId: row["source_event_id"] === null ? null : String(row["source_event_id"]),
    sourceToolCallId: row["source_tool_call_id"] === null ? null : String(row["source_tool_call_id"]),
    status: String(row["status"]) as QueueItemFact["status"],
    acceptedAt: asNumber(row["accepted_at"]),
    startedAt: asNullableNumber(row["started_at"]),
    finishedAt: asNullableNumber(row["finished_at"]),
  };
}

function eventFromRow(row: Row): EventFact {
  return {
    id: String(row["id"]),
    personaId: String(row["persona_id"]),
    runId: String(row["run_id"]),
    sessionId: String(row["session_id"]),
    queueItemId: String(row["queue_item_id"]),
    sequence: asNumber(row["sequence"]),
    status: String(row["status"]) as EventFact["status"],
    sourceKind: String(row["source_kind"]) as QueueKind,
    frozen: nullableDecode(row["frozen_json"]),
    summary: row["summary"] === null ? null : String(row["summary"]),
    memoryDecision:
      row["memory_decision"] === null
        ? null
        : (String(row["memory_decision"]) as EventFact["memoryDecision"]),
    checkpoint: row["checkpoint"] === null ? null : String(row["checkpoint"]),
    createdAt: asNumber(row["created_at"]),
    frozenAt: asNullableNumber(row["frozen_at"]),
    closedAt: asNullableNumber(row["closed_at"]),
    checkpointedAt: asNullableNumber(row["checkpointed_at"]),
  };
}

function sessionEntryFromRow(row: Row): SessionEntryFact {
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    eventId: row["event_id"] === null ? null : String(row["event_id"]),
    sequence: asNumber(row["sequence"]),
    kind: String(row["kind"]) as SessionEntryFact["kind"],
    payload: decode(row["payload_json"]),
    createdAt: asNumber(row["created_at"]),
  };
}

function toolCallFromRow(row: Row): ToolCallFact {
  return {
    id: String(row["id"]),
    eventId: String(row["event_id"]),
    turnId: String(row["turn_id"]),
    sequence: asNumber(row["sequence"]),
    providerCallId: String(row["provider_call_id"]),
    name: String(row["name"]),
    arguments: decode(row["arguments_json"]) as Record<string, JsonValue>,
    effect: String(row["effect"]) as ToolCallFact["effect"],
    status: String(row["status"]) as ToolCallFact["status"],
    authorizationRevision:
      row["authorization_revision"] === null ? null : String(row["authorization_revision"]),
    dispatchResult: nullableDecode(row["dispatch_result_json"]),
    result: nullableDecode(row["result_json"]),
    proposedAt: asNumber(row["proposed_at"]),
    intentAt: asNullableNumber(row["intent_at"]),
    dispatchAt: asNullableNumber(row["dispatch_at"]),
    outcomeAt: asNullableNumber(row["outcome_at"]),
  };
}

function authorizationDecisionFromRow(row: Row): AuthorizationDecisionFact {
  return {
    id: String(row["id"]),
    toolCallId: String(row["tool_call_id"]),
    sequence: asNumber(row["sequence"]),
    stage: String(row["stage"]) as AuthorizationDecisionFact["stage"],
    allow: asNumber(row["allowed"]) === 1,
    revision: String(row["revision"]),
    reason: row["reason"] === null ? null : String(row["reason"]),
    checkedAt: asNumber(row["checked_at"]),
  };
}

function observationFromRow(row: Row): ObservationFact {
  return {
    sequence: asNumber(row["sequence"]),
    personaId: String(row["persona_id"]),
    runId: row["run_id"] === null ? null : String(row["run_id"]),
    eventId: row["event_id"] === null ? null : String(row["event_id"]),
    kind: String(row["kind"]),
    payload: decode(row["payload_json"]),
    createdAt: asNumber(row["created_at"]),
  };
}

function hippocampusFromRow(row: Row): HippocampusJobFact {
  return {
    id: String(row["id"]),
    personaId: String(row["persona_id"]),
    eventId: String(row["event_id"]),
    sourceCheckpoint: String(row["source_checkpoint"]),
    model: { provider: String(row["model_provider"]), model: String(row["model_id"]) },
    promptLocale: String(row["prompt_locale"]),
    status: String(row["status"]) as HippocampusJobFact["status"],
    attempts: asNumber(row["attempts"]),
    proposal: nullableDecode(row["proposal_json"]),
    error: nullableDecode(row["error_json"]),
    createdAt: asNumber(row["created_at"]),
    updatedAt: asNumber(row["updated_at"]),
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
