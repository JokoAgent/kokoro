import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MemoryProposal,
  MemoryProposalError,
  type MemoryTransactionFaultPoint,
  MemoryTransactionManager,
  MemoryTransactionRecoveryRequiredError,
  manifest,
  parseMemoryProposal,
} from "../src/memory/index.js";
import { PersonaRepository } from "../src/repository/index.js";
import { RuntimeFactStore } from "../src/store/index.js";

const sandboxes: string[] = [];
const stores = new Set<RuntimeFactStore>();

interface Fixture {
  sandboxRoot: string;
  stateRoot: string;
  repository: PersonaRepository;
  store: RuntimeFactStore;
  personaId: string;
  jobId: string;
}

async function fixture(): Promise<Fixture> {
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "kokoro-memory-transaction-test-"));
  sandboxes.push(sandboxRoot);
  const repository = await PersonaRepository.createDraft(path.join(sandboxRoot, "persona"), {
    persona: "# Persona\n",
    memory: "original\n",
  });
  const memoryRoot = path.join(repository.root, "workspace", "memory");
  await writeFile(path.join(memoryRoot, "move-me.md"), "move me\n", "utf8");
  await writeFile(path.join(memoryRoot, "delete-me.md"), "delete me\n", "utf8");

  const stateRoot = path.join(sandboxRoot, "state");
  const store = new RuntimeFactStore(stateRoot);
  stores.add(store);
  const persona = store.createPersona({
    repositoryPath: repository.root,
    uiLocale: "en",
    promptLocale: "en",
    now: 1,
  });
  const run = store.createRun({
    personaId: persona.id,
    incarnation: "incarnation",
    model: { provider: "test", model: "model" },
    startingCheckpoint: "a".repeat(40),
    now: 2,
  });
  const item = store.enqueue({ runId: run.id, kind: "start", payload: {}, now: 3 });
  const event = store.createEvent({ personaId: persona.id, run, item, now: 4 });
  store.freezeEvent(event.id, { eventId: event.id }, 5);
  store.closeEvent(event.id, "fixture", "maintain", 6);
  store.checkpointEvent(event.id, run.startingCheckpoint, 7);
  const job = store.createHippocampusJob({
    personaId: persona.id,
    eventId: event.id,
    sourceCheckpoint: run.startingCheckpoint,
    model: run.model,
    promptLocale: "en",
    now: 8,
  });
  return { sandboxRoot, stateRoot, repository, store, personaId: persona.id, jobId: job.id };
}

