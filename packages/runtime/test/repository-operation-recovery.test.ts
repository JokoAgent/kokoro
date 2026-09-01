import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  KokoroRuntime,
  MemoryTransactionManager,
  MemoryTransactionRecoveryRequiredError,
  PersonaRepository,
} from "../src/index.js";

const roots: string[] = [];
const runtimes = new Set<KokoroRuntime>();
const execFileAsync = promisify(execFile);

afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  runtimes.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable Repository operation reconciliation", () => {
  it("finishes a Restore whose Git mutation survived before its DB anchor", async () => {
    const fixture = await initializedFixture("restore-source");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const secondPath = path.join(fixture.personaPath, "workspace", "persona", "persona.md");
    await writeFile(secondPath, "# Persona\n\nSecond checkpoint.\n", "utf8");
    const second = await repository.prepareCheckpoint("Second checkpoint", "2026-08-30T01:00:00.000Z");
    await repository.advanceCheckpoint(second);
    fixture.runtime.store.registerExistingCheckpoint({
      personaId: fixture.personaId,
      commit: second.commit,
      summary: second.message,
      root: false,
      now: Date.now(),
    });

    fixture.runtime.store.saveRepositoryOperation({
      personaId: fixture.personaId,
      kind: "restore",
      payload: { checkpoint: fixture.rootCheckpoint, discardChanges: true },
      now: Date.now(),
    });
    await repository.restore(fixture.rootCheckpoint, true);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(fixture.personaId)).toMatchObject({
      currentCheckpoint: fixture.rootCheckpoint,
      selectedCheckpoint: fixture.rootCheckpoint,
      lifecycle: "ready",
    });
    expect(await (await PersonaRepository.open(fixture.personaPath)).head()).toBe(fixture.rootCheckpoint);
    expect(recovered.store.preparedRepositoryOperations()).toHaveLength(0);
  });

  it("tombstones only the registered Persona after its exact Repository was already deleted", async () => {
    const fixture = await initializedFixture("delete-source");
    fixture.runtime.store.saveRepositoryOperation({
      personaId: fixture.personaId,
      kind: "delete",
      payload: { repositoryPath: fixture.personaPath, discardChanges: true },
      now: Date.now(),
    });
    await PersonaRepository.deleteExact(fixture.personaPath, fixture.personaPath);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona(fixture.personaId)).toBeUndefined();
    await expect(access(fixture.personaPath)).rejects.toBeDefined();
    expect(recovered.store.preparedRepositoryOperations()).toHaveLength(0);
  });

  it("adopts an exact Checkpoint clone that survived before Persona identity creation", async () => {
    const fixture = await initializedFixture("clone-source");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const cloneId = "clone-recovered";
    const destination = path.join(fixture.personaDirectory, cloneId);
    fixture.runtime.store.saveRepositoryOperation({
      personaId: fixture.personaId,
      kind: "clone",
      payload: {
        checkpoint: fixture.rootCheckpoint,
        newPersonaId: cloneId,
        displayName: "Recovered Clone",
        destination,
        uiLocale: "en",
        promptLocale: "en",
      },
      now: Date.now(),
    });
    await repository.cloneAt(fixture.rootCheckpoint, destination);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(cloneId)).toMatchObject({
      displayName: "Recovered Clone",
      initialized: true,
      currentCheckpoint: fixture.rootCheckpoint,
      selectedCheckpoint: fixture.rootCheckpoint,
    });
    expect(await (await PersonaRepository.open(destination)).head()).toBe(fixture.rootCheckpoint);
    expect(recovered.store.preparedRepositoryOperations()).toHaveLength(0);
  });

  it("finishes a recoverable Restore from its persisted digest and sibling transaction", async () => {
    const fixture = await initializedFixture("safe-restore-source");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const personaPath = path.join(fixture.personaPath, "workspace", "persona", "persona.md");
    await writeFile(personaPath, "# Persona\n\nSecond checkpoint.\n", "utf8");
    const second = await repository.prepareCheckpoint("Second checkpoint", "2026-08-30T01:00:00.000Z");
    await repository.advanceCheckpoint(second);
    fixture.runtime.store.registerExistingCheckpoint({
      personaId: fixture.personaId,
      commit: second.commit,
      summary: second.message,
      root: false,
      now: Date.now(),
    });
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const operationId = "recoverable-restore";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      fixture.personaPath,
      operationId,
    );
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "restore",
      payload: {
        checkpoint: fixture.rootCheckpoint,
        discardChanges: false,
        expectedWorkingTreeDigest: reviewed.digest,
        transactionDirectory,
      },
      now: Date.now(),
    });
    await repository.restoreWithSnapshot(fixture.rootCheckpoint, reviewed.digest, transactionDirectory);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(fixture.personaId)).toMatchObject({
      currentCheckpoint: fixture.rootCheckpoint,
      selectedCheckpoint: fixture.rootCheckpoint,
      lifecycle: "ready",
    });
    expect(recovered.store.preparedRepositoryOperations()).toHaveLength(0);
    expect(await readFile(personaPath, "utf8")).toBe("# Persona\n\nOwner-authored root.\n");
  });

  it("fails a prepared normal Delete after a raced Owner save and preserves those bytes", async () => {
    const fixture = await initializedFixture("safe-delete-conflict");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const operationId = "recoverable-delete-conflict";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      fixture.personaPath,
      operationId,
    );
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "delete",
      payload: {
        repositoryPath: fixture.personaPath,
        discardChanges: false,
        expectedWorkingTreeDigest: reviewed.digest,
        transactionDirectory,
      },
      now: Date.now(),
    });
    await expect(
      PersonaRepository.deleteExactWithSnapshot(
        fixture.personaPath,
        fixture.personaPath,
        reviewed.digest,
        transactionDirectory,
        {
          afterQuarantine: async (quarantine) =>
            writeFile(
              path.join(quarantine, "workspace", "persona", "persona.md"),
              "owner save survived crash recovery\n",
              "utf8",
            ),
        },
      ),
    ).rejects.toMatchObject({ code: "dirty_worktree" });
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(fixture.personaId).lifecycle).toBe("faulted");
    expect(recovered.store.preparedRepositoryOperations()).toHaveLength(0);
    expect(await readFile(path.join(fixture.personaPath, "workspace", "persona", "persona.md"), "utf8")).toBe(
      "owner save survived crash recovery\n",
    );
    expect(
      recovered
        .observations(fixture.personaId, 0, 100)
        .some(
          (observation) =>
            observation.kind === "diagnostic" &&
            typeof observation.payload === "object" &&
            observation.payload !== null &&
            !Array.isArray(observation.payload) &&
            observation.payload["code"] === "repository_operation_recovery_conflict",
        ),
    ).toBe(true);
  });

  it("reconciles a quarantined Restore before recovering its pending Memory transaction", async () => {
    const fixture = await initializedFixture("restore-before-memory");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const personaPath = path.join(fixture.personaPath, "workspace", "persona", "persona.md");
    await writeFile(personaPath, "second checkpoint\n", "utf8");
    const second = await repository.prepareCheckpoint("Second checkpoint", "2026-08-30T01:00:00.000Z");
    await repository.advanceCheckpoint(second);
    fixture.runtime.store.registerExistingCheckpoint({
      personaId: fixture.personaId,
      commit: second.commit,
      summary: second.message,
      root: false,
      now: 100,
    });
    const jobId = await preparePendingMemoryTransaction(fixture, "memory recovered after Restore\n", 200);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const operationId = "restore-before-memory-operation";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      fixture.personaPath,
      operationId,
    );
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "restore",
      payload: {
        checkpoint: fixture.rootCheckpoint,
        discardChanges: false,
        expectedWorkingTreeDigest: reviewed.digest,
        transactionDirectory,
      },
      now: 300,
    });

    await expect(
      repository.restoreWithSnapshot(fixture.rootCheckpoint, reviewed.digest, transactionDirectory, {
        afterQuarantine: () => {
          throw new Error("simulated crash after Restore quarantine");
        },
      }),
    ).rejects.toThrow("simulated crash");
    await expect(access(fixture.personaPath)).rejects.toBeDefined();
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(await (await PersonaRepository.open(fixture.personaPath)).head()).toBe(fixture.rootCheckpoint);
    expect(
      await readFile(path.join(fixture.personaPath, "workspace", "memory", "initial.md"), "utf8"),
    ).toContain("Owner-editable source of truth");
    expect(recovered.store.memoryTransactions()).toEqual([]);
    expect(recovered.store.requireHippocampusJob(jobId)).toMatchObject({
      status: "conflict",
      error: { code: "memory_recovery_conflict" },
    });
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
  });

  it("settles pending Checkpoint and Memory obligations after a quarantined Delete", async () => {
    const fixture = await initializedFixture("delete-before-obligations");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const pendingCheckpoint = await prepareAdvancedCheckpointIntent(fixture, 100);
    const jobId = await preparePendingMemoryTransaction(fixture, "must never be installed\n", 200);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const operationId = "delete-before-obligations-operation";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      fixture.personaPath,
      operationId,
    );
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "delete",
      payload: {
        repositoryPath: fixture.personaPath,
        discardChanges: false,
        expectedWorkingTreeDigest: reviewed.digest,
        transactionDirectory,
      },
      now: 300,
    });
    await mkdir(transactionDirectory, { recursive: true });
    await rename(fixture.personaPath, path.join(transactionDirectory, "q"));
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona(fixture.personaId)).toBeUndefined();
    await expect(access(fixture.personaPath)).rejects.toBeDefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
    expect(recovered.store.allPreparedCheckpointIntents()).toEqual([]);
    expect(recovered.store.memoryTransactions()).toEqual([]);
    expect(recovered.store.requireHippocampusJob(jobId)).toMatchObject({
      status: "conflict",
      error: { code: "persona_deleted" },
    });
    expect(
      await readFile(path.join(transactionDirectory, "q", "workspace", "persona", "persona.md"), "utf8"),
    ).toBe("checkpoint intent candidate\n");
    expect(pendingCheckpoint.commit).toMatch(/^[0-9a-f]{40,64}$/u);
  });

  it("anchors an earlier advanced Checkpoint intent without undoing a later prepared Restore", async () => {
    const fixture = await initializedFixture("checkpoint-before-restore");
    const repository = await PersonaRepository.open(fixture.personaPath);
    const pendingCheckpoint = await prepareAdvancedCheckpointIntent(fixture, 100);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const operationId = "later-restore-operation";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      fixture.personaPath,
      operationId,
    );
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "restore",
      payload: {
        checkpoint: fixture.rootCheckpoint,
        discardChanges: false,
        expectedWorkingTreeDigest: reviewed.digest,
        transactionDirectory,
      },
      now: 200,
    });
    await repository.restoreWithSnapshot(fixture.rootCheckpoint, reviewed.digest, transactionDirectory);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(await (await PersonaRepository.open(fixture.personaPath)).head()).toBe(fixture.rootCheckpoint);
    expect(recovered.store.requirePersona(fixture.personaId)).toMatchObject({
      currentCheckpoint: fixture.rootCheckpoint,
      selectedCheckpoint: fixture.rootCheckpoint,
      lifecycle: "ready",
    });
    expect(recovered.store.registeredCheckpoint(fixture.personaId, pendingCheckpoint.commit)).toMatchObject({
      commit: pendingCheckpoint.commit,
      summary: pendingCheckpoint.message,
    });
    expect(recovered.store.allPreparedCheckpointIntents()).toEqual([]);
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
  });

  it("keeps a Repository-operation conflict persistently fail-closed across repeated opens", async () => {
    const fixture = await initializedFixture("persistent-recovery-conflict");
    const repository = await PersonaRepository.open(fixture.personaPath);
    await prepareAdvancedCheckpointIntent(fixture, 100);
    const jobId = await preparePendingMemoryTransaction(fixture, "must remain staged\n", 200);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const operationId = "persistent-delete-conflict";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      fixture.personaPath,
      operationId,
    );
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "delete",
      payload: {
        repositoryPath: fixture.personaPath,
        discardChanges: false,
        expectedWorkingTreeDigest: reviewed.digest,
        transactionDirectory,
      },
      now: 300,
    });
    const ownerPath = path.join(fixture.personaPath, "workspace", "persona", "persona.md");
    await writeFile(ownerPath, "Owner conflict remains authoritative\n", "utf8");
    await closeFixtureRuntime(fixture.runtime);

    const firstOpen = await reopen(fixture.root);
    expect(firstOpen.store.requirePersona(fixture.personaId).lifecycle).toBe("faulted");
    expect(firstOpen.store.preparedRepositoryOperations()).toEqual([]);
    expect(firstOpen.store.allPreparedCheckpointIntents()).toHaveLength(1);
    expect(firstOpen.store.memoryTransactions()).toHaveLength(1);
    expect(firstOpen.store.requireHippocampusJob(jobId).status).toBe("applying");
    expect(await readFile(ownerPath, "utf8")).toBe("Owner conflict remains authoritative\n");
    await closeFixtureRuntime(firstOpen);

    const secondOpen = await reopen(fixture.root);
    expect(secondOpen.store.requirePersona(fixture.personaId).lifecycle).toBe("faulted");
    expect(secondOpen.store.allPreparedCheckpointIntents()).toHaveLength(1);
    expect(secondOpen.store.memoryTransactions()).toHaveLength(1);
    expect(secondOpen.store.requireHippocampusJob(jobId).status).toBe("applying");
    expect(await readFile(ownerPath, "utf8")).toBe("Owner conflict remains authoritative\n");
  });

  it("finishes an owned fetched-but-unborn Clone before adopting its Persona identity", async () => {
    const fixture = await initializedFixture("partial-clone-source");
    const cloneId = "partial-clone-recovered";
    const destination = path.join(fixture.personaDirectory, cloneId);
    const operationId = "partial-clone-operation";
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await createFetchedUnbornClone(fixture.personaPath, fixture.rootCheckpoint, destination);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(cloneId)).toMatchObject({
      initialized: true,
      currentCheckpoint: fixture.rootCheckpoint,
      selectedCheckpoint: fixture.rootCheckpoint,
    });
    const clone = await PersonaRepository.open(destination);
    await expect(clone.assertExactCheckout(fixture.rootCheckpoint)).resolves.toBeUndefined();
    expect(
      (await execFileAsync("git", ["remote"], { cwd: destination, windowsHide: true })).stdout.trim(),
    ).toBe("");
    await expect(access(path.join(destination, ".git", "FETCH_HEAD"))).rejects.toBeDefined();
    expect(await readFile(path.join(destination, ".git", "config"), "utf8")).not.toContain(
      fixture.personaPath,
    );
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
  });

  it("does not adopt or delete Owner bytes in a dirty fetched-but-unborn Clone", async () => {
    const fixture = await initializedFixture("dirty-partial-clone-source");
    const cloneId = "dirty-partial-clone";
    const destination = path.join(fixture.personaDirectory, cloneId);
    fixture.runtime.store.saveRepositoryOperation({
      id: "dirty-partial-clone-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await createFetchedUnbornClone(fixture.personaPath, fixture.rootCheckpoint, destination);
    const ownerPath = path.join(destination, "owner-race.md");
    await writeFile(ownerPath, "Owner bytes in partial Clone\n", "utf8");
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona(cloneId)).toBeUndefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
    expect(await readFile(ownerPath, "utf8")).toBe("Owner bytes in partial Clone\n");
    expect(
      (await execFileAsync("git", ["remote"], { cwd: destination, windowsHide: true })).stdout.trim(),
    ).toBe("");
    await expect(access(path.join(destination, ".git", "FETCH_HEAD"))).rejects.toBeDefined();
  });

  it("inspects a conflicting Clone without replaying its file transaction metadata", async () => {
    const fixture = await initializedFixture("clone-file-transaction-source");
    const cloneId = "clone-file-transaction-conflict";
    const destination = path.join(fixture.personaDirectory, cloneId);
    fixture.runtime.store.saveRepositoryOperation({
      id: "clone-file-transaction-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await createFetchedUnbornClone(fixture.personaPath, fixture.rootCheckpoint, destination);
    const transaction = path.join(destination, ".git", "kokoro-file-transactions", "owner-evidence");
    await mkdir(transaction, { recursive: true });
    await writeFile(
      path.join(transaction, "intent.json"),
      JSON.stringify({
        version: 1,
        path: "workspace/persona/recovered.md",
        expectedSha256: "0".repeat(64),
        replacementSha256: "1".repeat(64),
      }),
      "utf8",
    );
    await writeFile(path.join(transaction, "original"), "Owner transaction original\n", "utf8");
    const target = path.join(destination, "workspace", "persona", "recovered.md");
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona(cloneId)).toBeUndefined();
    await expect(access(target)).rejects.toBeDefined();
    expect(await readFile(path.join(transaction, "original"), "utf8")).toBe("Owner transaction original\n");
    expect(await readFile(path.join(transaction, "intent.json"), "utf8")).toContain(
      "workspace/persona/recovered.md",
    );
  });

  it("does not adopt or rewrite a prepared Clone whose HEAD changed", async () => {
    const fixture = await initializedFixture("wrong-head-clone-source");
    const cloneId = "wrong-head-partial-clone";
    const destination = path.join(fixture.personaDirectory, cloneId);
    fixture.runtime.store.saveRepositoryOperation({
      id: "wrong-head-clone-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await createFetchedUnbornClone(fixture.personaPath, fixture.rootCheckpoint, destination);
    await execFileAsync("git", ["switch", "-C", "owner-branch", fixture.rootCheckpoint], {
      cwd: destination,
      windowsHide: true,
    });
    const ownerPath = path.join(destination, "owner-commit.md");
    await writeFile(ownerPath, "Owner commit in prepared Clone\n", "utf8");
    await execFileAsync("git", ["add", "--all"], { cwd: destination, windowsHide: true });
    await execFileAsync(
      "git",
      ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "commit", "-m", "Owner commit"],
      { cwd: destination, windowsHide: true },
    );
    const ownerHead = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: destination, windowsHide: true })
    ).stdout.trim();
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona(cloneId)).toBeUndefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
    expect(await readFile(ownerPath, "utf8")).toBe("Owner commit in prepared Clone\n");
    expect(
      (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: destination, windowsHide: true })
      ).stdout.trim(),
    ).toBe(ownerHead);
    expect(
      (await execFileAsync("git", ["remote"], { cwd: destination, windowsHide: true })).stdout.trim(),
    ).toBe("");
    await expect(access(path.join(destination, ".git", "FETCH_HEAD"))).rejects.toBeDefined();
  });

  it("recovers a Clone operation that crashed after creating only its empty destination", async () => {
    const fixture = await initializedFixture("empty-clone-source");
    const cloneId = "empty-clone-recovered";
    const destination = path.join(fixture.personaDirectory, cloneId);
    fixture.runtime.store.saveRepositoryOperation({
      id: "empty-clone-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await mkdir(destination, { recursive: false });
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(cloneId)).toMatchObject({
      initialized: true,
      currentCheckpoint: fixture.rootCheckpoint,
    });
    await expect(
      (await PersonaRepository.open(destination)).assertExactCheckout(fixture.rootCheckpoint),
    ).resolves.toBeUndefined();
  });

  it("resumes a Clone checkout from its quarantined unborn Repository and remains stable on a second open", async () => {
    const fixture = await initializedFixture("quarantined-clone-source");
    const cloneId = "quarantined-clone-recovered";
    const destination = path.join(fixture.personaDirectory, cloneId);
    const operationId = "quarantined-clone-operation";
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(destination, operationId);
    fixture.runtime.store.saveRepositoryOperation({
      id: operationId,
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await createFetchedUnbornClone(fixture.personaPath, fixture.rootCheckpoint, destination);
    await execFileAsync("git", ["remote", "remove", "origin"], {
      cwd: destination,
      windowsHide: true,
    });
    await rm(path.join(destination, ".git", "FETCH_HEAD"), { force: true });
    const partial = await PersonaRepository.inspect(destination);
    const reviewed = await partial.stableWorkingTreeSnapshot();
    await expect(
      partial.restoreWithSnapshot(fixture.rootCheckpoint, reviewed.digest, transactionDirectory, {
        afterQuarantine: () => {
          throw new Error("simulated Clone checkout crash");
        },
      }),
    ).rejects.toThrow("simulated Clone checkout crash");
    await expect(access(destination)).rejects.toBeDefined();
    await closeFixtureRuntime(fixture.runtime);

    const firstOpen = await reopen(fixture.root);
    expect(firstOpen.store.requirePersona(cloneId).currentCheckpoint).toBe(fixture.rootCheckpoint);
    await expect(
      (await PersonaRepository.open(destination)).assertExactCheckout(fixture.rootCheckpoint),
    ).resolves.toBeUndefined();
    await closeFixtureRuntime(firstOpen);

    const secondOpen = await reopen(fixture.root);
    expect(secondOpen.store.requirePersona(cloneId).currentCheckpoint).toBe(fixture.rootCheckpoint);
    await expect(
      (await PersonaRepository.open(destination)).assertExactCheckout(fixture.rootCheckpoint),
    ).resolves.toBeUndefined();
  });

  it("rejects a linked worktree instead of adopting it as an independent Clone", async () => {
    const fixture = await initializedFixture("linked-worktree-source");
    const cloneId = "linked-worktree-clone";
    const destination = path.join(fixture.personaDirectory, cloneId);
    fixture.runtime.store.saveRepositoryOperation({
      id: "linked-worktree-clone-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await execFileAsync("git", ["worktree", "add", "--detach", "--", destination, fixture.rootCheckpoint], {
      cwd: fixture.personaPath,
      windowsHide: true,
    });
    const gitFile = await readFile(path.join(destination, ".git"), "utf8");
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona(cloneId)).toBeUndefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
    expect(await readFile(path.join(destination, ".git"), "utf8")).toBe(gitFile);
  });

  it("rejects a Clone operation whose persisted destination does not match its Persona id", async () => {
    const fixture = await initializedFixture("clone-payload-source");
    fixture.runtime.store.saveRepositoryOperation({
      id: "mismatched-clone-payload-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, "mismatched-clone", fixture.personaPath),
      now: 100,
    });
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.getPersona("mismatched-clone")).toBeUndefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
    expect(await (await PersonaRepository.open(fixture.personaPath)).head()).toBe(fixture.rootCheckpoint);
  });

  it("atomically rejects an exact Clone when its Persona id already belongs to another Repository", async () => {
    const fixture = await initializedFixture("existing-clone-identity-source");
    const cloneId = "existing-clone-identity";
    const destination = path.join(fixture.personaDirectory, cloneId);
    const otherRepositoryPath = path.join(fixture.personaDirectory, "different-existing-repository");
    fixture.runtime.store.createPersona({
      id: cloneId,
      displayName: cloneId,
      repositoryPath: otherRepositoryPath,
      uiLocale: "en",
      promptLocale: "en",
      now: 50,
    });
    fixture.runtime.store.saveRepositoryOperation({
      id: "existing-clone-identity-operation",
      personaId: fixture.personaId,
      kind: "clone",
      payload: cloneOperationPayload(fixture, cloneId, destination),
      now: 100,
    });
    await (await PersonaRepository.open(fixture.personaPath)).cloneAt(fixture.rootCheckpoint, destination);
    await closeFixtureRuntime(fixture.runtime);

    const recovered = await reopen(fixture.root);
    expect(recovered.store.requirePersona(cloneId)).toMatchObject({
      repositoryPath: otherRepositoryPath,
      initialized: false,
      currentCheckpoint: null,
    });
    expect(recovered.store.registeredCheckpoint(cloneId, fixture.rootCheckpoint)).toBeUndefined();
    await expect(
      (await PersonaRepository.open(destination)).assertExactCheckout(fixture.rootCheckpoint),
    ).resolves.toBeUndefined();
    expect(recovered.store.preparedRepositoryOperations()).toEqual([]);
  });

  it("rejects an initialization race before persisting a root Checkpoint intent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kokoro-initialize-race-"));
    roots.push(root);
    let raceEnabled = false;
    let enabledCaptures = 0;
    let racedPath = "";
    const runtime = await KokoroRuntime.open({
      stateDirectory: path.join(root, "state"),
      personaDirectory: path.join(root, "personas"),
      authorization: {
        credentialGuards: [
          {
            async capture() {
              if (raceEnabled) {
                enabledCaptures += 1;
                if (enabledCaptures < 2) return null;
                raceEnabled = false;
                await writeFile(racedPath, "Owner edit during initialization\n", "utf8");
              }
              return null;
            },
          },
        ],
        authorize() {
          return { allow: true, revision: "initialize-race-test" };
        },
      },
    });
    runtimes.add(runtime);
    const persona = await runtime.createPersona({
      personaId: "initialize-race",
      displayName: "Initialize Race",
      uiLocale: "en",
      promptLocale: "en",
    });
    racedPath = path.join(persona.repositoryPath, "workspace", "persona", "persona.md");
    raceEnabled = true;

    await expect(runtime.initialize(persona.id)).rejects.toMatchObject({
      code: "working_tree_conflict",
    });
    expect(await readFile(racedPath, "utf8")).toBe("Owner edit during initialization\n");
    expect(await (await PersonaRepository.open(persona.repositoryPath)).head()).toBeNull();
    expect(runtime.store.allPreparedCheckpointIntents()).toEqual([]);
    expect(runtime.store.requirePersona(persona.id)).toMatchObject({
      lifecycle: "draft",
      initialized: false,
    });
  });

  it("fences initialization when its writer lease is lost during review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kokoro-initialize-lease-race-"));
    roots.push(root);
    let stealLease = false;
    let enabledCaptures = 0;
    let runtime: KokoroRuntime;
    let personaId = "";
    runtime = await KokoroRuntime.open({
      stateDirectory: path.join(root, "state"),
      personaDirectory: path.join(root, "personas"),
      authorization: {
        credentialGuards: [
          {
            capture() {
              if (stealLease) {
                enabledCaptures += 1;
                if (enabledCaptures < 2) return null;
                stealLease = false;
                runtime.store.releaseLease(personaId, runtime.incarnation, 1);
                const acquired = runtime.store.acquireLease(personaId, "competing-owner", process.pid, 500);
                if (!acquired.acquired) throw new Error("The competing lease was not acquired.");
              }
              return null;
            },
          },
        ],
        authorize() {
          return { allow: true, revision: "initialize-lease-race-test" };
        },
      },
    });
    runtimes.add(runtime);
    const persona = await runtime.createPersona({
      personaId: "initialize-lease-race",
      displayName: "Initialize Lease Race",
      uiLocale: "en",
      promptLocale: "en",
    });
    personaId = persona.id;
    stealLease = true;

    await expect(runtime.initialize(persona.id)).rejects.toThrow("writer lease is stale");
    expect(await (await PersonaRepository.open(persona.repositoryPath)).head()).toBeNull();
    expect(runtime.store.allPreparedCheckpointIntents()).toEqual([]);
    expect(runtime.store.requirePersona(persona.id)).toMatchObject({
      lifecycle: "draft",
      initialized: false,
    });
  });

  it(
    "keeps every registered Checkpoint addressable after restoring an older detached HEAD",
    async () => {
      const fixture = await initializedFixture("checkpoint-authority");
      const repository = await PersonaRepository.open(fixture.personaPath);
      const personaPath = path.join(fixture.personaPath, "workspace", "persona", "persona.md");
      const addCheckpoint = async (content: string, summary: string, minute: string, now: number) => {
        await writeFile(personaPath, content, "utf8");
        const plan = await repository.prepareCheckpoint(summary, `2026-08-30T0${minute}:00.000Z`);
        await repository.advanceCheckpoint(plan);
        fixture.runtime.store.registerExistingCheckpoint({
          personaId: fixture.personaId,
          commit: plan.commit,
          summary: plan.message,
          root: false,
          now,
        });
        return plan;
      };
      const baseNow = Date.now() + 10;
      const checkpointB = await addCheckpoint("checkpoint B\n", "Checkpoint B", "1:00", baseNow);
      const checkpointC = await addCheckpoint("checkpoint C\n", "Checkpoint C", "2:00", baseNow + 1);

      await fixture.runtime.restore(fixture.personaId, fixture.rootCheckpoint, true);
      const checkpointD = await addCheckpoint(
        "checkpoint D from A\n",
        "Checkpoint D",
        "3:00",
        baseNow + 2,
      );
      await fixture.runtime.restore(fixture.personaId, checkpointC.commit, true);
      await execFileAsync("git", ["gc", "--prune=now"], {
        cwd: fixture.personaPath,
        windowsHide: true,
      });

      expect(
        (await fixture.runtime.checkpoints(fixture.personaId, null, 10)).map((entry) => entry.commit),
      ).toEqual([checkpointD.commit, checkpointC.commit, checkpointB.commit, fixture.rootCheckpoint]);
      expect(await fixture.runtime.checkpoints(fixture.personaId, checkpointD.commit, 1)).toEqual([
        expect.objectContaining({ commit: checkpointC.commit }),
      ]);

      const clone = await fixture.runtime.clone({
        personaId: fixture.personaId,
        checkpoint: checkpointD.commit,
        newPersonaId: "newer-clone",
        displayName: "Newer Clone",
      });
      expect(
        await readFile(path.join(clone.repositoryPath, "workspace", "persona", "persona.md"), "utf8"),
      ).toBe("checkpoint D from A\n");
      expect(
        (
          await execFileAsync("git", ["remote"], { cwd: clone.repositoryPath, windowsHide: true })
        ).stdout.trim(),
      ).toBe("");
      await fixture.runtime.branch(fixture.personaId, checkpointD.commit, "review-newer");
      await fixture.runtime.restore(fixture.personaId, checkpointD.commit, false);
      expect(await (await PersonaRepository.open(fixture.personaPath)).head()).toBe(checkpointD.commit);

      await writeFile(personaPath, "unregistered dangling commit\n", "utf8");
      const dangling = await (await PersonaRepository.open(fixture.personaPath)).prepareCheckpoint(
        "Unregistered dangling",
        "2026-08-30T02:00:00.000Z",
      );
      await expect(fixture.runtime.restore(fixture.personaId, dangling.commit, true)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        fixture.runtime.branch(fixture.personaId, dangling.commit, "must-not-exist"),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        fixture.runtime.clone({
          personaId: fixture.personaId,
          checkpoint: dangling.commit,
          newPersonaId: "dangling-clone",
          displayName: "Dangling Clone",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
    120_000,
  );
});

async function prepareAdvancedCheckpointIntent(
  fixture: Awaited<ReturnType<typeof initializedFixture>>,
  now: number,
) {
  const repository = await PersonaRepository.open(fixture.personaPath);
  await writeFile(
    path.join(fixture.personaPath, "workspace", "persona", "persona.md"),
    "checkpoint intent candidate\n",
    "utf8",
  );
  const plan = await repository.prepareCheckpoint("Prepared checkpoint intent", "2026-08-30T01:00:00.000Z");
  fixture.runtime.store.saveCheckpointIntent({
    personaId: fixture.personaId,
    kind: "event",
    commit: plan.commit,
    plan: JSON.parse(JSON.stringify(plan)),
    now,
  });
  await repository.advanceCheckpoint(plan);
  return plan;
}

async function preparePendingMemoryTransaction(
  fixture: Awaited<ReturnType<typeof initializedFixture>>,
  replacement: string,
  now: number,
): Promise<string> {
  const store = fixture.runtime.store;
  const selectedCheckpoint = store.requirePersona(fixture.personaId).currentCheckpoint;
  if (!selectedCheckpoint) throw new Error("The fixture Persona has no selected Checkpoint.");
  const run = store.createRun({
    personaId: fixture.personaId,
    incarnation: fixture.runtime.incarnation,
    model: { provider: "test", model: "memory-recovery" },
    startingCheckpoint: selectedCheckpoint,
    now,
  });
  const item = store.enqueue({ runId: run.id, kind: "start", payload: {}, now: now + 1 });
  store.markQueueStarted(item.id, now + 2);
  const event = store.createEvent({
    personaId: fixture.personaId,
    run,
    item,
    now: now + 3,
  });
  store.freezeEvent(event.id, { eventId: event.id }, now + 4);
  store.closeEvent(event.id, "Pending Memory recovery", "maintain", now + 5);
  store.checkpointEvent(event.id, selectedCheckpoint, now + 6);
  store.markQueueCompleted(item.id, now + 7);
  const job = store.createHippocampusJob({
    personaId: fixture.personaId,
    eventId: event.id,
    sourceCheckpoint: selectedCheckpoint,
    model: run.model,
    promptLocale: "en",
    now: now + 8,
  });
  store.updateHippocampusJob(job.id, { status: "applying" }, now + 9);
  store.updateRun(run.id, {
    phase: "stopped",
    currentQueueItemId: null,
    waitingCode: null,
    endedAt: now + 10,
  });
  store.updatePersona(fixture.personaId, { lifecycle: "ready" });

  const manager = new MemoryTransactionManager(store, {
    now: () => now + 11,
    fault: (point) => {
      if (point === "after_record") throw new Error("simulated Memory transaction crash");
    },
  });
  const repository = await PersonaRepository.open(fixture.personaPath);
  const review = await manager.review(repository);
  await expect(
    manager.apply(
      job.id,
      repository,
      {
        operations: [{ kind: "replace", path: "workspace/memory/initial.md", content: replacement }],
      },
      review.manifest,
    ),
  ).rejects.toBeInstanceOf(MemoryTransactionRecoveryRequiredError);
  return job.id;
}

function cloneOperationPayload(
  fixture: Awaited<ReturnType<typeof initializedFixture>>,
  cloneId: string,
  destination: string,
) {
  return {
    checkpoint: fixture.rootCheckpoint,
    newPersonaId: cloneId,
    displayName: cloneId,
    destination,
    uiLocale: "en",
    promptLocale: "en",
  };
}

async function createFetchedUnbornClone(
  source: string,
  checkpoint: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: false });
  await execFileAsync("git", ["init", "--initial-branch=kokoro-main", "--", destination], {
    windowsHide: true,
  });
  await execFileAsync("git", ["remote", "add", "origin", source], {
    cwd: destination,
    windowsHide: true,
  });
  const checkpointRef = `refs/kokoro/checkpoints/${checkpoint}`;
  await execFileAsync("git", ["fetch", "--no-tags", "origin", `+${checkpointRef}:${checkpointRef}`], {
    cwd: destination,
    windowsHide: true,
  });
}

