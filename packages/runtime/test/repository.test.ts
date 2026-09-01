import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PersonaRepository, type RepositoryError } from "../src/repository/index.js";

const sandboxes: string[] = [];
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
  });
  return result.stdout;
}

async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kokoro-repository-test-"));
  sandboxes.push(root);
  return root;
}

async function draft(): Promise<{ sandboxRoot: string; repository: PersonaRepository }> {
  const sandboxRoot = await sandbox();
  const repository = await PersonaRepository.createDraft(path.join(sandboxRoot, "persona"), {
    persona: "# Persona\n\nOriginal persona.\n",
    memory: "# Memory\n\nOriginal memory.\n",
  });
  return { sandboxRoot, repository };
}

async function foreignCommitWithPaths(
  repository: PersonaRepository,
  sandboxRoot: string,
  parent: string,
  relativePaths: readonly string[],
): Promise<string> {
  const environment = { GIT_INDEX_FILE: path.join(sandboxRoot, "foreign.index") };
  const plumbing = ["-c", "core.ignorecase=false", "-c", "core.precomposeunicode=false"];
  await git(repository.root, [...plumbing, "read-tree", parent], environment);
  for (const [index, relativePath] of relativePaths.entries()) {
    const source = path.join(sandboxRoot, `foreign-blob-${index}`);
    await writeFile(source, `foreign ${index}\n`, "utf8");
    const blob = (await git(repository.root, ["hash-object", "-w", "--", source])).trim();
    await git(
      repository.root,
      [...plumbing, "update-index", "--add", "--cacheinfo", `100644,${blob},${relativePath}`],
      environment,
    );
  }
  const indexedPaths = (await git(repository.root, [...plumbing, "ls-files", "-z"], environment))
    .split("\0")
    .filter(Boolean);
  expect(indexedPaths).toEqual(expect.arrayContaining([...relativePaths]));
  const tree = (await git(repository.root, [...plumbing, "write-tree"], environment)).trim();
  return (
    await git(repository.root, [
      "-c",
      "user.name=Kokoro Test",
      "-c",
      "user.email=kokoro-test@localhost",
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "foreign portable path",
    ])
  ).trim();
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PersonaRepository", () => {
  it("creates a draft without smuggling in a root checkpoint, then advances the prepared root exactly once", async () => {
    const { repository } = await draft();

    expect(await repository.hasCheckpoint()).toBe(false);
    expect(await repository.readPersonaDocuments()).toEqual([
      expect.objectContaining({
        path: "workspace/persona/persona.md",
        content: "# Persona\n\nOriginal persona.\n",
      }),
    ]);
    expect(await repository.readMemoryDocuments()).toEqual([
      expect.objectContaining({
        path: "workspace/memory/initial.md",
        content: "# Memory\n\nOriginal memory.\n",
      }),
    ]);

    const plan = await repository.prepareCheckpoint(
      "  Initial\nroot   checkpoint  ",
      "2026-08-30T00:00:00.000Z",
    );
    expect(plan.parent).toBeNull();
    expect(plan.message).toBe("Initial root checkpoint");
    expect(await repository.head()).toBeNull();

    await expect(repository.advanceCheckpoint(plan)).resolves.toEqual({
      commit: plan.commit,
      advanced: true,
    });
    await expect(repository.advanceCheckpoint(plan)).resolves.toEqual({
      commit: plan.commit,
      advanced: false,
    });
    expect(await repository.listCheckpoints()).toEqual([
      expect.objectContaining({ commit: plan.commit, parent: null, message: "Initial root checkpoint" }),
    ]);
    expect(await repository.isDirty()).toBe(false);
  });

  it("opens only the repository root", async () => {
    const { repository } = await draft();

    await expect(PersonaRepository.open(repository.root)).resolves.toMatchObject({ root: repository.root });
    await expect(PersonaRepository.open(path.join(repository.root, "workspace"))).rejects.toMatchObject({
      code: "not_initialized",
    });
  });

  it("rejects credential-like content anywhere in the exact staged Checkpoint tree", async () => {
    const { repository } = await draft();
    await writeFile(path.join(repository.root, ".env"), "API_KEY=sk-abcdefghijklmnop12345678\n", "utf8");

    await expect(
      repository.prepareCheckpoint("must not commit credentials", "2026-08-30T00:00:00.000Z"),
    ).rejects.toMatchObject({ name: "CredentialBoundaryError", surface: "Git Checkpoint content" });
    expect(await repository.head()).toBeNull();
  });

  it("fences a prepared checkpoint with a compare-and-swap on HEAD", async () => {
    const { repository } = await draft();
    const root = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(root);

    await writeFile(
      path.join(repository.root, "workspace", "persona", "persona.md"),
      "first candidate\n",
      "utf8",
    );
    const losingPlan = await repository.prepareCheckpoint("losing", "2026-08-30T00:01:00.000Z");
    await writeFile(
      path.join(repository.root, "workspace", "persona", "persona.md"),
      "winning candidate\n",
      "utf8",
    );
    const winningPlan = await repository.prepareCheckpoint("winning", "2026-08-30T00:02:00.000Z");

    await expect(repository.advanceCheckpoint(winningPlan)).resolves.toMatchObject({ advanced: true });
    await expect(repository.advanceCheckpoint(losingPlan)).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.head()).toBe(winningPlan.commit);
    expect(await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8")).toBe(
      "winning candidate\n",
    );
  });

  it("allows exactly one of two concurrent writes from the same observed SHA-256", async () => {
    const { repository } = await draft();
    const relativePath = "workspace/persona/persona.md";
    const observed = await repository.readText(relativePath);
    const candidates = ["first concurrent candidate\n", "second concurrent candidate\n"] as const;

    const outcomes = await Promise.allSettled(
      candidates.map((content) => repository.writeText(relativePath, content, observed.sha256)),
    );

    const successes = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.writeText>>> =>
        outcome.status === "fulfilled",
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: "conflict" });

    const finalDocument = await repository.readText(relativePath);
    expect(candidates).toContain(finalDocument.content);
    expect(finalDocument.content).toBe(successes[0]?.value.content);
    expect(finalDocument.sha256).toBe(successes[0]?.value.sha256);
  });

  it("creates a missing workspace file only when the expected SHA-256 is null", async () => {
    const { repository } = await draft();
    const created = await repository.writeText(
      "workspace/notes/new-observation.md",
      "Owner-visible work product.\n",
      null,
    );

    expect(created).toMatchObject({
      path: "workspace/notes/new-observation.md",
      content: "Owner-visible work product.\n",
    });
    await expect(
      repository.writeText("workspace/notes/new-observation.md", "silent overwrite\n", null),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a dirty restore and force-restores tracked and untracked state", async () => {
    const { repository } = await draft();
    const first = await repository.prepareCheckpoint("first", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(first);
    await writeFile(path.join(repository.root, "workspace", "persona", "persona.md"), "second\n", "utf8");
    const second = await repository.prepareCheckpoint("second", "2026-08-30T00:01:00.000Z");
    await repository.advanceCheckpoint(second);

    await writeFile(path.join(repository.root, "workspace", "persona", "persona.md"), "dirty\n", "utf8");
    const untracked = path.join(repository.root, "workspace", "persona", "untracked.md");
    await writeFile(untracked, "untracked\n", "utf8");

    await expect(repository.restore(first.commit)).rejects.toMatchObject({ code: "dirty_worktree" });
    expect(await readFile(untracked, "utf8")).toBe("untracked\n");

    await repository.forceRestore(first.commit);
    expect(await repository.head()).toBe(first.commit);
    expect(await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8")).toBe(
      "# Persona\n\nOriginal persona.\n",
    );
    await expect(access(untracked)).rejects.toBeDefined();
    expect(await repository.isDirty()).toBe(false);
  });

  it("restores the quarantined Owner tree when an editor saves after the reviewed snapshot", async () => {
    const { repository } = await draft();
    const first = await repository.prepareCheckpoint("first", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(first);
    const personaPath = path.join(repository.root, "workspace", "persona", "persona.md");
    await writeFile(personaPath, "second checkpoint\n", "utf8");
    const second = await repository.prepareCheckpoint("second", "2026-08-30T00:01:00.000Z");
    await repository.advanceCheckpoint(second);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const transaction = PersonaRepository.operationTransactionDirectory(repository.root, "restore-race");

    await expect(
      repository.restoreWithSnapshot(first.commit, reviewed.digest, transaction, {
        afterPrecondition: async () => writeFile(personaPath, "owner save in restore race\n", "utf8"),
      }),
    ).rejects.toMatchObject({ code: "dirty_worktree" });

    expect(await repository.head()).toBe(second.commit);
    expect(await readFile(personaPath, "utf8")).toBe("owner save in restore race\n");
    await expect(access(path.join(transaction, "q"))).rejects.toBeDefined();
  });

  it("quarantines an exact normal Delete without touching another Repository", async () => {
    const { repository, sandboxRoot } = await draft();
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    const other = await PersonaRepository.createDraft(path.join(sandboxRoot, "other-persona"), {
      persona: "# Other\n",
      memory: "# Memory\n",
    });
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const transaction = PersonaRepository.operationTransactionDirectory(repository.root, "delete-clean");

    await PersonaRepository.deleteExactWithSnapshot(
      repository.root,
      repository.root,
      reviewed.digest,
      transaction,
    );

    await expect(access(repository.root)).rejects.toBeDefined();
    expect(await readFile(path.join(transaction, "q", "workspace", "persona", "persona.md"), "utf8")).toBe(
      "# Persona\n\nOriginal persona.\n",
    );
    expect(await other.readPersonaDocuments()).toHaveLength(1);
  });

  it("never deletes bytes saved into the Delete quarantine race", async () => {
    const { repository } = await draft();
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    const reviewed = await repository.stableWorkingTreeSnapshot();
    const transaction = PersonaRepository.operationTransactionDirectory(repository.root, "delete-race");

    await expect(
      PersonaRepository.deleteExactWithSnapshot(
        repository.root,
        repository.root,
        reviewed.digest,
        transaction,
        {
          afterQuarantine: async (quarantine) =>
            writeFile(
              path.join(quarantine, "workspace", "persona", "persona.md"),
              "owner save in delete race\n",
              "utf8",
            ),
        },
      ),
    ).rejects.toMatchObject({ code: "dirty_worktree" });

    expect(await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8")).toBe(
      "owner save in delete race\n",
    );
  });

  it("preserves a nested Git directory that races final Clone validation", async () => {
    const { repository, sandboxRoot } = await draft();
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    const destination = path.join(sandboxRoot, "raced-clone");
    const ownerPath = path.join(destination, "ignored", ".GIT", "owner.txt");

    await expect(
      repository.cloneAt(checkpoint.commit, destination, {
        afterCheckout: async () => {
          await mkdir(path.dirname(ownerPath), { recursive: true });
          await writeFile(ownerPath, "Owner nested Git bytes\n", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });

    expect(await readFile(ownerPath, "utf8")).toBe("Owner nested Git bytes\n");
  });

  it("preserves CRLF bytes exactly despite host Git configuration", async () => {
    const { repository, sandboxRoot } = await draft();
    const personaPath = path.join(repository.root, "workspace", "persona", "persona.md");
    const content = "# Persona\r\n\r\nOwner CRLF bytes.\r\n";
    await writeFile(personaPath, content, "utf8");
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    const clone = await repository.cloneAt(checkpoint.commit, path.join(sandboxRoot, "crlf-clone"));

    expect(await readFile(path.join(clone.root, "workspace", "persona", "persona.md"), "utf8")).toBe(content);
    await expect(clone.assertExactCheckout(checkpoint.commit)).resolves.toBeUndefined();
  });

  it("rejects linked Git object metadata before a mutating Git command", async () => {
    const { repository, sandboxRoot } = await draft();
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    const external = path.join(sandboxRoot, "external-objects");
    await mkdir(external);
    const sentinel = path.join(external, "sentinel.txt");
    await writeFile(sentinel, "external metadata sentinel\n", "utf8");
    let linkedFanout = "";
    for (let index = 0; index < 256; index += 1) {
      const candidate = path.join(repository.root, ".git", "objects", index.toString(16).padStart(2, "0"));
      try {
        await access(candidate);
      } catch {
        linkedFanout = candidate;
        break;
      }
    }
    if (linkedFanout === "") throw new Error("No unused Git object fanout was available.");
    await symlink(external, linkedFanout, process.platform === "win32" ? "junction" : "dir");

    await expect(
      repository.prepareCheckpoint("must not mutate", "2026-08-30T00:01:00.000Z"),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(await readFile(sentinel, "utf8")).toBe("external metadata sentinel\n");
  });

  it("treats ignored Owner files as dirty and preserves them during an ordinary Restore", async () => {
    const { repository } = await draft();
    await writeFile(path.join(repository.root, ".gitignore"), "ignored.bin\n", "utf8");
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    const ignored = path.join(repository.root, "ignored.bin");
    await writeFile(ignored, "Owner ignored bytes\n", "utf8");

    expect(await repository.isDirty()).toBe(true);
    await expect(repository.restore(checkpoint.commit)).rejects.toMatchObject({
      code: "dirty_worktree",
    });
    expect(await readFile(ignored, "utf8")).toBe("Owner ignored bytes\n");
  });

  it("round-trips .gitattributes and raw LF bytes without invoking filters", async () => {
    const { repository, sandboxRoot } = await draft();
    const rawPath = path.join(repository.root, "workspace", "persona", "raw.txt");
    await writeFile(path.join(repository.root, ".gitattributes"), "*.txt text eol=crlf\n", "utf8");
    await writeFile(rawPath, "line one\nline two\n", "utf8");
    const checkpoint = await repository.prepareCheckpoint("attributes", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    await writeFile(rawPath, "changed\r\n", "utf8");

    await repository.forceRestore(checkpoint.commit);
    expect(await readFile(rawPath, "utf8")).toBe("line one\nline two\n");
    const clone = await repository.cloneAt(checkpoint.commit, path.join(sandboxRoot, "attributes-clone"));
    expect(await readFile(path.join(clone.root, "workspace", "persona", "raw.txt"), "utf8")).toBe(
      "line one\nline two\n",
    );
    expect(await readFile(path.join(clone.root, ".gitattributes"), "utf8")).toBe("*.txt text eol=crlf\n");
  });

  it("fails before Force mutation when mutable Git attributes metadata appears", async () => {
    const { repository } = await draft();
    const personaPath = path.join(repository.root, "workspace", "persona", "persona.md");
    const first = await repository.prepareCheckpoint("first", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(first);
    await writeFile(personaPath, "second\n", "utf8");
    const second = await repository.prepareCheckpoint("second", "2026-08-30T00:01:00.000Z");
    await repository.advanceCheckpoint(second);
    await writeFile(path.join(repository.root, ".git", "info", "attributes"), "*.md text eol=crlf\n");

    await expect(repository.forceRestore(first.commit)).rejects.toMatchObject({ code: "invalid_path" });
    expect(await repository.head()).toBe(second.commit);
    expect(await readFile(personaPath, "utf8")).toBe("second\n");
  });

  it("preserves ordinary remotes while exactly force-restoring working bytes", async () => {
    const { repository, sandboxRoot } = await draft();
    const personaPath = path.join(repository.root, "workspace", "persona", "persona.md");
    const first = await repository.prepareCheckpoint("first", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(first);
    await writeFile(personaPath, "second\n", "utf8");
    const second = await repository.prepareCheckpoint("second", "2026-08-30T00:01:00.000Z");
    await repository.advanceCheckpoint(second);
    await git(repository.root, ["remote", "add", "backup", sandboxRoot]);

    await repository.forceRestore(first.commit);
    expect((await git(repository.root, ["remote"])).trim()).toBe("backup");
    expect(await readFile(personaPath, "utf8")).toBe("# Persona\n\nOriginal persona.\n");
  });

  it("ignores Git replace refs when addressing and materializing a Checkpoint", async () => {
    const { repository } = await draft();
    const personaPath = path.join(repository.root, "workspace", "persona", "persona.md");
    const first = await repository.prepareCheckpoint("first", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(first);
    await writeFile(personaPath, "replacement commit bytes\n", "utf8");
    const second = await repository.prepareCheckpoint("second", "2026-08-30T00:01:00.000Z");
    await repository.advanceCheckpoint(second);
    await git(repository.root, ["replace", first.commit, second.commit]);

    await repository.forceRestore(first.commit);
    expect(await readFile(personaPath, "utf8")).toBe("# Persona\n\nOriginal persona.\n");
    await expect(repository.checkpointInfo(first.commit)).resolves.toMatchObject({
      commit: first.commit,
      message: "first",
    });
  });

  it("supports Checkpoints containing a blob larger than the former Git output buffer", async () => {
    const { repository } = await draft();
    const large = Buffer.alloc(17 * 1024 * 1024, 0x78);
    await writeFile(path.join(repository.root, "workspace", "persona", "large.bin"), large);

    const checkpoint = await repository.prepareCheckpoint("large", "2026-08-30T00:00:00.000Z");
    await expect(repository.advanceCheckpoint(checkpoint)).resolves.toMatchObject({ advanced: true });
    expect(await repository.isDirty()).toBe(false);
  });

  it("prepares a many-file Checkpoint without per-file Git subprocesses or metadata scans", async () => {
    const { repository } = await draft();
    const directory = path.join(repository.root, "workspace", "persona", "bulk");
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        writeFile(path.join(directory, `${String(index).padStart(3, "0")}.md`), `bulk ${index}\n`, "utf8"),
      ),
    );
    const first = await repository.prepareCheckpoint("bulk root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(first);
    await writeFile(path.join(directory, "040.md"), "bulk changed\n", "utf8");

    const startedAt = performance.now();
    await repository.prepareCheckpoint("bulk next", "2026-08-30T00:01:00.000Z");
    expect(performance.now() - startedAt).toBeLessThan(20_000);
  });

  it("rejects Checkpoint ABA even when the reviewed and final live trees are identical", async () => {
    const { repository } = await draft();
    const personaPath = path.join(repository.root, "workspace", "persona", "persona.md");
    const reviewed = "stable A\n";
    const transient = "transient B that must never be committed\n";
    await writeFile(personaPath, reviewed, "utf8");

    await expect(
      repository.prepareCheckpoint("ABA", "2026-08-30T00:00:00.000Z", {
        afterReview: async () => writeFile(personaPath, transient, "utf8"),
        afterCandidateCaptured: async () => writeFile(personaPath, reviewed, "utf8"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.head()).toBeNull();
    expect(await readFile(personaPath, "utf8")).toBe(reviewed);
    const transientObject = (
      await git(repository.root, ["hash-object", "--no-filters", "--", personaPath])
    ).trim();
    await expect(
      access(
        path.join(repository.root, ".git", "objects", transientObject.slice(0, 2), transientObject.slice(2)),
      ),
    ).rejects.toBeDefined();
  });

  it("remains openable after a standard local Clone hardlinks Git object artifacts", async () => {
    const { repository, sandboxRoot } = await draft();
    const checkpoint = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    await git(repository.root, ["gc"]);
    await git(sandboxRoot, ["clone", "--local", "--no-checkout", repository.root, "backup"]);

    await expect(PersonaRepository.open(repository.root)).resolves.toMatchObject({ root: repository.root });
  });

  it("resumes an interrupted Clone init with only owned Git metadata", async () => {
    const sandboxRoot = await sandbox();
    const destination = path.join(sandboxRoot, "partial-clone");
    await mkdir(path.join(destination, ".git"), { recursive: true });

    const repository = await PersonaRepository.initializeEmptyClone(destination);
    expect(await repository.head()).toBeNull();
    expect(await repository.listFiles(".")).toEqual([]);
  });

  it("keeps durable Checkpoint refs accessible beyond the legacy Windows path boundary", async () => {
    const sandboxRoot = await sandbox();
    const longRoot = path.join(
      sandboxRoot,
      "isolated-environment-segment-aaaaaaaaaaaaaaaaaaaa",
      "isolated-environment-segment-bbbbbbbbbbbbbbbbbbbb",
    );
    await mkdir(longRoot, { recursive: true });
    const repository = await PersonaRepository.createDraft(path.join(longRoot, "source"), {
      persona: "# Long path Persona\n",
      memory: "# Long path Memory\n",
    });
    const checkpoint = await repository.prepareCheckpoint("long path", "2026-08-30T00:00:00.000Z");
    await repository.advanceCheckpoint(checkpoint);
    expect((await git(repository.root, ["config", "--local", "--get", "core.longpaths"])).trim()).toBe(
      "true",
    );
    const destination = path.join(longRoot, "personas", "clone");
    await mkdir(path.dirname(destination), { recursive: true });
    const transactionDirectory = PersonaRepository.operationTransactionDirectory(
      destination,
      "long-path-recovery",
    );
    const candidateRef = path.join(
      transactionDirectory,
      "c",
      ".git",
      "refs",
      "kokoro",
      "checkpoints",
      checkpoint.commit,
    );
    if (process.platform === "win32") {
      const candidateRoot = path.join(transactionDirectory, "c");
      expect(candidateRoot.length).toBeLessThanOrEqual(239);
      expect(candidateRef.length).toBeGreaterThan(260);
    }

    const clone = await repository.cloneAt(checkpoint.commit, destination, {}, transactionDirectory);
    await expect(clone.assertExactCheckout(checkpoint.commit)).resolves.toBeUndefined();
    expect((await git(clone.root, ["config", "--local", "--get", "core.longpaths"])).trim()).toBe("true");
  });

  it("rejects root Git metadata whose case is not exactly .git", async () => {
    const { repository } = await draft();
    const metadata = path.join(repository.root, ".git");
    const intermediate = path.join(repository.root, ".kokoro-git-case-swap");
    await rename(metadata, intermediate);
    await rename(intermediate, path.join(repository.root, ".GIT"));

    await expect(PersonaRepository.open(repository.root)).rejects.toMatchObject({
      code: "not_initialized",
    });
  });

  it(
    "rejects candidate paths that collide after case folding before object persistence",
    async ({ skip }) => {
      const { repository } = await draft();
      const directory = path.join(repository.root, "workspace", "persona");
      await writeFile(path.join(directory, "A.md"), "upper candidate\n", "utf8");
      await writeFile(path.join(directory, "a.md"), "lower candidate\n", "utf8");
      const entries = new Set(await readdir(directory));
      if (!entries.has("A.md") || !entries.has("a.md")) {
        skip("the test filesystem cannot represent distinct case-colliding paths");
      }

      await expect(
        repository.prepareCheckpoint("portable", "2026-08-30T00:00:00.000Z"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      expect(await repository.head()).toBeNull();
    },
  );

  it(
    "rejects candidate paths that collide after NFC normalization",
    async ({ skip }) => {
      const { repository } = await draft();
      const directory = path.join(repository.root, "workspace", "persona");
      await writeFile(path.join(directory, "é.md"), "composed candidate\n", "utf8");
      await writeFile(path.join(directory, "é.md"), "decomposed candidate\n", "utf8");
      const entries = new Set(await readdir(directory));
      if (!entries.has("é.md") || !entries.has("é.md")) {
        skip("the test filesystem cannot represent distinct normalization-colliding paths");
      }

      await expect(
        repository.prepareCheckpoint("portable", "2026-08-30T00:00:00.000Z"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      expect(await repository.head()).toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a literal backslash in a candidate repository path",
    async () => {
      const { repository } = await draft();
      await writeFile(
        path.join(repository.root, "workspace", "persona", "dir\\file.md"),
        "ambiguous candidate\n",
        "utf8",
      );

      await expect(
        repository.prepareCheckpoint("portable", "2026-08-30T00:00:00.000Z"),
      ).rejects.toMatchObject({ code: "invalid_path" });
      expect(await repository.head()).toBeNull();
    },
  );

  it.each([
    ["case folding", "A.md", "a.md"],
    ["NFC normalization", "é.md", "é.md"],
    ["Unicode case folding", "Σ.md", "ς.md"],
  ])(
    "rejects a foreign commit tree with paths that collide after %s",
    async (_kind, firstPath, secondPath) => {
      const { repository, sandboxRoot } = await draft();
      const root = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
      await repository.advanceCheckpoint(root);
      const foreign = await foreignCommitWithPaths(repository, sandboxRoot, root.commit, [
        `workspace/persona/${firstPath}`,
        `workspace/persona/${secondPath}`,
      ]);

      await expect(repository.ensureCheckpointRef(foreign)).rejects.toMatchObject({
        code: "invalid_checkpoint",
      });
    },
  );

  it.each(["COM¹.md", "LPT³.md"])(
    "rejects a foreign commit tree containing the Windows device name %s",
    async (reservedName) => {
      const { repository, sandboxRoot } = await draft();
      const root = await repository.prepareCheckpoint("root", "2026-08-30T00:00:00.000Z");
      await repository.advanceCheckpoint(root);
      const foreign = await foreignCommitWithPaths(repository, sandboxRoot, root.commit, [
        `workspace/persona/${reservedName}`,
      ]);

      await expect(repository.ensureCheckpointRef(foreign)).rejects.toMatchObject({
        code: "invalid_checkpoint",
      });
    },
  );

  it("rejects traversal, absolute paths, and Persona writes into long-term Memory", async () => {
    const { repository, sandboxRoot } = await draft();
    const outside = path.join(sandboxRoot, "outside.md");
    await writeFile(outside, "outside\n", "utf8");

    await expect(repository.readText("../outside.md")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(repository.readText(outside)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(repository.writeText("../escape.md", "escape", null)).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(repository.listFiles("../../")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(repository.writeText("workspace/memory/forbidden.md", "memory", null)).rejects.toMatchObject(
      {
        code: "invalid_path",
      },
    );

    expect(await readFile(outside, "utf8")).toBe("outside\n");
    expect(await repository.listFiles(".")).toEqual([
      "workspace/memory/initial.md",
      "workspace/persona/persona.md",
    ]);
  });

  it("does not follow directory junctions or symbolic links during managed reads", async () => {
    const { repository, sandboxRoot } = await draft();
    const external = path.join(sandboxRoot, "external");
    await mkdir(external);
    await writeFile(path.join(external, "leak.md"), "must not be read\n", "utf8");
    const link = path.join(repository.root, "workspace", "persona", "external-link");
    await symlink(external, link, process.platform === "win32" ? "junction" : "dir");

    await expect(repository.readPersonaDocuments()).rejects.toEqual(
      expect.objectContaining<Partial<RepositoryError>>({ code: "invalid_path" }),
    );
    await expect(repository.readText("workspace/persona/external-link/leak.md")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(
      repository.writeText("workspace/persona/external-link/escaped.md", "must not escape\n", null),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(access(path.join(external, "escaped.md"))).rejects.toBeDefined();
  });
});