function closeStore(store: RuntimeFactStore): void {
  store.close();
  stores.delete(store);
}

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // A simulated crash may already have closed the handle.
    }
  }
  stores.clear();
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hippocampus Memory proposal boundary", () => {
  it("accepts only the exact operation schema", () => {
    expect(
      parseMemoryProposal(
        JSON.stringify({
          operations: [
            { kind: "replace", path: "workspace/memory/initial.md", content: "replacement" },
            { kind: "create", path: "workspace/memory/2026-08-30/new.md", content: "new" },
            { kind: "move", from: "workspace/memory/old.md", path: "workspace/memory/archive.md" },
            { kind: "delete", path: "workspace/memory/remove.md" },
          ],
        }),
      ),
    ).toEqual({
      operations: [
        { kind: "replace", path: "workspace/memory/initial.md", content: "replacement" },
        { kind: "create", path: "workspace/memory/2026-08-30/new.md", content: "new" },
        { kind: "move", from: "workspace/memory/old.md", path: "workspace/memory/archive.md" },
        { kind: "delete", path: "workspace/memory/remove.md" },
      ],
    });

    for (const invalid of [
      { operations: [], explanation: "extra root field" },
      { operations: [{ kind: "delete", path: "workspace/memory/remove.md", extra: true }] },
      { operations: [{ kind: "create", path: "workspace/memory/2026-02-30/impossible.md", content: "x" }] },
      { operations: [{ kind: "create", path: "workspace/memory/new.md", content: "x" }] },
      { operations: [{ kind: "replace", path: "workspace\\memory\\initial.md", content: "x" }] },
      { operations: [{ kind: "delete", path: "workspace/memory/../persona/persona.md" }] },
      {
        operations: [
          { kind: "create", path: "workspace/memory/2026-08-30/note.md:alternate.md", content: "x" },
        ],
      },
      { operations: [{ kind: "create", path: "workspace/memory/2026-08-30/nul\u0000.md", content: "x" }] },
      { operations: [{ kind: "create", path: "workspace/memory/2026-08-30/COM¹.md", content: "x" }] },
      { operations: [{ kind: "create", path: "workspace/memory/2026-08-30/LPT³.md", content: "x" }] },
    ]) {
      expect(() => parseMemoryProposal(JSON.stringify(invalid))).toThrow(MemoryProposalError);
    }
  });

  it("rejects credential-like content before any filesystem transaction", () => {
    expect(() =>
      parseMemoryProposal(
        JSON.stringify({
          operations: [
            {
              kind: "create",
              path: "workspace/memory/2026-08-30/credential.md",
              content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "credentials" }));
  });

  it("rejects a Memory manifest with Unicode case-folding collisions", async ({ skip }) => {
    const root = await mkdtemp(path.join(tmpdir(), "kokoro-memory-portable-paths-"));
    sandboxes.push(root);
    await writeFile(path.join(root, "Σ.md"), "sigma\n", "utf8");
    await writeFile(path.join(root, "ς.md"), "final sigma\n", "utf8");
    const names = new Set(await readdir(root));
    if (!names.has("Σ.md") || !names.has("ς.md")) {
      skip("the test filesystem cannot represent distinct Unicode case-folding collisions");
    }

    await expect(manifest(root)).rejects.toMatchObject({ code: "invalid_path" });
  });
});

describe("MemoryTransactionManager", () => {
  it("applies create, replace, move, and delete as one whole-tree replacement", async () => {
    const { repository, store, jobId } = await fixture();
    const manager = new MemoryTransactionManager(store, { now: () => 100 });
    const proposal = parseMemoryProposal(
      JSON.stringify({
        operations: [
          { kind: "replace", path: "workspace/memory/initial.md", content: "remembered\n" },
          { kind: "create", path: "workspace/memory/2026-08-30/new.md", content: "new memory\n" },
          { kind: "move", from: "workspace/memory/move-me.md", path: "workspace/memory/moved.md" },
          { kind: "delete", path: "workspace/memory/delete-me.md" },
        ],
      }),
    );

    const review = await manager.review(repository);
    const installed = await manager.apply(jobId, repository, proposal, review.manifest);
    expect(installed.map((entry) => entry.path)).toEqual(["2026-08-30/new.md", "initial.md", "moved.md"]);
    expect(await readFile(path.join(repository.root, "workspace", "memory", "initial.md"), "utf8")).toBe(
      "remembered\n",
    );
    expect(await readFile(path.join(repository.root, "workspace", "memory", "moved.md"), "utf8")).toBe(
      "move me\n",
    );
    await expect(
      access(path.join(repository.root, "workspace", "memory", "move-me.md")),
    ).rejects.toBeDefined();
    await expect(
      access(path.join(repository.root, "workspace", "memory", "delete-me.md")),
    ).rejects.toBeDefined();
    expect(await manifest(path.join(repository.root, "workspace", "memory"))).toEqual(installed);
    expect(store.memoryTransactions()).toEqual([]);
  });

  it("preserves a concurrent owner edit and installs none of the proposal", async () => {
    const { repository, store, jobId } = await fixture();
    const initial = path.join(repository.root, "workspace", "memory", "initial.md");
    const manager = new MemoryTransactionManager(store, {
      now: () => 100,
      fault: async (point) => {
        if (point === "after_record") await writeFile(initial, "owner edit wins\n", "utf8");
      },
    });
    const proposal: MemoryProposal = {
      operations: [
        { kind: "replace", path: "workspace/memory/initial.md", content: "model replacement\n" },
        { kind: "create", path: "workspace/memory/2026-08-30/new.md", content: "must not appear\n" },
      ],
    };

    const review = await manager.review(repository);
    await expect(manager.apply(jobId, repository, proposal, review.manifest)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(initial, "utf8")).toBe("owner edit wins\n");
    await expect(
      access(path.join(repository.root, "workspace", "memory", "2026-08-30", "new.md")),
    ).rejects.toBeDefined();
    expect(await readFile(path.join(repository.root, "workspace", "memory", "move-me.md"), "utf8")).toBe(
      "move me\n",
    );
    expect(store.memoryTransactions()).toEqual([]);

    const transactionRoot = path.join(repository.root, ".git", "kokoro-memory-transactions");
    expect(await readdir(transactionRoot)).toEqual([]);

    const retry = new MemoryTransactionManager(store, { now: () => 200 });
    const retryReview = await retry.review(repository);
    await retry.apply(
      jobId,
      repository,
      {
        operations: [{ kind: "replace", path: "workspace/memory/initial.md", content: "re-evaluated\n" }],
      },
      retryReview.manifest,
    );
    expect(await readFile(initial, "utf8")).toBe("re-evaluated\n");
  });

  it("rejects a proposal when Memory changed after the model review but before staging", async () => {
    const { repository, store, jobId } = await fixture();
    const initial = path.join(repository.root, "workspace", "memory", "initial.md");
    const manager = new MemoryTransactionManager(store, { now: () => 100 });
    const review = await manager.review(repository);
    await writeFile(initial, "owner edit after review\n", "utf8");

    await expect(
      manager.apply(
        jobId,
        repository,
        {
          operations: [
            { kind: "replace", path: "workspace/memory/initial.md", content: "stale model edit\n" },
          ],
        },
        review.manifest,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(initial, "utf8")).toBe("owner edit after review\n");
    expect(store.memoryTransactions()).toEqual([]);
  });

  it("preserves an owner write that lands on the renamed original during the atomic swap", async () => {
    const { repository, store, jobId } = await fixture();
    const transactionRoot = path.join(repository.root, ".git", "kokoro-memory-transactions");
    const manager = new MemoryTransactionManager(store, {
      now: () => 100,
      fault: async (point) => {
        if (point !== "after_original_moved") return;
        const [transactionId] = await readdir(transactionRoot);
        if (!transactionId) throw new Error("transaction directory was not visible");
        await writeFile(
          path.join(transactionRoot, transactionId, "backup", "initial.md"),
          "late owner edit\n",
          "utf8",
        );
      },
    });

    const review = await manager.review(repository);
    await expect(
      manager.apply(
        jobId,
        repository,
        {
          operations: [
            { kind: "replace", path: "workspace/memory/initial.md", content: "model replacement\n" },
          ],
        },
        review.manifest,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(repository.root, "workspace", "memory", "initial.md"), "utf8")).toBe(
      "late owner edit\n",
    );
    expect(await readdir(transactionRoot)).toEqual([]);
  });

  it.each<MemoryTransactionFaultPoint>(["after_original_moved", "after_replacement_moved"])(
    "recovers deterministically from a crash at %s",
    async (faultPoint) => {
      const { repository, stateRoot, store, jobId, personaId } = await fixture();
      const memoryRoot = path.join(repository.root, "workspace", "memory");
      const manager = new MemoryTransactionManager(store, {
        now: () => 100,
        fault: (point) => {
          if (point === faultPoint) throw new Error(`simulated crash at ${point}`);
        },
      });
      const proposal: MemoryProposal = {
        operations: [{ kind: "replace", path: "workspace/memory/initial.md", content: "recovered\n" }],
      };

      const review = await manager.review(repository);
      await expect(manager.apply(jobId, repository, proposal, review.manifest)).rejects.toBeInstanceOf(
        MemoryTransactionRecoveryRequiredError,
      );
      expect(store.memoryTransactions()).toHaveLength(1);
      if (faultPoint === "after_original_moved") {
        await expect(access(memoryRoot)).rejects.toBeDefined();
      } else {
        expect(await readFile(path.join(memoryRoot, "initial.md"), "utf8")).toBe("recovered\n");
      }

      closeStore(store);
      const recoveredStore = new RuntimeFactStore(stateRoot);
      stores.add(recoveredStore);
      const recovery = new MemoryTransactionManager(recoveredStore, { now: () => 200 });
      await recovery.recoverAll(async (requestedPersonaId) => {
        expect(requestedPersonaId).toBe(personaId);
        return PersonaRepository.open(repository.root);
      });

      expect(await readFile(path.join(memoryRoot, "initial.md"), "utf8")).toBe("recovered\n");
      expect(await readFile(path.join(memoryRoot, "move-me.md"), "utf8")).toBe("move me\n");
      expect(recoveredStore.memoryTransactions()).toEqual([]);
      expect(recoveredStore.requireHippocampusJob(jobId)).toMatchObject({ status: "completed", error: null });
      const transactionRoot = path.join(repository.root, ".git", "kokoro-memory-transactions");
      expect(await readdir(transactionRoot)).toEqual([]);
    },
  );
});
