import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AsyncMutex } from "../async.js";
import { filesystemDirectoriesEqual } from "../filesystem-path.js";
import {
  type CredentialBoundary,
  type CredentialSnapshot,
  captureCredentialSnapshot,
  NO_CREDENTIAL_GUARDS,
} from "../security.js";

const execFileAsync = promisify(execFile);
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";
const REPOSITORY_OPERATION_CANDIDATE = "c";
const REPOSITORY_OPERATION_QUARANTINE = "q";
const DEFAULT_CREDENTIAL_BOUNDARY: CredentialBoundary = Object.freeze({
  credentialGuards: NO_CREDENTIAL_GUARDS,
});

export class RepositoryError extends Error {
  readonly code:
    | "conflict"
    | "dirty_worktree"
    | "invalid_checkpoint"
    | "invalid_path"
    | "not_found"
    | "not_initialized"
    | "path_exists";

  constructor(code: RepositoryError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryError";
    this.code = code;
  }
}

export interface RepositoryDocument {
  path: string;
  content: string;
  sha256: string;
  mtimeMs: number;
}

export interface CheckpointPlan {
  version: 1;
  parent: string | null;
  tree: string;
  commit: string;
  message: string;
  timestamp: string;
}

export interface CheckpointInfo {
  commit: string;
  parent: string | null;
  message: string;
  timestamp: string;
}

interface GitTreeEntry {
  relativePath: string;
  mode: "100644" | "100755";
  objectId: string;
}

export interface AdvanceCheckpointResult {
  commit: string;
  advanced: boolean;
}

/** Testable boundaries around a recoverable destructive repository mutation. */
export interface RepositoryMutationHooks {
  readonly afterPrecondition?: () => Promise<void> | void;
  readonly afterQuarantine?: (quarantineRoot: string) => Promise<void> | void;
}

export interface RepositoryCloneHooks {
  readonly afterFetch?: (destinationRoot: string) => Promise<void> | void;
  readonly afterCheckout?: (destinationRoot: string) => Promise<void> | void;
}

/** Deterministic boundaries used to prove immutable Checkpoint capture. */
export interface RepositoryCheckpointHooks {
  readonly afterReview?: () => Promise<void> | void;
  readonly afterCandidateCaptured?: () => Promise<void> | void;
}

export interface DraftTemplates {
  persona: string;
  memory: string;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fileSha256(file: string): Promise<string> {
  return sha256(await readFile(file));
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function singleLineSummary(summary: string): string {
  const normalized = [...summary]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0)
    throw new RepositoryError("conflict", "A checkpoint summary must not be empty.");
  return normalized.slice(0, 240);
}

function kokoroCheckpointRef(commit: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new RepositoryError("invalid_checkpoint", "The checkpoint identifier is malformed.");
  }
  return `refs/kokoro/checkpoints/${commit}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function assertSafeRoot(root: string): string {
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new RepositoryError("invalid_path", "A filesystem root cannot be used as a Persona repository.");
  }
  return resolved;
}

function resolveInside(root: string, relativePath: string): string {
  if (relativePath.trim() === "" || path.isAbsolute(relativePath)) {
    throw new RepositoryError("invalid_path", "Repository paths must be non-empty and relative.");
  }
  const portable = relativePath.replaceAll("\\", "/");
  const portableSegments =
    portable === "." || portable === "./" ? [] : portable.split("/").filter((segment) => segment !== ".");
  if (portableSegments.some((segment) => !isPortablePathSegment(segment))) {
    throw new RepositoryError(
      "invalid_path",
      "The repository path is not portable or contains a reserved segment.",
    );
  }
  const target = path.resolve(root, relativePath);
  const firstSegment = path.relative(root, target).split(path.sep)[0]?.toLowerCase();
  if (firstSegment === ".git") {
    throw new RepositoryError("invalid_path", "Git metadata is not part of the managed workspace.");
  }
  const prefix = `${root}${path.sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new RepositoryError("invalid_path", "The requested path escapes the Persona repository.");
  }
  return target;
}

