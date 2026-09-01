import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/model.js";
import { RuntimeFactStore } from "../src/store/index.js";

const stateRoots: string[] = [];
const stores = new Set<RuntimeFactStore>();

async function storeFixture(): Promise<{
  store: RuntimeFactStore;
  personaId: string;
  runId: string;
}> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "kokoro-store-test-"));
  stateRoots.push(stateRoot);
  const store = new RuntimeFactStore(stateRoot);
  stores.add(store);
  const persona = store.createPersona({
    repositoryPath: path.join(stateRoot, "persona"),
    uiLocale: "en",
    promptLocale: "en",
    now: 1,
  });
  const run = store.createRun({
    personaId: persona.id,
    incarnation: "incarnation-a",
    model: { provider: "test", model: "model" },
    startingCheckpoint: "a".repeat(40),
    now: 2,
  });
  return { store, personaId: persona.id, runId: run.id };
}

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // A crash-recovery test may have explicitly closed this handle.
    }
  }
  stores.clear();
  await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimeFactStore queue facts", () => {
  it("accepts a stimulus and its queue item atomically", async () => {
    const { store, personaId, runId } = await storeFixture();
    store.enqueue({ runId, kind: "start", payload: { reason: "owner_start" }, now: 3 });

    expect(() =>
      store.acceptStimulus({
        personaId: "missing-persona",
        runId,
        kind: "message",
        payload: { text: "must roll back" },
        now: 4,
      }),
    ).toThrow();
    expect(store.listQueue(runId)).toHaveLength(1);

    const otherPersona = store.createPersona({
      repositoryPath: path.join(path.dirname(store.path), "other-persona"),
      uiLocale: "en",
      promptLocale: "en",
      now: 4,
    });
    expect(() =>
      store.acceptStimulus({
        personaId: otherPersona.id,
        runId,
        kind: "message",
        payload: { text: "must not cross Persona boundaries" },
        now: 4,
      }),
    ).toThrow();
    expect(store.listQueue(runId)).toHaveLength(1);

    const accepted = store.acceptStimulus({
      personaId,
      runId,
      kind: "message",
      payload: { text: "hello" },
      now: 5,
    });
    expect(accepted.item).toMatchObject({
      sequence: 2,
      kind: "stimulus",
      status: "queued",
      stimulusId: accepted.stimulusId,
      payload: { kind: "message", payload: { text: "hello" } },
    });
    expect(store.requireQueueItem(accepted.item.id)).toEqual(accepted.item);
  });

  it("claims queued work in durable FIFO order", async () => {
    const { store, personaId, runId } = await storeFixture();
    const start = store.enqueue({ runId, kind: "start", payload: {}, now: 10 });
    const first = store.acceptStimulus({
      personaId,
      runId,
      kind: "message",
      payload: { n: 1 },
      now: 10,
    }).item;
    const second = store.acceptStimulus({
      personaId,
      runId,
      kind: "message",
      payload: { n: 2 },
      now: 10,
    }).item;

    expect(store.listQueue(runId).map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(store.nextQueued(runId)?.id).toBe(start.id);
    store.markQueueStarted(start.id, 11);
    expect(store.nextQueued(runId)?.id).toBe(first.id);
    store.markQueueCompleted(start.id, 12);
    store.markQueueStarted(first.id, 13);
    expect(store.nextQueued(runId)?.id).toBe(second.id);
  });

  it("turns only dispatching tool effects into unknown outcomes after a crash", async () => {
    const { store, personaId, runId } = await storeFixture();
    const run = store.requireRun(runId);
    const item = store.enqueue({ runId, kind: "start", payload: {}, now: 3 });
    const event = store.createEvent({ personaId, run, item, now: 4 });
    const turn = store.createTurn({
      eventId: event.id,
      sourceEventId: event.id,
      scope: "event",
      sessionId: run.sessionId,
      role: "persona",
      startingCheckpoint: run.startingCheckpoint,
      promptLocale: "en",
      now: 5,
    });
    const dispatching = store.proposeToolCall({
      eventId: event.id,
      turnId: turn,
      providerCallId: "call-dispatching",
      name: "send_message",
      arguments: { text: "hello" },
      effect: "external",
      now: 6,
    });
    store.setToolCallState(dispatching.id, "intent_recorded", { authorizationRevision: "policy-1", now: 7 });
    store.setToolCallState(dispatching.id, "dispatching", { now: 8 });
    const merelyProposed = store.proposeToolCall({
      eventId: event.id,
      turnId: turn,
      providerCallId: "call-proposed",
      name: "read_file",
      arguments: { path: "workspace/persona/persona.md" },
      effect: "none",
      now: 9,
    });

    expect(store.markDispatchingUnknown(10, runId).map((call) => call.id)).toEqual([dispatching.id]);
    expect(store.requireToolCall(dispatching.id)).toMatchObject({ status: "unknown", outcomeAt: 10 });
    expect(store.requireToolCall(merelyProposed.id)).toMatchObject({ status: "proposed", outcomeAt: null });
    expect(store.markDispatchingUnknown(11, runId)).toEqual([]);
  });
});