async function initializedFixture(personaId: string): Promise<{
  root: string;
  personaDirectory: string;
  personaId: string;
  personaPath: string;
  rootCheckpoint: string;
  runtime: KokoroRuntime;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "kokoro-repository-operation-"));
  roots.push(root);
  const personaDirectory = path.join(root, "personas");
  const runtime = await KokoroRuntime.open({
    stateDirectory: path.join(root, "state"),
    personaDirectory,
  });
  runtimes.add(runtime);
  const persona = await runtime.createPersona({
    personaId,
    displayName: personaId,
    uiLocale: "en",
    promptLocale: "en",
  });
  await writeFile(
    path.join(persona.repositoryPath, "workspace", "persona", "persona.md"),
    "# Persona\n\nOwner-authored root.\n",
    "utf8",
  );
  const initialized = await runtime.initialize(persona.id);
  if (!initialized.currentCheckpoint) throw new Error("Initialization did not create a Checkpoint.");
  return {
    root,
    personaDirectory,
    personaId: persona.id,
    personaPath: persona.repositoryPath,
    rootCheckpoint: initialized.currentCheckpoint,
    runtime,
  };
}

async function closeFixtureRuntime(runtime: KokoroRuntime): Promise<void> {
  await runtime.close();
  runtimes.delete(runtime);
}

async function reopen(root: string): Promise<KokoroRuntime> {
  const runtime = await KokoroRuntime.open({
    stateDirectory: path.join(root, "state"),
    personaDirectory: path.join(root, "personas"),
  });
  runtimes.add(runtime);
  return runtime;
}