function isPortablePathSegment(segment: string): boolean {
  if (
    segment === "" ||
    [...segment].some(isControlCharacter) ||
    /[\\<>:"|?*]/u.test(segment) ||
    /[ .]$/u.test(segment)
  ) {
    return false;
  }
  const basename = segment.split(".")[0]?.toUpperCase() ?? "";
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(basename);
}

function portablePathKey(relativePath: string, code: "invalid_checkpoint" | "invalid_path"): string {
  if (relativePath.includes("\\")) {
    throw new RepositoryError(code, "Persona paths cannot contain a literal backslash.");
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !isPortablePathSegment(segment) || segment.toLowerCase() === ".git")
  ) {
    throw new RepositoryError(code, "The Persona path is not portable.");
  }
  return segments
    .map((segment) => segment.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC"))
    .join("/");
}

function assertPortablePathSet(
  relativePaths: readonly string[],
  code: "invalid_checkpoint" | "invalid_path",
): void {
  const keys = new Set<string>();
  for (const relativePath of relativePaths) {
    const key = portablePathKey(relativePath, code);
    if (keys.has(key)) {
      throw new RepositoryError(code, "Persona paths collide after portable Unicode normalization.");
    }
    keys.add(key);
  }
}

function assertOwnerMarkdownPath(relativePath: string): string {
  if (relativePath.includes("\\")) {
    throw new RepositoryError("invalid_path", "Owner document paths must use forward slashes.");
  }
  const segments = relativePath.split("/");
  if (
    segments.length < 3 ||
    segments[0] !== "workspace" ||
    (segments[1] !== "persona" && segments[1] !== "memory") ||
    !segments.at(-1)?.toLowerCase().endsWith(".md") ||
    segments.some((segment) => !isPortablePathSegment(segment) || segment === "." || segment === "..")
  ) {
    throw new RepositoryError(
      "invalid_path",
      "Owner documents must be Markdown below workspace/persona or workspace/memory.",
    );
  }
  return relativePath;
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

export class PersonaRepository {
  readonly root: string;
  readonly #credentialBoundary: CredentialBoundary;
  #writeGeneration = 0;
  #writesInvalidated = false;
  readonly #writeMutex = new AsyncMutex();

  private constructor(root: string, credentialBoundary: CredentialBoundary) {
    this.root = assertSafeRoot(root);
    this.#credentialBoundary = credentialBoundary;
  }

  static async createDraft(
    root: string,
    templates: DraftTemplates,
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<PersonaRepository> {
    const resolved = assertSafeRoot(root);
    (
      await captureCredentialSnapshot(credentialBoundary, "Persona repository creation boundary")
    ).assertCredentialFree(JSON.stringify({ root: resolved, templates }), "Persona repository draft");
    if (await exists(resolved)) {
      const entries = await readdir(resolved);
      if (entries.length > 0) {
        throw new RepositoryError("path_exists", "The draft destination is not empty.");
      }
    } else {
      await mkdir(resolved, { recursive: true });
    }

    const repository = new PersonaRepository(resolved, credentialBoundary);
    await repository.git(["init", "--initial-branch=main"]);
    await repository.ensureLocalLongPaths();
    await mkdir(path.join(resolved, "workspace", "persona"), { recursive: true });
    await mkdir(path.join(resolved, "workspace", "memory"), { recursive: true });
    (
      await captureCredentialSnapshot(credentialBoundary, "Persona repository creation boundary")
    ).assertCredentialFree(templates.persona, "Persona draft template");
    await writeFile(path.join(resolved, "workspace", "persona", "persona.md"), templates.persona, {
      encoding: "utf8",
      flag: "wx",
    });
    (
      await captureCredentialSnapshot(credentialBoundary, "Persona repository creation boundary")
    ).assertCredentialFree(templates.memory, "Memory draft template");
    await writeFile(path.join(resolved, "workspace", "memory", "initial.md"), templates.memory, {
      encoding: "utf8",
      flag: "wx",
    });
    return repository;
  }

  static async open(
    root: string,
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<PersonaRepository> {
    const repository = await PersonaRepository.inspect(root, credentialBoundary);
    await repository.recoverFileTransactions();
    return repository;
  }

  /** Opens a Repository without reconciling any persisted file transaction. */
  static async inspect(
    root: string,
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<PersonaRepository> {
    (
      await captureCredentialSnapshot(credentialBoundary, "Persona repository open boundary")
    ).assertCredentialFree(path.resolve(root), "Persona repository path");
    const repository = new PersonaRepository(root, credentialBoundary);
    const metadataEntries = (await readdir(repository.root)).filter(
      (entry) => entry.toLowerCase() === ".git",
    );
    if (metadataEntries.length !== 1 || metadataEntries[0] !== ".git") {
      throw new RepositoryError("not_initialized", "Git metadata must use the exact root .git directory.");
    }
    const metadata = await lstat(path.join(repository.root, ".git")).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new RepositoryError("not_initialized", "The selected directory is not a Git repository.");
    }
    await repository.assertGitMetadataFilesystemSafe();
    await repository.assertSafeLocalGitConfig();
    const top = path.resolve((await repository.git(["rev-parse", "--show-toplevel"])).trim());
    if (!(await filesystemDirectoriesEqual(top, repository.root))) {
      throw new RepositoryError("invalid_path", "The selected path is not the Persona repository root.");
    }
    await repository.assertStandaloneGitMetadata();
    return repository;
  }

  static async initializeEmptyClone(
    root: string,
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<PersonaRepository> {
    const resolved = assertSafeRoot(root);
    const rootInfo = await lstat(resolved).catch(() => undefined);
    const entries = rootInfo?.isDirectory() && !rootInfo.isSymbolicLink() ? await readdir(resolved) : [];
    if (
      !rootInfo?.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      (entries.length !== 0 && !(entries.length === 1 && entries[0] === ".git"))
    ) {
      throw new RepositoryError("conflict", "The prepared Clone directory is not empty.");
    }
    const repository = new PersonaRepository(resolved, credentialBoundary);
    if (entries.length === 1) {
      const metadata = await lstat(path.join(resolved, ".git")).catch(() => undefined);
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
        throw new RepositoryError("conflict", "The interrupted Clone Git metadata is not local.");
      }
      await repository.assertGitMetadataFilesystemSafe();
      if (await exists(path.join(resolved, ".git", "config"))) {
        await repository.assertSafeLocalGitConfig();
      }
    }
    await repository.git(["init", "--initial-branch=kokoro-main"]);
    await repository.ensureLocalLongPaths();
    return PersonaRepository.inspect(resolved, credentialBoundary);
  }

  static async recoverPartialCloneCheckout(
    root: string,
    commit: string,
    transactionDirectory: string,
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<PersonaRepository> {
    const resolved = assertSafeRoot(root);
    const transaction = assertSafeRoot(transactionDirectory);
    recoverableOperationPaths(resolved, resolved, "0".repeat(64), transaction);
    const quarantine = path.join(transaction, REPOSITORY_OPERATION_QUARANTINE);
    if (!(await exists(quarantine))) {
      throw new RepositoryError("conflict", "The prepared Clone quarantine is unavailable.");
    }
    const retained = await PersonaRepository.inspect(quarantine, credentialBoundary);
    await retained.ensureLocalLongPaths();
    await retained.assertNoFileTransactions();
    if (
      (await retained.head()) !== null ||
      (await retained.listFiles(".")).length !== 0 ||
      (await retained.git(["remote"])).trim() !== "" ||
      (await exists(path.join(quarantine, ".git", "FETCH_HEAD")))
    ) {
      throw new RepositoryError("conflict", "The prepared Clone quarantine is not an owned empty base.");
    }
    await retained.verifyCheckpointRef(commit);
    await retained.assertCommitMaterializationSafe(commit);
    const reviewed = await retained.stableWorkingTreeSnapshot();
    if (reviewed.dirty) {
      throw new RepositoryError("conflict", "The prepared Clone quarantine changed after preparation.");
    }
    recoverableOperationPaths(resolved, resolved, reviewed.digest, transaction);
    await recoverableRestoreExact(
      resolved,
      resolved,
      commit,
      reviewed.digest,
      transaction,
      {},
      credentialBoundary,
    );
    const recovered = await PersonaRepository.inspect(resolved, credentialBoundary);
    await recovered.assertExactCheckout(commit);
    return recovered;
  }

  async hasCheckpoint(): Promise<boolean> {
    return (await this.head()) !== null;
  }

  async head(): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "--verify", "HEAD"])).trim();
    } catch {
      return null;
    }
  }

  async readPersonaDocuments(): Promise<RepositoryDocument[]> {
    return this.readMarkdownTree("workspace/persona");
  }

  async readMemoryDocuments(): Promise<RepositoryDocument[]> {
    return this.readMarkdownTree("workspace/memory");
  }

  async readOwnerDocuments(relativePath: string | null = null): Promise<RepositoryDocument[]> {
    const credentials = await captureCredentialSnapshot(
      this.#credentialBoundary,
      "Persona repository Owner boundary",
    );
    credentials.assertCredentialFree(relativePath ?? "", "Owner document path");
    if (relativePath !== null) {
      try {
        const document = await this.readText(assertOwnerMarkdownPath(relativePath));
        (
          await captureCredentialSnapshot(this.#credentialBoundary, "Persona repository Owner boundary")
        ).assertCredentialFree(JSON.stringify(document), "Owner document");
        return [document];
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new RepositoryError("not_found", "The Owner document does not exist.", { cause: error });
        }
        throw error;
      }
    }
    const [persona, memory] = await Promise.all([this.readPersonaDocuments(), this.readMemoryDocuments()]);
    const documents = [...persona, ...memory].sort((left, right) => left.path.localeCompare(right.path));
    (
      await captureCredentialSnapshot(this.#credentialBoundary, "Persona repository Owner boundary")
    ).assertCredentialFree(JSON.stringify(documents), "Owner documents");
    return documents;
  }

  async readText(relativePath: string): Promise<RepositoryDocument> {
    const target = resolveInside(this.root, relativePath);
    await assertNoLinkTraversal(this.root, target, false);
    const info = await stat(target);
    if (!info.isFile())
      throw new RepositoryError("invalid_path", "The requested repository path is not a file.");
    const content = await readFile(target, "utf8");
    return {
      path: slash(path.relative(this.root, target)),
      content,
      sha256: sha256(content),
      mtimeMs: info.mtimeMs,
    };
  }

  async writeText(
    relativePath: string,
    content: string,
    expectedSha256: string | null,
  ): Promise<RepositoryDocument> {
    return this.#writeText(relativePath, content, expectedSha256, false);
  }

  async writeOwnerDocument(
    relativePath: string,
    content: string,
    expectedSha256: string | null,
  ): Promise<RepositoryDocument> {
    (
      await captureCredentialSnapshot(this.#credentialBoundary, "Persona repository Owner boundary")
    ).assertCredentialFree(JSON.stringify({ relativePath, content }), "Owner document");
    return this.#writeText(assertOwnerMarkdownPath(relativePath), content, expectedSha256, true);
  }

  async #writeText(
    relativePath: string,
    content: string,
    expectedSha256: string | null,
    ownerWrite: boolean,
  ): Promise<RepositoryDocument> {
    (
      await captureCredentialSnapshot(this.#credentialBoundary, "Persona repository Tool write boundary")
    ).assertCredentialFree(JSON.stringify({ relativePath, content }), "repository write");
    if (expectedSha256 !== null && !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
      throw new RepositoryError("invalid_path", "The expected SHA-256 digest is malformed.");
    }
    return this.#writeMutex.run(async () => {
      if (this.#writesInvalidated) {
        throw new RepositoryError("conflict", "The repository write was fenced by termination.");
      }
      const writeGeneration = this.#writeGeneration;
      const normalized = slash(relativePath);
      if (!ownerWrite && (normalized === "workspace/memory" || normalized.startsWith("workspace/memory/"))) {
        throw new RepositoryError("invalid_path", "Persona tools cannot modify long-term Memory files.");
      }
      const target = resolveInside(this.root, relativePath);
      await assertNoLinkTraversal(this.root, target, true);
      let current: RepositoryDocument | null = null;
      try {
        current = await this.readText(relativePath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      if ((current?.sha256 ?? null) !== expectedSha256) {
        throw new RepositoryError("conflict", "The file changed after it was observed.");
      }
      await mkdir(path.dirname(target), { recursive: true });
      await assertNoLinkTraversal(this.root, path.dirname(target), false);
      await assertRealPathInside(this.root, path.dirname(target));
      const transactionRoot = path.join(this.root, ".git", "kokoro-file-transactions");
      const transactionDirectory = path.join(transactionRoot, randomUUID());
      const replacement = path.join(transactionDirectory, "replacement");
      const backup = path.join(transactionDirectory, "original");
      await mkdir(transactionRoot, { recursive: true });
      await mkdir(transactionDirectory, { recursive: false });
      (
        await captureCredentialSnapshot(
          this.#credentialBoundary,
          "Persona repository file persistence boundary",
        )
      ).assertCredentialFree(JSON.stringify({ relativePath, content }), "repository write");
      await writeFile(replacement, content, { encoding: "utf8", flag: "wx" });
      await writeFile(
        path.join(transactionDirectory, "intent.json"),
        JSON.stringify({
          version: 1,
          path: normalized,
          expectedSha256,
          replacementSha256: sha256(content),
        }),
        { encoding: "utf8", flag: "wx" },
      );
      try {
        (
          await captureCredentialSnapshot(
            this.#credentialBoundary,
            "Persona repository file installation boundary",
          )
        ).assertCredentialFree(JSON.stringify({ relativePath, content }), "repository write");
        if (writeGeneration !== this.#writeGeneration) {
          throw new RepositoryError("conflict", "The repository write was fenced by termination.");
        }
        let latest: RepositoryDocument | null = null;
        try {
          latest = await this.readText(relativePath);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
        if ((latest?.sha256 ?? null) !== expectedSha256) {
          throw new RepositoryError("conflict", "The file changed while the replacement was prepared.");
        }
        await assertNoLinkTraversal(this.root, path.dirname(target), false);
        if (expectedSha256 === null) {
          try {
            await link(replacement, target);
          } catch (error) {
            throw new RepositoryError("conflict", "The file was created concurrently.", { cause: error });
          }
        } else {
          try {
            await rename(target, backup);
          } catch (error) {
            throw new RepositoryError("conflict", "The file changed while replacement began.", {
              cause: error,
            });
          }
          if ((await fileSha256(backup)) !== expectedSha256) {
            if (!(await exists(target))) await rename(backup, target);
            throw new RepositoryError("conflict", "The file changed while replacement began.");
          }
          if (writeGeneration !== this.#writeGeneration) {
            if (!(await exists(target))) await rename(backup, target);
            throw new RepositoryError("conflict", "The repository write was fenced by termination.");
          }
          try {
            await link(replacement, target);
          } catch (error) {
            // A new target is an Owner/concurrent-writer fact and is never overwritten.
            throw new RepositoryError("conflict", "The file was replaced concurrently.", { cause: error });
          }
          const [retainedSha, installedSha] = await Promise.all([fileSha256(backup), fileSha256(target)]);
          if (retainedSha !== expectedSha256) {
            if (installedSha === sha256(content)) await rename(backup, target);
            throw new RepositoryError("conflict", "An Owner edit won the file replacement race.");
          }
          if (installedSha !== sha256(content)) {
            throw new RepositoryError("conflict", "The installed file was edited concurrently.");
          }
        }
        const installed = await this.readText(relativePath);
        if (installed.sha256 !== sha256(content)) {
          throw new RepositoryError("conflict", "A newer Owner edit superseded the Tool write.");
        }
        await rm(transactionDirectory, { recursive: true, force: true });
        return installed;
      } finally {
        // Completed and pre-install failures are safe to remove. A retained original
        // is left durable for open-time reconciliation after an interrupted/racing swap.
        if (!(await exists(backup))) await rm(transactionDirectory, { recursive: true, force: true });
      }
    });
  }

  /** Prevents already-running Tool writes from installing a replacement after Force. */
  invalidateWrites(): void {
    this.#writesInvalidated = true;
    this.#writeGeneration += 1;
  }

  private async recoverFileTransactions(): Promise<void> {
    const root = path.join(this.root, ".git", "kokoro-file-transactions");
    if (!(await exists(root))) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      try {
        const intent = JSON.parse(await readFile(path.join(directory, "intent.json"), "utf8")) as {
          version?: unknown;
          path?: unknown;
          expectedSha256?: unknown;
          replacementSha256?: unknown;
        };
        if (
          intent.version !== 1 ||
          typeof intent.path !== "string" ||
          (intent.expectedSha256 !== null && typeof intent.expectedSha256 !== "string") ||
          typeof intent.replacementSha256 !== "string"
        )
          continue;
        const target = resolveInside(this.root, intent.path);
        const backup = path.join(directory, "original");
        if (await exists(backup)) {
          if (!(await exists(target))) {
            await mkdir(path.dirname(target), { recursive: true });
            await rename(backup, target);
          } else {
            const [backupSha, targetSha] = await Promise.all([fileSha256(backup), fileSha256(target)]);
            if (backupSha !== intent.expectedSha256 && targetSha === intent.replacementSha256) {
              await rename(backup, target);
            }
          }
        }
        await rm(directory, { recursive: true, force: true });
      } catch {
        // Ambiguous evidence is retained under .git for explicit inspection;
        // recovery never guesses which competing Owner version to delete.
      }
    }
  }

  async listFiles(relativeDirectory = "."): Promise<string[]> {
    const base = resolveInside(this.root, relativeDirectory === "." ? "./" : relativeDirectory);
    await assertNoLinkTraversal(this.root, base, false);
    const output: string[] = [];
    await this.walk(base, async (file) => {
      output.push(slash(path.relative(this.root, file)));
    });
    return output.sort((left, right) => left.localeCompare(right));
  }

  async prepareCheckpoint(
    summary: string,
    timestamp = new Date().toISOString(),
    hooks: RepositoryCheckpointHooks = {},
  ): Promise<CheckpointPlan> {
    const message = singleLineSummary(summary);
    const parent = await this.head();
    const reviewed = await this.stableWorkingTreeSnapshot();
    await hooks.afterReview?.();
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "kokoro-git-index-"));
    const indexFile = path.join(temporaryDirectory, "index");
    const indexEnvironment = { GIT_INDEX_FILE: indexFile };
    try {
      await this.git(["read-tree", "--empty"], indexEnvironment);
      const prewriteCredentials = await captureCredentialSnapshot(
        this.#credentialBoundary,
        "Persona Git Checkpoint pre-write boundary",
      );
      prewriteCredentials.assertCredentialFree(message, "Git Checkpoint summary");
      // Credential capture is an external boundary. Revalidate the complete
      // repository metadata once after it returns and before any object is
      // persisted. The per-file loop deliberately does not rescan the growing
      // object database for every hash-object/update-index invocation.
      await this.assertGitWriteBoundary();
      const parentModes = new Map<string, string>();
      if (parent !== null) {
        for (const entry of (await this.git(["ls-tree", "-r", "-z", parent])).split("\0")) {
          if (entry === "") continue;
          const tab = entry.indexOf("\t");
          const [mode] = entry.slice(0, tab).split(" ");
          if (tab >= 0 && mode) parentModes.set(entry.slice(tab + 1), mode);
        }
      }
      const objectFormat = (await this.git(["rev-parse", "--show-object-format"])).trim();
      if (objectFormat !== "sha1" && objectFormat !== "sha256") {
        throw new RepositoryError("conflict", "The Git object format is not supported.");
      }
      const candidateDigest = createHash("sha256");
      candidateDigest.update(parent ?? "unborn");
      const stagedFiles: Array<{
        relativePath: string;
        inspectedSource: string;
        objectId: string;
        mode: "100644" | "100755";
      }> = [];
      const candidatePaths = await this.listFiles(".");
      assertPortablePathSet(candidatePaths, "invalid_path");
      let fileSequence = 0;
      for (const relativePath of candidatePaths) {
        const target = resolveInside(this.root, relativePath);
        const [content, info] = await Promise.all([readFile(target), stat(target)]);
        prewriteCredentials.assertCredentialFree(relativePath, "Git Checkpoint path");
        prewriteCredentials.assertCredentialFree(content.toString("utf8"), "Git Checkpoint content");
        const mode =
          process.platform === "win32"
            ? parentModes.get(relativePath) === "100755"
              ? "100755"
              : "100644"
            : (info.mode & 0o111) !== 0
              ? "100755"
              : "100644";
        const inspectedSource = path.join(temporaryDirectory, `source-${fileSequence}`);
        fileSequence += 1;
        await writeFile(inspectedSource, content, { flag: "wx" });
        const objectId = createHash(objectFormat)
          .update(`blob ${content.byteLength}\0`)
          .update(content)
          .digest("hex");
        candidateDigest.update("\0");
        candidateDigest.update(relativePath);
        candidateDigest.update("\0");
        candidateDigest.update(String(info.mode));
        candidateDigest.update("\0");
        candidateDigest.update(content);
        stagedFiles.push({
          relativePath,
          inspectedSource,
          objectId,
          mode: mode as "100644" | "100755",
        });
      }
      await hooks.afterCandidateCaptured?.();
      if (
        candidateDigest.digest("hex") !== reviewed.digest ||
        (await this.stableWorkingTreeSnapshot()).digest !== reviewed.digest
      ) {
        throw new RepositoryError("conflict", "The working tree changed while its Checkpoint was prepared.");
      }
      const candidateCredentials = await captureCredentialSnapshot(
        this.#credentialBoundary,
        "Persona Git Checkpoint boundary",
      );
      candidateCredentials.assertCredentialFree(message, "Git Checkpoint summary");
      for (const file of stagedFiles) {
        candidateCredentials.assertCredentialFree(file.relativePath, "Git Checkpoint path");
        candidateCredentials.assertCredentialFree(
          (await readFile(file.inspectedSource)).toString("utf8"),
          "Git Checkpoint content",
        );
      }
      await this.assertGitWriteBoundary();
      await this.assertObjectWriteAncestorsSafe(stagedFiles.map((file) => file.objectId));
      const writtenObjectIds =
        stagedFiles.length === 0
          ? []
          : (
              await this.gitWithInput(
                ["hash-object", "-w", "--stdin-paths", "--no-filters"],
                `${stagedFiles.map((file) => slash(file.inspectedSource)).join("\n")}\n`,
              )
            )
              .split(/\r?\n/u)
              .filter((entry) => entry !== "");
      if (
        writtenObjectIds.length !== stagedFiles.length ||
        writtenObjectIds.some((objectId, index) => objectId !== stagedFiles[index]?.objectId)
      ) {
        throw new RepositoryError("conflict", "The immutable Checkpoint objects changed while written.");
      }
      await this.gitWithInput(
        ["update-index", "-z", "--index-info"],
        Buffer.from(
          stagedFiles.map((file) => `${file.mode} ${file.objectId}\t${file.relativePath}\0`).join(""),
          "utf8",
        ),
        indexEnvironment,
      );
      const credentials = await captureCredentialSnapshot(
        this.#credentialBoundary,
        "Persona Git Checkpoint staged boundary",
      );
      credentials.assertCredentialFree(message, "Git Checkpoint summary");
      await this.assertStagedCredentialFree(indexEnvironment, credentials);
      // A final fresh credential scan catches rotations during preparation;
      // the metadata fence prevents tree/ref writes through a replaced Git
      // store after either the file loop or that external capture.
      await this.assertGitWriteBoundary();
      const tree = (await this.git(["write-tree"], indexEnvironment)).trim();
      if ((await this.stableWorkingTreeSnapshot()).digest !== reviewed.digest) {
        throw new RepositoryError("conflict", "The working tree changed while its Checkpoint was prepared.");
      }
      const args = ["commit-tree", tree];
      if (parent !== null) args.push("-p", parent);
      args.push("-m", message);
      const commit = (
        await this.git(args, {
          GIT_AUTHOR_NAME: "Kokoro",
          GIT_AUTHOR_EMAIL: "kokoro@localhost",
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_NAME: "Kokoro",
          GIT_COMMITTER_EMAIL: "kokoro@localhost",
          GIT_COMMITTER_DATE: timestamp,
        })
      ).trim();
      return { version: 1, parent, tree, commit, message, timestamp };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async advanceCheckpoint(plan: CheckpointPlan): Promise<AdvanceCheckpointResult> {
    await this.assertGitWriteBoundary();
    await this.assertPlan(plan);
    const credentials = await captureCredentialSnapshot(
      this.#credentialBoundary,
      "Persona Git Checkpoint anchor boundary",
    );
    credentials.assertCredentialFree(plan.message, "Git Checkpoint summary");
    await this.assertCommitCredentialFree(plan.commit, credentials);
    await this.assertGitWriteBoundary();
    const current = await this.head();
    if (current === plan.commit) {
      // A crash may happen after update-ref but before the ordinary index was
      // realigned. Recovery is idempotent only when it repairs that index too.
      await this.git(["reset", "--mixed", plan.commit]);
      await this.ensureCheckpointRef(plan.commit);
      return { commit: plan.commit, advanced: false };
    }
    if (current !== plan.parent) {
      throw new RepositoryError("conflict", "Repository HEAD changed after the checkpoint was prepared.");
    }
    await this.git(["update-ref", "HEAD", plan.commit, plan.parent ?? ZERO_OBJECT_ID]);
    await this.git(["reset", "--mixed", plan.commit]);
    await this.ensureCheckpointRef(plan.commit);
    return { commit: plan.commit, advanced: true };
  }

  async verifyAnchoredCheckpointPlan(plan: CheckpointPlan): Promise<void> {
    await this.assertPlan(plan);
    await this.verifyCheckpointRef(plan.commit);
    const credentials = await captureCredentialSnapshot(
      this.#credentialBoundary,
      "Persona Git Checkpoint recovery boundary",
    );
    credentials.assertCredentialFree(plan.message, "Git Checkpoint summary");
    await this.assertCommitCredentialFree(plan.commit, credentials);
  }

  async listCheckpoints(limit = 100, before: string | null = null): Promise<CheckpointInfo[]> {
    if (!(await this.hasCheckpoint())) return [];
    const count = Math.max(1, Math.min(10_000, Math.floor(limit)));
    if (before !== null) {
      await this.verifyCheckpoint(before);
      try {
        await this.git(["merge-base", "--is-ancestor", before, "HEAD"]);
      } catch (error) {
        throw new RepositoryError(
          "invalid_checkpoint",
          "The history cursor is not in the current Checkpoint lineage.",
          { cause: error },
        );
      }
    }
    const output = await this.git([
      "log",
      `--max-count=${count}`,
      ...(before === null ? [] : ["--skip=1", before]),
      "--format=%H%x00%P%x00%cI%x00%s%x1e",
    ]);
    return output
      .split("\u001e")
      .map((record) => record.replace(/^\s*\n/u, ""))
      .filter((record) => record !== "")
      .map((record) => record.split("\0"))
      .filter((row) => row.length === 4)
      .map(([commit = "", parents = "", timestamp = "", message = ""]) => ({
        commit,
        parent: parents.split(" ")[0] || null,
        timestamp,
        message,
      }));
  }

  async checkpointInfo(commit: string): Promise<CheckpointInfo> {
    await this.verifyCheckpointRef(commit);
    const [row = "", ...unexpected] = (
      await this.git(["show", "-s", "--format=%H%x00%P%x00%cI%x00%s", commit])
    )
      .trimEnd()
      .split("\n");
    const [actual = "", parents = "", timestamp = "", message = ""] = row.split("\0");
    if (unexpected.length > 0 || actual !== commit || timestamp === "") {
      throw new RepositoryError("invalid_checkpoint", "The Checkpoint metadata is malformed.");
    }
    return { commit: actual, parent: parents.split(" ")[0] || null, timestamp, message };
  }

  async verifyCheckpoint(commit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
      throw new RepositoryError("invalid_checkpoint", "The checkpoint identifier is malformed.");
    }
    try {
      await this.git(["cat-file", "-e", `${commit}^{commit}`]);
    } catch (error) {
      throw new RepositoryError("invalid_checkpoint", "The checkpoint does not exist in this repository.", {
        cause: error,
      });
    }
  }

  async ensureCheckpointRef(commit: string): Promise<void> {
    await this.assertGitWriteBoundary();
    await this.verifyCheckpoint(commit);
    await this.assertCommitMaterializationSafe(commit);
    await this.assertGitWriteBoundary();
    const checkpointRef = kokoroCheckpointRef(commit);
    try {
      await this.git(["update-ref", checkpointRef, commit, ZERO_OBJECT_ID]);
    } catch {
      await this.verifyCheckpointRef(commit);
    }
  }

  async verifyCheckpointRef(commit: string): Promise<void> {
    await this.verifyCheckpoint(commit);
    try {
      const referenced = (
        await this.git(["rev-parse", "--verify", `${kokoroCheckpointRef(commit)}^{commit}`])
      ).trim();
      if (referenced !== commit) {
        throw new RepositoryError(
          "invalid_checkpoint",
          "The durable Kokoro Checkpoint ref does not match its registered commit.",
        );
      }
    } catch (error) {
      if (error instanceof RepositoryError && error.code === "invalid_checkpoint") throw error;
      throw new RepositoryError("invalid_checkpoint", "The durable Kokoro Checkpoint ref is unavailable.", {
        cause: error,
      });
    }
  }

  async createBranch(name: string, commit: string): Promise<void> {
    await this.assertGitWriteBoundary();
    await this.verifyCheckpointRef(commit);
    try {
      await this.git(["check-ref-format", "--branch", name]);
    } catch (error) {
      throw new RepositoryError("invalid_path", "The branch name is invalid.", { cause: error });
    }
    await this.assertGitWriteBoundary();
    try {
      await this.git(["branch", name, commit]);
    } catch (error) {
      const existing = await this.git(["rev-parse", "--verify", `refs/heads/${name}`]).catch(() => null);
      if (existing?.trim() === commit) return;
      throw new RepositoryError("conflict", "The branch already points to a different Checkpoint.", {
        cause: error,
      });
    }
  }

  async cloneAt(
    commit: string,
    destination: string,
    hooks: RepositoryCloneHooks = {},
    transactionDirectory = PersonaRepository.operationTransactionDirectory(destination, randomUUID()),
  ): Promise<PersonaRepository> {
    await this.ensureLocalLongPaths();
    await this.verifyCheckpointRef(commit);
    await this.assertCommitMaterializationSafe(commit);
    const target = assertSafeRoot(destination);
    if (await exists(target))
      throw new RepositoryError("path_exists", "The clone destination already exists.");
    await mkdir(target, { recursive: false });
    // Any failure below intentionally retains the destination as durable
    // conflict evidence; post-validation recursive cleanup cannot be race-free.
    await execFileAsync("git", ["init", "--initial-branch=kokoro-main", "--", target], {
      env: this.gitEnvironment(),
      windowsHide: true,
    });
    const clone = await PersonaRepository.inspect(target, this.#credentialBoundary);
    await clone.ensureLocalLongPaths();
    await clone.git(["remote", "add", "origin", this.root]);
    const checkpointRef = kokoroCheckpointRef(commit);
    await clone.git([
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `+${checkpointRef}:${checkpointRef}`,
    ]);
    await clone.git(["remote", "remove", "origin"]);
    await rm(path.join(target, ".git", "FETCH_HEAD"), { force: true });
    await hooks.afterFetch?.(target);
    await clone.assertGitWriteBoundary();
    const partial = await clone.stableWorkingTreeSnapshot();
    if (partial.dirty || (await clone.listFiles(".")).length !== 0) {
      throw new RepositoryError("conflict", "The Clone changed before its Checkpoint was installed.");
    }
    await clone.restoreWithSnapshot(commit, partial.digest, transactionDirectory);
    await hooks.afterCheckout?.(target);
    await clone.assertExactCheckout(commit);
    return clone;
  }

  async ensureExactCheckout(commit: string, sourceRoot: string, transactionDirectory: string): Promise<void> {
    if (await exists(path.join(transactionDirectory, REPOSITORY_OPERATION_QUARANTINE))) {
      await PersonaRepository.recoverPartialCloneCheckout(
        this.root,
        commit,
        transactionDirectory,
        this.#credentialBoundary,
      );
      return;
    }
    await this.ensureLocalLongPaths();
    await this.assertNoFileTransactions();
    await this.assertStandaloneGitMetadata();
    const expectedSource = assertSafeRoot(sourceRoot);
    const remotes = (await this.git(["remote"]))
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (remotes.some((remote) => remote !== "origin") || remotes.length > 1) {
      throw new RepositoryError("conflict", "The partial Clone contains an unexpected Git remote.");
    }
    if (remotes[0] === "origin") {
      const remoteRoot = path.resolve((await this.git(["remote", "get-url", "origin"])).trim());
      if (!(await filesystemDirectoriesEqual(remoteRoot, expectedSource))) {
        throw new RepositoryError("conflict", "The partial Clone Git remote changed after preparation.");
      }
    }

    if (remotes.length === 0) await this.git(["remote", "add", "origin", expectedSource]);
    const checkpointRef = kokoroCheckpointRef(commit);
    try {
      await this.verifyCheckpointRef(commit);
    } catch {
      const source = await PersonaRepository.inspect(expectedSource, this.#credentialBoundary);
      await source.ensureLocalLongPaths();
      await this.git([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
        `+${checkpointRef}:${checkpointRef}`,
      ]);
    }
    await this.assertGitWriteBoundary();
    await this.verifyCheckpointRef(commit);
    await this.assertCommitMaterializationSafe(commit);
    await this.git(["remote", "remove", "origin"]);
    await rm(path.join(this.root, ".git", "FETCH_HEAD"), { force: true });

    const head = await this.head();
    if (head !== null && head !== commit) {
      throw new RepositoryError("conflict", "The partial Clone HEAD is not the requested Checkpoint.");
    }
    if (head === commit) {
      await this.assertExactCheckout(commit);
      return;
    }

    const partial = await this.stableWorkingTreeSnapshot();
    if (partial.dirty || (await this.listFiles(".")).length !== 0) {
      throw new RepositoryError(
        "conflict",
        "The partial Clone contains Owner content and cannot be completed automatically.",
      );
    }
    await this.restoreWithSnapshot(commit, partial.digest, transactionDirectory);
    await this.assertExactCheckout(commit);
  }

  async assertExactCheckout(commit: string): Promise<void> {
    await this.assertGitWriteBoundary();
    await this.assertNoFileTransactions();
    if (
      (await this.git(["remote"])).trim() !== "" ||
      (await exists(path.join(this.root, ".git", "FETCH_HEAD")))
    ) {
      throw new RepositoryError("conflict", "The Clone retains source Repository metadata.");
    }
    await this.assertWorkingTreeAndIndexExact(commit);
  }

  async restore(commit: string, discardChanges = false): Promise<void> {
    if (!discardChanges) {
      const reviewed = await this.stableWorkingTreeSnapshot();
      if (reviewed.dirty) {
        throw new RepositoryError("dirty_worktree", "The Persona repository contains uncommitted changes.");
      }
      const operationId = randomUUID();
      await this.restoreWithSnapshot(
        commit,
        reviewed.digest,
        PersonaRepository.operationTransactionDirectory(this.root, operationId),
      );
      return;
    }
    await this.assertGitWriteBoundary();
    await this.verifyCheckpointRef(commit);
    await this.assertCommitMaterializationSafe(commit);
    const credentials = await captureCredentialSnapshot(
      this.#credentialBoundary,
      "Persona Git Restore boundary",
    );
    await this.assertCommitCredentialFree(commit, credentials);
    await this.assertGitWriteBoundary();
    await this.materializeCommitWithoutFilters(commit);
    await this.assertWorkingTreeAndIndexExact(commit);
  }

  static operationTransactionDirectory(root: string, operationId: string): string {
    const resolved = assertSafeRoot(root);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(operationId)) {
      throw new RepositoryError("invalid_path", "The Repository operation id is malformed.");
    }
    // Windows cannot enter a directory whose absolute name reaches the
    // legacy 248-character directory boundary, even when Git itself has
    // core.longpaths enabled. Keep the recoverable sibling transaction name
    // fixed and compact so Kokoro's own bookkeeping does not make an
    // otherwise valid Persona path unusable. The Store persists this exact
    // path as the operation authority; the root-bound 72-bit token prevents
    // independent operations from sharing a sibling transaction.
    const operationKey = createHash("sha256")
      .update(resolved)
      .update("\0")
      .update(operationId)
      .digest("base64url")
      .slice(0, 12);
    return path.join(path.dirname(resolved), `.k${operationKey}`);
  }

  async restoreWithSnapshot(
    commit: string,
    expectedWorkingTreeDigest: string,
    transactionDirectory: string,
    hooks: RepositoryMutationHooks = {},
  ): Promise<void> {
    return this.#writeMutex.run(() =>
      recoverableRestoreExact(
        this.root,
        this.root,
        commit,
        expectedWorkingTreeDigest,
        transactionDirectory,
        hooks,
        this.#credentialBoundary,
      ),
    );
  }

  static async recoverRestoreExact(
    root: string,
    expectedRoot: string,
    commit: string,
    expectedWorkingTreeDigest: string,
    transactionDirectory: string,
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<void> {
    await recoverableRestoreExact(
      root,
      expectedRoot,
      commit,
      expectedWorkingTreeDigest,
      transactionDirectory,
      {},
      credentialBoundary,
    );
  }

  async forceRestore(commit: string): Promise<void> {
    // Force invalidates writes before entering here. Serialize the destructive
    // restore behind any repository write that had already crossed into its
    // atomic file transaction, so no link/rename can land after restoration.
    await this.#writeMutex.run(() => this.restore(commit, true));
  }

  async drainWrites(): Promise<void> {
    await this.#writeMutex.run(async () => undefined);
  }

  async isDirty(): Promise<boolean> {
    const head = await this.head();
    if (head === null) return (await this.listFiles(".")).length !== 0;
    return !(await this.matchesExactCommitTree(head));
  }

  async workingTreeDigest(): Promise<string> {
    const digest = createHash("sha256");
    digest.update((await this.head()) ?? "unborn");
    const files = await this.listFiles(".");
    for (const relativePath of files) {
      const target = resolveInside(this.root, relativePath);
      await assertNoLinkTraversal(this.root, target, false);
      const [content, info] = await Promise.all([readFile(target), stat(target)]);
      digest.update("\0");
      digest.update(relativePath);
      digest.update("\0");
      digest.update(String(info.mode));
      digest.update("\0");
      digest.update(content);
    }
    return digest.digest("hex");
  }

  async workingTreeSnapshot(): Promise<{ dirty: boolean; digest: string }> {
    const [dirty, digest] = await Promise.all([this.isDirty(), this.workingTreeDigest()]);
    return { dirty, digest };
  }

  async stableWorkingTreeSnapshot(): Promise<{ dirty: boolean; digest: string }> {
    let previous: { dirty: boolean; digest: string } | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const digest = await this.workingTreeDigest();
      const dirty = await this.isDirty();
      const current = { dirty, digest };
      if (previous && previous.dirty === current.dirty && previous.digest === current.digest) {
        return current;
      }
      previous = current;
    }
    throw new RepositoryError(
      "conflict",
      "The working tree changed continuously while its complete snapshot was captured.",
    );
  }

  static async deleteExact(root: string, expectedRoot: string): Promise<void> {
    const resolved = assertSafeRoot(root);
    const expected = assertSafeRoot(expectedRoot);
    if (resolved !== expected || !(await exists(path.join(resolved, ".git")))) {
      throw new RepositoryError(
        "invalid_path",
        "The delete target is not the exact registered Persona repository.",
      );
    }
    await rm(resolved, { recursive: true, force: false });
  }

  static async deleteExactWithSnapshot(
    root: string,
    expectedRoot: string,
    expectedWorkingTreeDigest: string,
    transactionDirectory: string,
    hooks: RepositoryMutationHooks = {},
    credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
  ): Promise<void> {
    await recoverableDeleteExact(
      root,
      expectedRoot,
      expectedWorkingTreeDigest,
      transactionDirectory,
      hooks,
      credentialBoundary,
    );
  }

  private async matchesExactCommitTree(commit: string): Promise<boolean> {
    const expected = new Map(
      (await this.commitTreeEntries(commit)).map((entry) => [entry.relativePath, entry] as const),
    );
    const actualFiles = await this.listFiles(".");
    if (
      actualFiles.length !== expected.size ||
      actualFiles.some((relativePath) => !expected.has(relativePath))
    ) {
      return false;
    }
    const objectFormat = (await this.git(["rev-parse", "--show-object-format"])).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") return false;
    for (const relativePath of actualFiles) {
      const expectedFile = expected.get(relativePath) as GitTreeEntry;
      const content = await readFile(resolveInside(this.root, relativePath));
      const objectId = createHash(objectFormat)
        .update(`blob ${content.byteLength}\0`)
        .update(content)
        .digest("hex");
      if (objectId !== expectedFile.objectId) return false;
      if (process.platform !== "win32") {
        const executable = ((await stat(resolveInside(this.root, relativePath))).mode & 0o111) !== 0;
        if (executable !== (expectedFile.mode === "100755")) return false;
      }
    }

    const indexed = new Map<string, { mode: string; objectId: string }>();
    for (const entry of (await this.git(["ls-files", "--stage", "-z"])).split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      const [mode, objectId, stage] = entry.slice(0, tab).split(" ");
      const relativePath = entry.slice(tab + 1);
      if (tab < 0 || stage !== "0" || !mode || !objectId || relativePath === "") return false;
      indexed.set(relativePath, { mode, objectId });
    }
    return (
      indexed.size === expected.size &&
      [...expected].every(([relativePath, expectedEntry]) => {
        const indexedEntry = indexed.get(relativePath);
        return indexedEntry?.mode === expectedEntry.mode && indexedEntry.objectId === expectedEntry.objectId;
      })
    );
  }

  private async assertWorkingTreeAndIndexExact(commit: string): Promise<void> {
    await this.assertGitWriteBoundary();
    await this.verifyCheckpointRef(commit);
    await this.assertCommitMaterializationSafe(commit);
    if ((await this.head()) !== commit || !(await this.matchesExactCommitTree(commit))) {
      throw new RepositoryError(
        "conflict",
        "The working tree and index do not exactly match the requested Checkpoint.",
      );
    }
  }

  private async materializeCommitWithoutFilters(commit: string): Promise<void> {
    const entries = await this.commitTreeEntries(commit);
    const blobs = await this.readGitBlobs(entries.map((entry) => entry.objectId));
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (entry.name.toLowerCase() === ".git") {
        throw new RepositoryError("invalid_path", "Git metadata must use the exact root .git directory.");
      }
      await rm(path.join(this.root, entry.name), { recursive: true, force: false });
    }
    for (const entry of entries) {
      const target = resolveInside(this.root, entry.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const content = blobs.get(entry.objectId) as Buffer;
      await writeFile(target, content, {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    }
    // No checkout/reset -u is permitted here: HEAD/index are updated without
    // invoking attributes or filters, while Node writes the reviewed blob bytes.
    await this.git(["update-ref", "--no-deref", "HEAD", commit]);
    await this.git(["read-tree", "--reset", commit]);
  }

  private async readMarkdownTree(relativeRoot: string): Promise<RepositoryDocument[]> {
    const base = resolveInside(this.root, relativeRoot);
    if (!(await exists(base))) return [];
    await assertNoLinkTraversal(this.root, base, false);
    const documents: RepositoryDocument[] = [];
    await this.walk(base, async (file) => {
      if (path.extname(file).toLowerCase() !== ".md") return;
      const info = await stat(file);
      const content = await readFile(file, "utf8");
      documents.push({
        path: slash(path.relative(this.root, file)),
        content,
        sha256: sha256(content),
        mtimeMs: info.mtimeMs,
      });
    });
    return documents.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async walk(directory: string, visit: (file: string) => Promise<void>): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".git") {
        if (path.resolve(directory) === this.root && entry.name === ".git") continue;
        throw new RepositoryError("invalid_path", "Nested Git metadata is not allowed in a Persona tree.");
      }
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new RepositoryError(
          "invalid_path",
          "Symbolic links are not allowed in managed repository reads.",
        );
      }
      if (entry.isDirectory()) await this.walk(target, visit);
      else if (entry.isFile()) await visit(target);
      else throw new RepositoryError("invalid_path", "Only ordinary files are allowed in a Persona tree.");
    }
  }

  private async assertStandaloneGitMetadata(): Promise<void> {
    const metadataRoot = path.join(this.root, ".git");
    const metadata = await lstat(metadataRoot).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new RepositoryError("invalid_path", "Git metadata must be a local directory.");
    }
    const [gitDirectoryOutput, commonDirectoryOutput] = await Promise.all([
      this.git(["rev-parse", "--absolute-git-dir"]),
      this.git(["rev-parse", "--git-common-dir"]),
    ]);
    const gitDirectory = path.resolve(this.root, gitDirectoryOutput.trim());
    const commonDirectory = path.resolve(this.root, commonDirectoryOutput.trim());
    if (
      !(await filesystemDirectoriesEqual(gitDirectory, metadataRoot)) ||
      !(await filesystemDirectoriesEqual(commonDirectory, metadataRoot))
    ) {
      throw new RepositoryError("invalid_path", "The Persona repository must own its Git object store.");
    }
    const coreWorktree = await this.git(["config", "--local", "--get", "core.worktree"]).catch(() => "");
    if (
      coreWorktree.trim() !== "" ||
      (await exists(path.join(metadataRoot, "objects", "info", "alternates"))) ||
      (await exists(path.join(metadataRoot, "info", "attributes"))) ||
      (await exists(path.join(metadataRoot, "info", "grafts")))
    ) {
      throw new RepositoryError("invalid_path", "The Persona repository cannot depend on another worktree.");
    }
  }

  private async assertGitMetadataFilesystemSafe(): Promise<void> {
    const metadataRoot = path.join(this.root, ".git");
    const inspectObjectMetadata = async (target: string): Promise<void> => {
      for (const entry of await readdir(target)) {
        const entryPath = path.join(target, entry);
        const info = await lstat(entryPath);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          throw new RepositoryError("invalid_path", "Git object metadata cannot contain links.");
        }
        if (info.isDirectory()) await inspectObjectMetadata(entryPath);
      }
    };
    const inspectEntry = async (target: string): Promise<void> => {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        throw new RepositoryError("invalid_path", "Git metadata cannot contain links or junctions.");
      }
      if (info.isDirectory()) {
        const relativePath = slash(path.relative(metadataRoot, target));
        if (relativePath === "objects") {
          for (const entry of await readdir(target)) {
            const child = await lstat(path.join(target, entry));
            if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
              throw new RepositoryError("invalid_path", "The Git object store cannot contain links.");
            }
            if (child.isDirectory() && (entry === "pack" || entry === "info")) {
              await inspectObjectMetadata(path.join(target, entry));
            }
          }
          return;
        }
        for (const entry of await readdir(target)) await inspectEntry(path.join(target, entry));
        return;
      }
      const relativePath = slash(path.relative(metadataRoot, target));
      const objectStoreArtifact = relativePath.startsWith("objects/");
      if (!info.isFile() || (info.nlink !== 1 && !objectStoreArtifact)) {
        throw new RepositoryError("invalid_path", "Git metadata must contain independent ordinary files.");
      }
    };
    await inspectEntry(metadataRoot);
  }

  private async assertObjectWriteAncestorsSafe(objectIds: readonly string[]): Promise<void> {
    const objectsRoot = path.join(this.root, ".git", "objects");
    for (const objectId of new Set(objectIds)) {
      if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
        throw new RepositoryError("conflict", "A prepared Git object identifier is malformed.");
      }
      const fanout = path.join(objectsRoot, objectId.slice(0, 2));
      const fanoutInfo = await lstat(fanout).catch(() => undefined);
      if (fanoutInfo && (!fanoutInfo.isDirectory() || fanoutInfo.isSymbolicLink())) {
        throw new RepositoryError("invalid_path", "A Git object fanout can redirect writes.");
      }
      const objectPath = path.join(fanout, objectId.slice(2));
      const objectInfo = await lstat(objectPath).catch(() => undefined);
      if (objectInfo && (!objectInfo.isFile() || objectInfo.isSymbolicLink())) {
        throw new RepositoryError("invalid_path", "A Git object path can redirect writes.");
      }
    }
  }

  private async assertGitWriteBoundary(): Promise<void> {
    await this.assertGitMetadataFilesystemSafe();
    await this.assertSafeLocalGitConfig();
    await this.assertStandaloneGitMetadata();
  }

  /**
   * Git for Windows' local transport starts a separate upload-pack process.
   * Transient `-c`/GIT_CONFIG_COUNT values on the fetch client are not a
   * reliable server-side long-path capability, so every Kokoro-owned object
   * store persists this portability invariant in its local configuration.
   */
  private async ensureLocalLongPaths(): Promise<void> {
    await this.assertGitWriteBoundary();
    await this.git(["config", "--local", "--replace-all", "core.longpaths", "true"]);
    await this.assertGitWriteBoundary();
    const configured = (await this.git(["config", "--local", "--get", "core.longpaths"])).trim();
    if (configured.toLowerCase() !== "true") {
      throw new RepositoryError("conflict", "The Persona Git long-path invariant was not persisted.");
    }
  }

  private async assertSafeLocalGitConfig(): Promise<void> {
    const keys = (await this.git(["config", "--local", "--no-includes", "--name-only", "--list"]))
      .split(/\r?\n/u)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "");
    if (
      keys.some(
        (key) =>
          key === "include.path" ||
          key.startsWith("includeif.") ||
          key.startsWith("filter.") ||
          key === "core.attributesfile" ||
          key === "core.hookspath" ||
          key === "core.fsmonitor" ||
          key === "core.worktree" ||
          key === "core.sshcommand" ||
          key === "extensions.worktreeconfig" ||
          key === "protocol.ext.allow" ||
          /^remote\..+\.uploadpack$/u.test(key),
      )
    ) {
      throw new RepositoryError("invalid_path", "The Persona Git configuration can execute host code.");
    }
  }

  private async assertNoFileTransactions(): Promise<void> {
    const transactionRoot = path.join(this.root, ".git", "kokoro-file-transactions");
    if (!(await exists(transactionRoot))) return;
    if ((await readdir(transactionRoot)).length !== 0) {
      throw new RepositoryError("conflict", "The Clone contains unresolved file transaction metadata.");
    }
  }

  private async assertCommitMaterializationSafe(commit: string): Promise<void> {
    await this.commitTreeEntries(commit);
  }

  private async commitTreeEntries(commit: string): Promise<GitTreeEntry[]> {
    const output: GitTreeEntry[] = [];
    const portablePaths = new Set<string>();
    for (const entry of (await this.git(["ls-tree", "-r", "-z", commit])).split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      const [mode, type, objectId] = entry.slice(0, tab).split(" ");
      const relativePath = entry.slice(tab + 1);
      const portablePath = portablePathKey(relativePath, "invalid_checkpoint");
      if (
        tab < 0 ||
        (mode !== "100644" && mode !== "100755") ||
        type !== "blob" ||
        !/^[0-9a-f]{40,64}$/u.test(objectId ?? "") ||
        portablePaths.has(portablePath)
      ) {
        throw new RepositoryError(
          "invalid_checkpoint",
          "The Checkpoint cannot be materialized without Git filters or special entries.",
        );
      }
      portablePaths.add(portablePath);
      output.push({
        relativePath,
        mode: mode as GitTreeEntry["mode"],
        objectId: objectId as string,
      });
    }
    return output;
  }

  private async assertPlan(plan: CheckpointPlan): Promise<void> {
    if (plan.version !== 1 || plan.message !== singleLineSummary(plan.message)) {
      throw new RepositoryError("conflict", "The checkpoint plan is invalid.");
    }
    await this.verifyCheckpoint(plan.commit);
    await this.assertCommitMaterializationSafe(plan.commit);
    const tree = (await this.git(["show", "-s", "--format=%T", plan.commit])).trim();
    const parents = (await this.git(["show", "-s", "--format=%P", plan.commit])).trim();
    const message = (await this.git(["show", "-s", "--format=%s", plan.commit])).trim();
    if (tree !== plan.tree || (parents.split(" ")[0] || null) !== plan.parent || message !== plan.message) {
      throw new RepositoryError("conflict", "The checkpoint plan does not match its Git commit object.");
    }
  }

  private gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    return {
      PATH: hostEnvironmentValue("PATH"),
      ...(process.platform === "win32"
        ? {
            SystemRoot: hostEnvironmentValue("SystemRoot"),
            WINDIR: hostEnvironmentValue("WINDIR"),
            ComSpec: hostEnvironmentValue("ComSpec"),
            PATHEXT: hostEnvironmentValue("PATHEXT"),
          }
        : {}),
      TEMP: hostEnvironmentValue("TEMP"),
      TMP: hostEnvironmentValue("TMP"),
      TMPDIR: hostEnvironmentValue("TMPDIR"),
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_COUNT: "7",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.safecrlf",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "core.eol",
      GIT_CONFIG_VALUE_2: "lf",
      GIT_CONFIG_KEY_3: "core.fsmonitor",
      GIT_CONFIG_VALUE_3: "false",
      GIT_CONFIG_KEY_4: "core.hooksPath",
      GIT_CONFIG_VALUE_4: nullDevice,
      GIT_CONFIG_KEY_5: "core.attributesFile",
      GIT_CONFIG_VALUE_5: nullDevice,
      GIT_CONFIG_KEY_6: "core.longpaths",
      GIT_CONFIG_VALUE_6: "true",
      ...extra,
    };
  }

  private async assertStagedCredentialFree(
    indexEnvironment: NodeJS.ProcessEnv,
    credentials: CredentialSnapshot,
  ): Promise<void> {
    const listing = await this.git(["ls-files", "--stage", "-z"], indexEnvironment);
    const objects: string[] = [];
    for (const entry of listing.split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      const header = tab < 0 ? "" : entry.slice(0, tab);
      const repositoryPath = tab < 0 ? "" : entry.slice(tab + 1);
      const [mode, objectId, stage] = header.split(" ");
      if (
        !/^[0-7]{6}$/u.test(mode ?? "") ||
        !/^[0-9a-f]{40,64}$/u.test(objectId ?? "") ||
        stage !== "0" ||
        repositoryPath === ""
      ) {
        throw new RepositoryError("conflict", "The staged Git tree could not be inspected safely.");
      }
      credentials.assertCredentialFree(repositoryPath, "Git Checkpoint path");
      if (mode === "160000") continue;
      objects.push(objectId as string);
    }
    const blobs = await this.readGitBlobs(objects, indexEnvironment);
    for (const objectId of objects) {
      credentials.assertCredentialFree(
        (blobs.get(objectId) as Buffer).toString("utf8"),
        "Git Checkpoint content",
      );
    }
  }

  private async assertCommitCredentialFree(commit: string, credentials: CredentialSnapshot): Promise<void> {
    const listing = await this.git(["ls-tree", "-r", "-z", commit]);
    const objects: string[] = [];
    for (const entry of listing.split("\0")) {
      if (entry === "") continue;
      const tab = entry.indexOf("\t");
      const header = tab < 0 ? "" : entry.slice(0, tab);
      const repositoryPath = tab < 0 ? "" : entry.slice(tab + 1);
      const [mode, type, objectId] = header.split(" ");
      if (
        !/^[0-7]{6}$/u.test(mode ?? "") ||
        (type !== "blob" && !(mode === "160000" && type === "commit")) ||
        !/^[0-9a-f]{40,64}$/u.test(objectId ?? "") ||
        repositoryPath === ""
      ) {
        throw new RepositoryError("conflict", "The Git Checkpoint tree could not be inspected safely.");
      }
      credentials.assertCredentialFree(repositoryPath, "Git Checkpoint path");
      if (type !== "blob") continue;
      objects.push(objectId as string);
    }
    const blobs = await this.readGitBlobs(objects);
    for (const objectId of objects) {
      credentials.assertCredentialFree(
        (blobs.get(objectId) as Buffer).toString("utf8"),
        "Git Checkpoint content",
      );
    }
  }

  private async readGitBlobs(
    objectIds: readonly string[],
    extraEnvironment: NodeJS.ProcessEnv = {},
  ): Promise<Map<string, Buffer>> {
    const unique = [...new Set(objectIds)];
    if (unique.length === 0) return new Map();
    const output = await this.runGit(["cat-file", "--batch"], `${unique.join("\n")}\n`, extraEnvironment);
    const blobs = new Map<string, Buffer>();
    let offset = 0;
    for (const expectedObjectId of unique) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd < 0) {
        throw new RepositoryError("conflict", "The Git blob batch response is incomplete.");
      }
      const [objectId, type, sizeText] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
      const size = Number(sizeText);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      if (
        objectId !== expectedObjectId ||
        type !== "blob" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        contentEnd >= output.length ||
        output[contentEnd] !== 0x0a
      ) {
        throw new RepositoryError("conflict", "The Git blob batch response is malformed.");
      }
      blobs.set(objectId, output.subarray(contentStart, contentEnd));
      offset = contentEnd + 1;
    }
    if (offset !== output.length) {
      throw new RepositoryError("conflict", "The Git blob batch response contains unexpected data.");
    }
    return blobs;
  }

  private async git(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<string> {
    return (await this.runGit(args, undefined, extraEnvironment)).toString("utf8");
  }

  private async gitWithInput(
    args: string[],
    input: string | Buffer,
    extraEnvironment: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    return (await this.runGit(args, input, extraEnvironment)).toString("utf8");
  }

  private async runGit(
    args: string[],
    input: string | Buffer | undefined,
    extraEnvironment: NodeJS.ProcessEnv,
  ): Promise<Buffer> {
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        // Node must enter `cwd` before Git can apply core.longpaths. On
        // Windows that pre-spawn chdir fails for an otherwise valid long
        // Repository path, so start from the short volume root and let Git's
        // own long-path-aware `-C` handling select the exact Repository.
        const child = spawn("git", ["-C", this.root, ...args], {
          cwd: path.parse(this.root).root,
          env: this.gitEnvironment(extraEnvironment),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const output: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
        // Drain diagnostics so Git cannot block, but never surface paths or
        // subprocess-controlled text through the public error boundary.
        child.stderr.resume();
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (code === 0) resolve(Buffer.concat(output));
          else reject(new Error(`Git exited with code ${String(code)} and signal ${String(signal)}.`));
        });
        child.stdin.on("error", reject);
        child.stdin.end(input);
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError("conflict", `Git operation failed: git ${args[0] ?? ""}`, { cause: error });
    }
  }
}