describe("RuntimeFactStore publication and writer fencing", () => {
  it("migrates an existing Turn scope constraint without losing causal facts", async () => {
    const { store, personaId, runId } = await storeFixture();
    const run = store.requireRun(runId);
    const item = store.enqueue({ runId, kind: "start", payload: {}, now: 3 });
    const event = store.createEvent({ personaId, run, item, now: 4 });
    const initialTurn = store.createTurn({
      eventId: event.id,
      sourceEventId: event.id,
      scope: "event",
      sessionId: run.sessionId,
      role: "persona",
      startingCheckpoint: run.startingCheckpoint,
      promptLocale: "en",
      now: 5,
    });
    const databasePath = store.path;
    store.close();
    stores.delete(store);

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        BEGIN IMMEDIATE;
        ALTER TABLE turns RENAME TO turns_with_compaction_scope;
        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          event_id TEXT REFERENCES events(id),
          source_event_id TEXT NOT NULL REFERENCES events(id),
          scope TEXT NOT NULL CHECK (scope IN ('event','closeout','hippocampus')),
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
        FROM turns_with_compaction_scope;
        DROP TABLE turns_with_compaction_scope;
        COMMIT;
        PRAGMA legacy_alter_table = OFF;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new RuntimeFactStore(path.dirname(databasePath));
    stores.add(migrated);
    const turnId = migrated.createTurn({
      eventId: null,
      sourceEventId: event.id,
      scope: "compaction",
      sessionId: run.sessionId,
      role: "compaction",
      startingCheckpoint: run.startingCheckpoint,
      promptLocale: "en",
      now: 6,
    });

    expect(migrated.turnsForSourceEvent(event.id)).toEqual([
      expect.objectContaining({ id: initialTurn, eventId: event.id, scope: "event" }),
      expect.objectContaining({ id: turnId, eventId: null, scope: "compaction" }),
    ]);
  });

  it("migrates the legacy global Checkpoint key before registering a Clone", async () => {
    const { store, personaId } = await storeFixture();
    const sharedCommit = "d".repeat(40);
    store.registerExistingCheckpoint({
      personaId,
      commit: sharedCommit,
      summary: "Source root",
      root: true,
      now: 5,
    });
    const databasePath = store.path;
    store.close();
    stores.delete(store);

    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        BEGIN IMMEDIATE;
        ALTER TABLE checkpoints RENAME TO checkpoints_with_persona_key;
        CREATE TABLE checkpoints (
          commit_hash TEXT PRIMARY KEY,
          persona_id TEXT NOT NULL REFERENCES personas(id),
          event_id TEXT UNIQUE,
          summary TEXT NOT NULL,
          is_root INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO checkpoints
          (commit_hash, persona_id, event_id, summary, is_root, created_at)
        SELECT commit_hash, persona_id, event_id, summary, is_root, created_at
        FROM checkpoints_with_persona_key;
        DROP TABLE checkpoints_with_persona_key;
        COMMIT;
        PRAGMA legacy_alter_table = OFF;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new RuntimeFactStore(path.dirname(databasePath));
    stores.add(migrated);
    const clone = migrated.createPersona({
      id: "legacy-checkpoint-clone",
      displayName: "Legacy Checkpoint Clone",
      repositoryPath: path.join(path.dirname(databasePath), "legacy-checkpoint-clone"),
      uiLocale: "en",
      promptLocale: "en",
      now: 6,
    });
    migrated.registerExistingCheckpoint({
      personaId: clone.id,
      commit: sharedCommit,
      summary: "Clone root",
      root: true,
      now: 7,
    });

    expect(migrated.registeredCheckpoint(personaId, sharedCommit)).toMatchObject({
      personaId,
      summary: "Source root",
    });
    expect(migrated.registeredCheckpoint(clone.id, sharedCommit)).toMatchObject({
      personaId: clone.id,
      summary: "Clone root",
    });
  });

  it("lets only one independent connection reserve the same authority revision", async () => {
    const { store } = await storeFixture();
    const competingStore = new RuntimeFactStore(path.dirname(store.path));
    stores.add(competingStore);
    const expectedRevision = store.authorityState().revision;

    const reservations = [
      store.reserveAuthorityRevision(expectedRevision, 10),
      competingStore.reserveAuthorityRevision(expectedRevision, 11),
    ];

    expect(reservations.filter((reservation) => reservation.accepted)).toHaveLength(1);
    expect(reservations.filter((reservation) => !reservation.accepted)).toHaveLength(1);
    expect(reservations).toEqual([
      { accepted: true, actualRevision: expectedRevision + 1 },
      { accepted: false, actualRevision: expectedRevision + 1 },
    ]);
    expect(store.authorityState().revision).toBe(expectedRevision + 1);
    expect(competingStore.authorityState().revision).toBe(expectedRevision + 1);
  });

  it("assigns one revision to one complete authority projection fingerprint", async () => {
    const { store } = await storeFixture();
    const before = store.authorityState().revision;
    const first = store.transaction(() => store.stampAuthoritySnapshot("projection-a", 10));
    const repeated = store.transaction(() => store.stampAuthoritySnapshot("projection-a", 11));
    const changed = store.transaction(() => store.stampAuthoritySnapshot("projection-b", 12));

    expect(first).toEqual({ revision: before + 1, updatedAt: 10 });
    expect(repeated).toEqual(first);
    expect(changed).toEqual({ revision: before + 2, updatedAt: 12 });
  });

  it("requeues only interrupted or uncaptured completed H work after Force", async () => {
    const { store, personaId, runId } = await storeFixture();
    const run = store.requireRun(runId);
    const restoredCheckpoint = "c".repeat(40);
    const earlierCheckpoint = "b".repeat(40);
    let nextTime = 3;
    const createJob = (
      checkpoint: string,
      status: "queued" | "retry" | "running" | "applying" | "completed" | "failed" | "conflict",
      proposal: JsonValue = { operations: [{ kind: "create" }] },
    ) => {
      const item = store.enqueue({ runId, kind: "stimulus", payload: { nextTime }, now: nextTime++ });
      const event = store.createEvent({ personaId, run, item, now: nextTime++ });
      store.freezeEvent(event.id, { eventId: event.id }, nextTime++);
      store.closeEvent(event.id, `summary-${status}`, "maintain", nextTime++);
      store.checkpointEvent(event.id, checkpoint, nextTime++);
      const job = store.createHippocampusJob({
        personaId,
        eventId: event.id,
        sourceCheckpoint: checkpoint,
        model: run.model,
        promptLocale: "en",
        now: nextTime++,
      });
      return store.updateHippocampusJob(
        job.id,
        {
          status,
          attempts: 4,
          proposal,
          error: { code: `error-${status}` },
        },
        nextTime++,
      );
    };

    const capturedCompleted = createJob(earlierCheckpoint, "completed");
    store.saveMemoryTransaction({
      id: "captured-transaction",
      jobId: capturedCompleted.id,
      phase: "completed",
      directory: path.join(path.dirname(store.path), "captured-transaction"),
      beforeManifest: {},
      afterManifest: {},
      now: nextTime++,
    });
    const uncapturedApplying = createJob(earlierCheckpoint, "applying");
    const checkpointIntent = store.saveCheckpointIntent({
      personaId,
      kind: "event",
      commit: restoredCheckpoint,
      plan: { commit: restoredCheckpoint },
      now: nextTime++,
    });
    // The immutable plan has already been captured and its intent persisted.
    // H completing before recovery finishes that intent must not be retroactively
    // attributed to a tree that was prepared without it.
    const repeatedMillisecond = 50;
    store.saveMemoryTransaction({
      id: "uncaptured-transaction",
      jobId: uncapturedApplying.id,
      phase: "completed",
      directory: path.join(path.dirname(store.path), "uncaptured-transaction"),
      beforeManifest: {},
      afterManifest: {},
      now: repeatedMillisecond,
    });
    const uncapturedCompleted = store.updateHippocampusJob(
      uncapturedApplying.id,
      { status: "completed" },
      nextTime++,
    );
    store.completeCheckpointIntent({
      intentId: checkpointIntent,
      personaId,
      commit: restoredCheckpoint,
      summary: "Checkpoint capturing earlier Memory",
      root: false,
      now: nextTime++,
    });

    const interruptedRunning = createJob(restoredCheckpoint, "running");
    const interruptedApplying = createJob(earlierCheckpoint, "applying");
    const completedNoop = createJob(restoredCheckpoint, "completed", { operations: [] });
    const targetFailed = createJob(restoredCheckpoint, "failed");
    const targetConflict = createJob(restoredCheckpoint, "conflict");

    const requeued = store.requeueHippocampusAfterForce(personaId, 100, [
      interruptedRunning.id,
      interruptedApplying.id,
    ]);

    expect(requeued.map((job) => job.id)).toEqual([
      uncapturedCompleted.id,
      interruptedRunning.id,
      interruptedApplying.id,
    ]);
    for (const job of requeued) {
      expect(job).toMatchObject({
        status: "queued",
        attempts: 0,
        proposal: null,
        error: null,
        updatedAt: 100,
      });
    }
    expect(store.requireHippocampusJob(targetFailed.id)).toEqual(targetFailed);
    expect(store.requireHippocampusJob(targetConflict.id)).toEqual(targetConflict);
    expect(store.requireHippocampusJob(capturedCompleted.id)).toEqual(capturedCompleted);
    expect(store.requireHippocampusJob(completedNoop.id)).toEqual(completedNoop);
    expect(store.memoryTransactionForJob(capturedCompleted.id)).toEqual({
      id: "captured-transaction",
      phase: "completed",
      capturedCheckpoint: restoredCheckpoint,
      forceRevertedAt: null,
    });
    expect(store.memoryTransactionForJob(uncapturedCompleted.id)).toEqual({
      id: "uncaptured-transaction",
      phase: "reverted",
      capturedCheckpoint: null,
      forceRevertedAt: 100,
    });

    store.updateHippocampusJob(uncapturedCompleted.id, { status: "applying" }, 100);
    store.saveMemoryTransaction({
      id: "retry-transaction",
      jobId: uncapturedCompleted.id,
      phase: "completed",
      directory: path.join(path.dirname(store.path), "retry-transaction"),
      beforeManifest: {},
      afterManifest: {},
      // Deliberately equal to the reverted transaction: ordering must follow
      // durable validity, never wall-clock or random UUID tie-breaking.
      now: repeatedMillisecond,
    });
    store.updateHippocampusJob(uncapturedCompleted.id, { status: "completed" }, 100);
    const laterCheckpoint = "d".repeat(40);
    const laterIntent = store.saveCheckpointIntent({
      personaId,
      kind: "event",
      commit: laterCheckpoint,
      plan: { commit: laterCheckpoint },
      now: 100,
    });
    store.completeCheckpointIntent({
      intentId: laterIntent,
      personaId,
      commit: laterCheckpoint,
      summary: "Checkpoint capturing the retried Memory transaction",
      root: false,
      now: 100,
    });
    expect(store.requeueHippocampusAfterForce(personaId, 100)).toEqual([]);
    expect(store.memoryTransactionForJob(uncapturedCompleted.id)).toEqual({
      id: "retry-transaction",
      phase: "completed",
      capturedCheckpoint: laterCheckpoint,
      forceRevertedAt: null,
    });
  });

  it("does not skip later Hippocampus work past an earlier failed source Event", async () => {
    const { store, personaId, runId } = await storeFixture();
    const run = store.requireRun(runId);
    const firstItem = store.enqueue({ runId, kind: "start", payload: {}, now: 3 });
    const secondItem = store.enqueue({ runId, kind: "stimulus", payload: {}, now: 4 });
    const firstEvent = store.createEvent({ personaId, run, item: firstItem, now: 5 });
    const secondEvent = store.createEvent({ personaId, run, item: secondItem, now: 6 });
    store.freezeEvent(firstEvent.id, { eventId: firstEvent.id }, 7);
    store.closeEvent(firstEvent.id, "first", "maintain", 8);
    store.checkpointEvent(firstEvent.id, "b".repeat(40), 9);
    store.freezeEvent(secondEvent.id, { eventId: secondEvent.id }, 10);
    store.closeEvent(secondEvent.id, "second", "maintain", 11);
    store.checkpointEvent(secondEvent.id, "c".repeat(40), 12);
    const firstJob = store.createHippocampusJob({
      personaId,
      eventId: firstEvent.id,
      sourceCheckpoint: "b".repeat(40),
      model: run.model,
      promptLocale: "en",
      now: 13,
    });
    const secondJob = store.createHippocampusJob({
      personaId,
      eventId: secondEvent.id,
      sourceCheckpoint: "c".repeat(40),
      model: run.model,
      promptLocale: "en",
      now: 14,
    });

    expect(store.publications(personaId)).toEqual([]);
    expect(store.nextHippocampusJob(personaId)?.id).toBe(firstJob.id);
    store.updateHippocampusJob(firstJob.id, { status: "failed" }, 15);
    expect(store.nextHippocampusJob(personaId)).toBeUndefined();
    expect(store.hasRunnableHippocampusWork(personaId)).toBe(false);
    store.updateHippocampusJob(firstJob.id, { status: "queued" }, 16);
    expect(store.nextHippocampusJob(personaId)?.id).toBe(firstJob.id);
    store.updateHippocampusJob(firstJob.id, { status: "completed" }, 17);
    expect(store.nextHippocampusJob(personaId)?.id).toBe(secondJob.id);
  });

  it("publishes each Event once and replays strictly after the supplied cursor", async () => {
    const { store, personaId, runId } = await storeFixture();
    const run = store.requireRun(runId);
    const firstItem = store.enqueue({ runId, kind: "start", payload: {}, now: 3 });
    const secondItem = store.enqueue({ runId, kind: "stimulus", payload: { text: "next" }, now: 4 });
    const firstEvent = store.createEvent({ personaId, run, item: firstItem, now: 5 });
    const secondEvent = store.createEvent({ personaId, run, item: secondItem, now: 6 });

    for (const [index, event] of [firstEvent, secondEvent].entries()) {
      store.freezeEvent(event.id, { event: event.id }, 7 + index * 3);
      store.closeEvent(event.id, `summary-${index}`, "none", 8 + index * 3);
      store.checkpointEvent(event.id, String(index + 1).repeat(40), 9 + index * 3);
    }
    expect(store.pendingPublicationCount(personaId)).toBe(2);

    const firstCursor = store.publishEvent(personaId, firstEvent.id, { summary: "first" }, 15);
    expect(store.pendingPublicationCount(personaId)).toBe(1);
    expect(store.publishEvent(personaId, firstEvent.id, { summary: "ignored duplicate" }, 16)).toBe(
      firstCursor,
    );
    const secondCursor = store.publishEvent(personaId, secondEvent.id, { summary: "second" }, 17);
    expect(store.pendingPublicationCount(personaId)).toBe(0);

    expect(secondCursor).toBeGreaterThan(firstCursor);
    expect(store.publications(personaId)).toEqual([
      { sequence: firstCursor, eventId: firstEvent.id, payload: { summary: "first" }, createdAt: 15 },
      { sequence: secondCursor, eventId: secondEvent.id, payload: { summary: "second" }, createdAt: 17 },
    ]);
    expect(store.publications(personaId, firstCursor)).toEqual([
      { sequence: secondCursor, eventId: secondEvent.id, payload: { summary: "second" }, createdAt: 17 },
    ]);
    expect(store.publications(personaId, secondCursor)).toEqual([]);
  });

  it("blocks a second live writer and fences a stale owner after takeover", async () => {
    const { store, personaId } = await storeFixture();
    const competingStore = new RuntimeFactStore(path.dirname(store.path));
    stores.add(competingStore);
    const first = store.acquireLease(personaId, "owner-a", process.pid, 10);
    expect(first).toEqual({ acquired: true, fence: 1 });
    expect(competingStore.acquireLease(personaId, "owner-b", process.pid, 11)).toEqual({
      acquired: false,
      fence: 1,
    });
    expect(() => store.assertLease(personaId, "owner-a", first.fence)).not.toThrow();

    store.releaseLease(personaId, "owner-a", first.fence);
    const deadOwner = competingStore.acquireLease(personaId, "dead-owner", 2_147_483_647, 12);
    expect(deadOwner.acquired).toBe(true);
    const takeover = store.acquireLease(personaId, "owner-c", process.pid, 13);
    expect(takeover).toEqual({ acquired: true, fence: deadOwner.fence + 1 });
    expect(() => store.assertLease(personaId, "dead-owner", deadOwner.fence)).toThrow(/stale/u);
    expect(() => store.assertLease(personaId, "owner-c", takeover.fence)).not.toThrow();
  });
});