async function recoverableRestoreExact(
  root: string,
  expectedRoot: string,
  commit: string,
  expectedWorkingTreeDigest: string,
  transactionDirectory: string,
  hooks: RepositoryMutationHooks = {},
  credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
): Promise<void> {
  const paths = recoverableOperationPaths(
    root,
    expectedRoot,
    expectedWorkingTreeDigest,
    transactionDirectory,
  );
  const rootExists = await exists(paths.root);
  const quarantineExists = await exists(paths.quarantine);
  if (!rootExists && !quarantineExists) {
    throw new RepositoryError("conflict", "Neither the registered Repository nor its quarantine exists.");
  }
  if (!quarantineExists) {
    const source = await requireExpectedSnapshot(paths.root, expectedWorkingTreeDigest, credentialBoundary);
    await source.ensureCheckpointRef(commit);
    await hooks.afterPrecondition?.();
    await mkdir(paths.transaction, { recursive: true });
  }

  let candidateDigest: string;
  if (!(await exists(paths.candidate))) {
    const candidateSource = (await exists(paths.quarantine)) ? paths.quarantine : paths.root;
    await cp(candidateSource, paths.candidate, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    const candidate = await PersonaRepository.open(paths.candidate, credentialBoundary);
    await candidate.restore(commit, true);
    const candidateSnapshot = await candidate.stableWorkingTreeSnapshot();
    if (candidateSnapshot.dirty || (await candidate.head()) !== commit) {
      throw new RepositoryError("conflict", "The recoverable Restore candidate is not exact.");
    }
    candidateDigest = candidateSnapshot.digest;
  } else {
    const candidate = await PersonaRepository.open(paths.candidate, credentialBoundary);
    const candidateSnapshot = await candidate.stableWorkingTreeSnapshot();
    if (candidateSnapshot.dirty || (await candidate.head()) !== commit) {
      throw new RepositoryError("conflict", "The recoverable Restore candidate is not exact.");
    }
    candidateDigest = candidateSnapshot.digest;
  }

  if (!(await exists(paths.quarantine))) {
    try {
      await rename(paths.root, paths.quarantine);
    } catch (error) {
      throw new RepositoryError("conflict", "The Repository changed while quarantine began.", {
        cause: error,
      });
    }
  }
  try {
    await requireExpectedSnapshot(paths.quarantine, expectedWorkingTreeDigest, credentialBoundary);
  } catch (error) {
    await restoreQuarantineWhenUncontested(paths.root, paths.quarantine);
    throw error;
  }
  await hooks.afterQuarantine?.(paths.quarantine);
  try {
    await requireExpectedSnapshot(paths.quarantine, expectedWorkingTreeDigest, credentialBoundary);
  } catch (error) {
    await restoreQuarantineWhenUncontested(paths.root, paths.quarantine);
    throw error;
  }

  if (await exists(paths.root)) {
    try {
      const alreadyInstalled = await PersonaRepository.open(paths.root, credentialBoundary);
      const alreadyInstalledSnapshot = await alreadyInstalled.stableWorkingTreeSnapshot();
      if (
        !alreadyInstalledSnapshot.dirty &&
        alreadyInstalledSnapshot.digest === candidateDigest &&
        (await alreadyInstalled.head()) === commit
      ) {
        await requireExpectedSnapshot(paths.quarantine, expectedWorkingTreeDigest, credentialBoundary);
        await rm(paths.candidate, { recursive: true, force: false });
        return;
      }
    } catch {
      // A partial installation is resumed below without overwriting any path.
    }
  }

  if (!(await exists(paths.root))) {
    try {
      await mkdir(paths.root, { recursive: false });
    } catch (error) {
      throw new RepositoryError("conflict", "The Repository path was recreated during Restore.", {
        cause: error,
      });
    }
  }
  await installTreeWithoutOverwrite(paths.candidate, paths.root);
  const installed = await PersonaRepository.open(paths.root, credentialBoundary);
  const installedSnapshot = await installed.stableWorkingTreeSnapshot();
  if (
    installedSnapshot.dirty ||
    installedSnapshot.digest !== candidateDigest ||
    (await installed.head()) !== commit
  ) {
    throw new RepositoryError(
      "conflict",
      "The restored Repository received a concurrent edit and was retained for Owner review.",
    );
  }
  await requireExpectedSnapshot(paths.quarantine, expectedWorkingTreeDigest, credentialBoundary);
  await rm(paths.candidate, { recursive: true, force: false });
}

async function recoverableDeleteExact(
  root: string,
  expectedRoot: string,
  expectedWorkingTreeDigest: string,
  transactionDirectory: string,
  hooks: RepositoryMutationHooks = {},
  credentialBoundary: CredentialBoundary = DEFAULT_CREDENTIAL_BOUNDARY,
): Promise<void> {
  const paths = recoverableOperationPaths(
    root,
    expectedRoot,
    expectedWorkingTreeDigest,
    transactionDirectory,
  );
  const rootExists = await exists(paths.root);
  const quarantineExists = await exists(paths.quarantine);
  if (rootExists && quarantineExists) {
    throw new RepositoryError("conflict", "Both the registered Repository and its Delete quarantine exist.");
  }
  if (!rootExists && !quarantineExists) {
    throw new RepositoryError("conflict", "The registered Repository disappeared before Delete.");
  }
  if (!quarantineExists) {
    await requireExpectedSnapshot(paths.root, expectedWorkingTreeDigest, credentialBoundary);
    await hooks.afterPrecondition?.();
    await mkdir(paths.transaction, { recursive: true });
    try {
      await rename(paths.root, paths.quarantine);
    } catch (error) {
      throw new RepositoryError("conflict", "The Repository changed while Delete quarantine began.", {
        cause: error,
      });
    }
  }
  try {
    await requireExpectedSnapshot(paths.quarantine, expectedWorkingTreeDigest, credentialBoundary);
    await hooks.afterQuarantine?.(paths.quarantine);
    await requireExpectedSnapshot(paths.quarantine, expectedWorkingTreeDigest, credentialBoundary);
  } catch (error) {
    await restoreQuarantineWhenUncontested(paths.root, paths.quarantine);
    throw error;
  }
  if (await exists(paths.root)) {
    throw new RepositoryError(
      "conflict",
      "The Repository path was recreated during Delete and both copies were retained.",
    );
  }
}

function recoverableOperationPaths(
  root: string,
  expectedRoot: string,
  expectedWorkingTreeDigest: string,
  transactionDirectory: string,
): { root: string; transaction: string; quarantine: string; candidate: string } {
  const resolved = assertSafeRoot(root);
  const expected = assertSafeRoot(expectedRoot);
  if (resolved !== expected) {
    throw new RepositoryError(
      "invalid_path",
      "The mutation target is not the exact registered Persona repository.",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(expectedWorkingTreeDigest)) {
    throw new RepositoryError("invalid_path", "The reviewed working-tree digest is malformed.");
  }
  const transaction = assertSafeRoot(transactionDirectory);
  const transactionName = path.basename(transaction);
  if (
    path.dirname(transaction) !== path.dirname(resolved) ||
    !/^\.k[A-Za-z0-9_-]{12}$/u.test(transactionName)
  ) {
    throw new RepositoryError("invalid_path", "The Repository transaction path is not exact.");
  }
  return {
    root: resolved,
    transaction,
    quarantine: path.join(transaction, REPOSITORY_OPERATION_QUARANTINE),
    candidate: path.join(transaction, REPOSITORY_OPERATION_CANDIDATE),
  };
}

async function requireExpectedSnapshot(
  root: string,
  expectedWorkingTreeDigest: string,
  credentialBoundary: CredentialBoundary,
): Promise<PersonaRepository> {
  const repository = await PersonaRepository.open(root, credentialBoundary);
  const snapshot = await repository.stableWorkingTreeSnapshot();
  if (snapshot.dirty || snapshot.digest !== expectedWorkingTreeDigest) {
    throw new RepositoryError("dirty_worktree", "The complete working tree changed after it was reviewed.");
  }
  return repository;
}

async function restoreQuarantineWhenUncontested(root: string, quarantine: string): Promise<void> {
  if (!(await exists(quarantine)) || (await exists(root))) return;
  try {
    await rename(quarantine, root);
  } catch {
    // Ambiguous filesystem facts remain in the exact transaction directory.
  }
}

async function installTreeWithoutOverwrite(sourceRoot: string, destinationRoot: string): Promise<void> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new RepositoryError("invalid_path", "Symbolic links cannot be installed during Restore.");
    }
    if (entry.isDirectory()) {
      try {
        await mkdir(destination, { recursive: false });
      } catch (error) {
        const current = await lstat(destination).catch(() => undefined);
        if (!current?.isDirectory() || current.isSymbolicLink()) {
          throw new RepositoryError("conflict", "A Restore directory was recreated concurrently.", {
            cause: error,
          });
        }
      }
      await installTreeWithoutOverwrite(source, destination);
      continue;
    }
    if (!entry.isFile()) {
      throw new RepositoryError("invalid_path", "Only ordinary files can be installed during Restore.");
    }
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      const [sourceInfo, destinationInfo] = await Promise.all([
        stat(source),
        stat(destination).catch(() => undefined),
      ]);
      if (
        !destinationInfo?.isFile() ||
        (sourceInfo.mode & 0o777) !== (destinationInfo.mode & 0o777) ||
        (await fileSha256(source)) !== (await fileSha256(destination))
      ) {
        throw new RepositoryError("conflict", "A Restore file was recreated concurrently.", {
          cause: error,
        });
      }
    }
  }
}

async function assertNoLinkTraversal(root: string, target: string, allowMissing: boolean): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new RepositoryError("invalid_path", "Symbolic links and directory junctions are not allowed.");
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (allowMissing && isMissingPathError(error)) return;
      throw new RepositoryError("invalid_path", "The requested repository path does not exist.", {
        cause: error,
      });
    }
  }
}

async function assertRealPathInside(root: string, target: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const prefix = `${realRoot}${path.sep}`;
  if (realTarget !== realRoot && !realTarget.startsWith(prefix)) {
    throw new RepositoryError("invalid_path", "The requested path resolves outside the Persona repository.");
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return "cause" in error && isMissingPathError(error.cause);
}

function hostEnvironmentValue(name: string): string | undefined {
  return process.env[name];
}

export async function copyFilePreservingTimes(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const sourceHandle = await open(source, "r");
  const destinationHandle = await open(destination, "r+");
  try {
    const info = await sourceHandle.stat();
    await destinationHandle.utimes(info.atime, info.mtime);
  } finally {
    await sourceHandle.close();
    await destinationHandle.close();
  }
}
