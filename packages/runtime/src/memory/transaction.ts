import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../model.js";
import { isJsonObject, parseStrictJsonObject, StructuredOutputError } from "../model.js";
import {
  copyFilePreservingTimes,
  type PersonaRepository,
  type RepositoryDocument,
} from "../repository/index.js";
import { assertCredentialFree } from "../security.js";
import type { RuntimeFactStore } from "../store/index.js";

export type MemoryOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "replace"; path: string; content: string }
  | { kind: "move"; from: string; path: string }
  | { kind: "delete"; path: string };

export interface MemoryProposal {
  operations: MemoryOperation[];
}

export interface MemoryManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export type MemoryManifest = MemoryManifestEntry[];

export interface MemoryReview {
  documents: RepositoryDocument[];
  manifest: MemoryManifest;
}

export type MemoryTransactionFaultPoint = "after_record" | "after_original_moved" | "after_replacement_moved";

export interface MemoryTransactionOptions {
  fault?: (point: MemoryTransactionFaultPoint) => Promise<void> | void;
  now?: () => number;
}

export class MemoryProposalError extends Error {
  readonly code: "invalid_schema" | "invalid_path" | "conflict" | "credentials";

  constructor(code: MemoryProposalError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryProposalError";
    this.code = code;
  }
}

export class MemoryTransactionRecoveryRequiredError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string, options?: ErrorOptions) {
    super("A recorded Memory transaction must be reconciled before new Memory work can start.", options);
    this.name = "MemoryTransactionRecoveryRequiredError";
    this.transactionId = transactionId;
  }
}

export function parseMemoryProposal(text: string): MemoryProposal {
  let value: Record<string, JsonValue>;
  try {
    value = parseStrictJsonObject(text);
  } catch (error) {
    throw new MemoryProposalError("invalid_schema", "The Hippocampus response must be one JSON object.", {
      cause: error,
    });
  }
  assertExactKeys(value, ["operations"]);
  const operations = value["operations"];
  if (!Array.isArray(operations)) {
    throw new MemoryProposalError("invalid_schema", "operations must be an array.");
  }
  return { operations: operations.map(parseOperation) };
}

export class MemoryTransactionManager {
  readonly #store: RuntimeFactStore;
  readonly #fault?: MemoryTransactionOptions["fault"];
  readonly #now: () => number;

  constructor(store: RuntimeFactStore, options: MemoryTransactionOptions = {}) {
    this.#store = store;
    this.#fault = options.fault;
    this.#now = options.now ?? Date.now;
  }

  async review(repository: PersonaRepository): Promise<MemoryReview> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await manifest(memoryDirectory(repository));
      const documents = await repository.readMemoryDocuments();
      const after = await manifest(memoryDirectory(repository));
      if (sameManifest(before, after)) return { documents, manifest: after };
    }
    throw new MemoryProposalError("conflict", "Memory changed while it was being reviewed.");
  }

  async apply(
    jobId: string,
    repository: PersonaRepository,
    proposal: MemoryProposal,
    expectedBefore: MemoryManifest,
    assertFence: () => void = () => undefined,
  ): Promise<MemoryManifest> {
    const id = randomUUID();
    const memoryRoot = memoryDirectory(repository);
    const transactionDirectory = path.join(repository.root, ".git", "kokoro-memory-transactions", id);
    const stage = path.join(transactionDirectory, "stage");
    const backup = path.join(transactionDirectory, "backup");
    await mkdir(path.dirname(transactionDirectory), { recursive: true });
    await mkdir(transactionDirectory, { recursive: false });
    let recorded = false;
    try {
      assertFence();
      const before = await manifest(memoryRoot);
      if (!sameManifest(before, expectedBefore)) {
        throw new MemoryProposalError("conflict", "Memory changed after the proposal was reviewed.");
      }
      await copyTree(memoryRoot, stage);
      if (!sameManifestContent(await manifest(stage), before)) {
        throw new MemoryProposalError("conflict", "Memory changed while its transaction was being staged.");
      }
      await applyOperations(stage, proposal.operations);
      const after = await manifest(stage);
      this.#store.saveMemoryTransaction({
        id,
        jobId,
        phase: "prepared",
        directory: transactionDirectory,
        beforeManifest: manifestJson(before),
        afterManifest: manifestJson(after),
        now: this.#now(),
      });
      recorded = true;
      await this.#fault?.("after_record");

      assertFence();
      if (!sameManifest(await manifest(memoryRoot), before)) {
        this.#store.updateMemoryTransaction(id, "conflict", this.#now());
        await rm(transactionDirectory, { recursive: true, force: true });
        throw new MemoryProposalError("conflict", "Memory changed after the proposal was reviewed.");
      }
      await rename(memoryRoot, backup);
      assertFence();
      this.#store.updateMemoryTransaction(id, "original_moved");
      await this.#fault?.("after_original_moved");
      if (!sameManifest(await manifest(backup), before)) {
        await rename(backup, memoryRoot);
        this.#store.updateMemoryTransaction(id, "conflict", this.#now());
        await rm(transactionDirectory, { recursive: true, force: true });
        throw new MemoryProposalError(
          "conflict",
          "Memory was edited while the prepared tree was being installed.",
        );
      }
      await rename(stage, memoryRoot);
      assertFence();
      this.#store.updateMemoryTransaction(id, "replacement_moved");
      await this.#fault?.("after_replacement_moved");
      const installed = await manifest(memoryRoot);
      const retainedOriginal = await manifest(backup);
      if (!sameManifest(retainedOriginal, before) && sameManifest(installed, after)) {
        const rejected = path.join(transactionDirectory, "rejected");
        await rename(memoryRoot, rejected);
        await rename(backup, memoryRoot);
        this.#store.updateMemoryTransaction(id, "conflict", this.#now());
        await rm(transactionDirectory, { recursive: true, force: true });
        throw new MemoryProposalError(
          "conflict",
          "Memory was edited while the prepared tree was being installed.",
        );
      }
      if (!sameManifest(installed, after)) {
        if (sameManifest(retainedOriginal, before)) {
          // The atomic replacement occurred; a subsequent Owner edit is newer and remains authoritative.
          this.#store.updateMemoryTransaction(id, "completed", this.#now());
          await rm(transactionDirectory, { recursive: true, force: true });
          return installed;
        }
        this.#store.updateMemoryTransaction(id, "conflict", this.#now());
        throw new MemoryProposalError(
          "conflict",
          "Both retained and installed Memory trees changed during the transaction.",
        );
      }
      this.#store.updateMemoryTransaction(id, "completed", this.#now());
      await rm(transactionDirectory, { recursive: true, force: true });
      return after;
    } catch (error) {
      if (!recorded) await rm(transactionDirectory, { recursive: true, force: true });
      if (error instanceof MemoryProposalError && error.code === "conflict") throw error;
      if (recorded) throw new MemoryTransactionRecoveryRequiredError(id, { cause: error });
      throw error;
    }
  }

  async recoverAll(
    openRepository: (personaId: string) => Promise<PersonaRepository>,
    personaIds?: ReadonlySet<string>,
  ): Promise<void> {
    for (const transaction of this.#store.memoryTransactions()) {
      const job = this.#store.requireHippocampusJob(transaction.jobId);
      if (personaIds && !personaIds.has(job.personaId)) continue;
      const repository = await openRepository(job.personaId);
      await this.#recoverOne(transaction, repository);
    }
  }

  async #recoverOne(
    transaction: ReturnType<RuntimeFactStore["memoryTransactions"]>[number],
    repository: PersonaRepository,
  ): Promise<void> {
    const memoryRoot = memoryDirectory(repository);
    const stage = path.join(transaction.directory, "stage");
    const backup = path.join(transaction.directory, "backup");
    const before = parseManifest(transaction.beforeManifest);
    const after = parseManifest(transaction.afterManifest);
    const current = (await exists(memoryRoot)) ? await manifest(memoryRoot) : null;

    if (current && sameManifest(current, after)) {
      if ((await exists(backup)) && !sameManifest(await manifest(backup), before)) {
        const rejected = path.join(transaction.directory, "rejected");
        await rename(memoryRoot, rejected);
        await rename(backup, memoryRoot);
        await this.#markConflict(transaction.id, transaction.jobId, "memory_owner_edit_during_swap");
        await rm(transaction.directory, { recursive: true, force: true });
        return;
      }
      await this.#finishRecovered(transaction.id, transaction.directory, transaction.jobId);
      return;
    }
    if (current && transaction.phase === "replacement_moved" && (await exists(backup))) {
      if (sameManifest(await manifest(backup), before)) {
        // Replacement was durably recorded; a changed current tree is a later Owner edit.
        await this.#finishRecovered(transaction.id, transaction.directory, transaction.jobId);
        return;
      }
      await this.#markConflict(transaction.id, transaction.jobId, "memory_both_trees_changed");
      return;
    }
    if (current && sameManifest(current, before) && (await exists(stage))) {
      if (!sameManifest(await manifest(stage), after)) {
        await this.#markConflict(transaction.id, transaction.jobId, "memory_stage_mismatch");
        return;
      }
      if (await exists(backup)) {
        await this.#markConflict(transaction.id, transaction.jobId, "memory_backup_already_exists");
        return;
      }
      await rename(memoryRoot, backup);
      this.#store.updateMemoryTransaction(transaction.id, "original_moved");
      await rename(stage, memoryRoot);
      this.#store.updateMemoryTransaction(transaction.id, "replacement_moved");
      await this.#finishRecovered(transaction.id, transaction.directory, transaction.jobId);
      return;
    }
    if (!current && (await exists(backup)) && (await exists(stage))) {
      const backupManifest = await manifest(backup);
      const stageManifest = await manifest(stage);
      if (sameManifest(backupManifest, before) && sameManifest(stageManifest, after)) {
        await rename(stage, memoryRoot);
        this.#store.updateMemoryTransaction(transaction.id, "replacement_moved");
        await this.#finishRecovered(transaction.id, transaction.directory, transaction.jobId);
        return;
      }
      if (!sameManifest(backupManifest, before)) {
        await rename(backup, memoryRoot);
        await this.#markConflict(transaction.id, transaction.jobId, "memory_owner_edit_during_swap");
        await rm(transaction.directory, { recursive: true, force: true });
        return;
      }
    }
    if (!current && (await exists(backup)) && !(await exists(stage))) {
      if (sameManifest(await manifest(backup), before)) await rename(backup, memoryRoot);
    }
    await this.#markConflict(transaction.id, transaction.jobId, "memory_recovery_conflict");
  }

  async #finishRecovered(id: string, directory: string, jobId: string): Promise<void> {
    this.#store.updateMemoryTransaction(id, "completed", this.#now());
    this.#store.updateHippocampusJob(jobId, { status: "completed", error: null }, this.#now());
    await rm(directory, { recursive: true, force: true });
  }

  async #markConflict(id: string, jobId: string, code: string): Promise<void> {
    this.#store.updateMemoryTransaction(id, "conflict", this.#now());
    this.#store.updateHippocampusJob(jobId, { status: "conflict", error: { code } }, this.#now());
  }
}

function parseOperation(value: JsonValue, index: number): MemoryOperation {
  if (!isJsonObject(value)) {
    throw new MemoryProposalError("invalid_schema", `operations[${index}] must be an object.`);
  }
  const kind = value["kind"];
  if (kind === "create" || kind === "replace") {
    assertExactKeys(value, ["kind", "path", "content"]);
    const operationPath = requireJsonString(value["path"], `operations[${index}].path`);
    const content = requireJsonString(value["content"], `operations[${index}].content`, true);
    if (kind === "create") assertCreatePath(operationPath);
    else assertMemoryPath(operationPath);
    try {
      assertCredentialFree(content, `Hippocampus operation ${index}`);
    } catch (error) {
      throw new MemoryProposalError("credentials", "A Memory proposal contains credential-like material.", {
        cause: error,
      });
    }
    return { kind, path: normalizeMemoryPath(operationPath), content };
  }
  if (kind === "move") {
    assertExactKeys(value, ["kind", "from", "path"]);
    const from = requireJsonString(value["from"], `operations[${index}].from`);
    const operationPath = requireJsonString(value["path"], `operations[${index}].path`);
    assertMemoryPath(from);
    assertMemoryPath(operationPath);
    return { kind, from: normalizeMemoryPath(from), path: normalizeMemoryPath(operationPath) };
  }
  if (kind === "delete") {
    assertExactKeys(value, ["kind", "path"]);
    const operationPath = requireJsonString(value["path"], `operations[${index}].path`);
    assertMemoryPath(operationPath);
    return { kind, path: normalizeMemoryPath(operationPath) };
  }
  throw new MemoryProposalError("invalid_schema", `operations[${index}].kind is not supported.`);
}

async function applyOperations(stage: string, operations: readonly MemoryOperation[]): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "create") {
      const target = stagePath(stage, operation.path);
      if (await exists(target))
        throw new MemoryProposalError("conflict", `Memory path already exists: ${operation.path}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, operation.content, { encoding: "utf8", flag: "wx" });
      continue;
    }
    if (operation.kind === "replace") {
      const target = stagePath(stage, operation.path);
      await requireRegularFile(target, operation.path);
      await writeFile(target, operation.content, { encoding: "utf8", flag: "w" });
      continue;
    }
    if (operation.kind === "move") {
      const source = stagePath(stage, operation.from);
      const target = stagePath(stage, operation.path);
      await requireRegularFile(source, operation.from);
      if (await exists(target))
        throw new MemoryProposalError("conflict", `Memory path already exists: ${operation.path}`);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
      continue;
    }
    const target = stagePath(stage, operation.path);
    await requireRegularFile(target, operation.path);
    await rm(target, { force: false });
  }
}

function memoryDirectory(repository: PersonaRepository): string {
  return path.join(repository.root, "workspace", "memory");
}

function stagePath(stage: string, repositoryPath: string): string {
  const relative = normalizeMemoryPath(repositoryPath).slice("workspace/memory/".length);
  const target = path.resolve(stage, relative);
  const prefix = `${path.resolve(stage)}${path.sep}`;
  if (!target.startsWith(prefix))
    throw new MemoryProposalError("invalid_path", "The Memory path escapes its tree.");
  return target;
}

function normalizeMemoryPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function assertMemoryPath(value: string): void {
  const normalized = normalizeMemoryPath(value);
  const segments = normalized.split("/");
  if (
    normalized !== value ||
    !normalized.startsWith("workspace/memory/") ||
    !normalized.endsWith(".md") ||
    normalized.includes("//") ||
    normalized.split("/").includes("..") ||
    segments.includes(".") ||
    segments.some((segment) => segment.toLowerCase() === ".git") ||
    segments.some((segment) => !isPortablePathSegment(segment))
  ) {
    throw new MemoryProposalError("invalid_path", `Invalid Memory Markdown path: ${value}`);
  }
}

function isPortablePathSegment(segment: string): boolean {
  if (
    segment === "" ||
    hasControlCharacter(segment) ||
    /[<>:"|?*]/u.test(segment) ||
    /[ .]$/u.test(segment)
  ) {
    return false;
  }
  const basename = segment.split(".")[0]?.toUpperCase() ?? "";
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(basename);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function assertCreatePath(value: string): void {
  assertMemoryPath(value);
  const match = /^workspace\/memory\/(\d{4})-(\d{2})-(\d{2})\/[^/]+\.md$/u.exec(value);
  if (!match)
    throw new MemoryProposalError("invalid_path", "create paths must use workspace/memory/YYYY-MM-DD/*.md.");
  const [, year = "", month = "", day = ""] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new MemoryProposalError("invalid_path", "The create path contains an invalid calendar date.");
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (!(await exists(source))) return;
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new MemoryProposalError("invalid_path", "Memory trees cannot contain symbolic links.");
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() !== ".md") {
        throw new MemoryProposalError("invalid_path", "Memory trees may contain only Markdown files.");
      }
      await copyFilePreservingTimes(sourcePath, destinationPath);
    }
  }
}

export async function manifest(root: string): Promise<MemoryManifest> {
  if (!(await exists(root))) return [];
  const entries: MemoryManifest = [];
  await visitManifest(root, root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  assertPortableMemoryManifest(entries);
  return entries;
}

function assertPortableMemoryManifest(entries: MemoryManifest): void {
  const portablePaths = new Set<string>();
  for (const entry of entries) {
    assertMemoryPath(`workspace/memory/${entry.path}`);
    const key = entry.path
      .split("/")
      .map((segment) => segment.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC"))
      .join("/");
    if (portablePaths.has(key)) {
      throw new MemoryProposalError(
        "invalid_path",
        "Memory paths collide after portable Unicode normalization.",
      );
    }
    portablePaths.add(key);
  }
}

async function visitManifest(root: string, directory: string, output: MemoryManifest): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new MemoryProposalError("invalid_path", "Memory trees cannot contain symbolic links.");
    if (entry.isDirectory()) await visitManifest(root, target, output);
    else if (entry.isFile()) {
      if (path.extname(entry.name).toLowerCase() !== ".md") {
        throw new MemoryProposalError("invalid_path", "Memory trees may contain only Markdown files.");
      }
      const [content, info] = await Promise.all([readFile(target), stat(target)]);
      output.push({
        path: path.relative(root, target).split(path.sep).join("/"),
        sha256: createHash("sha256").update(content).digest("hex"),
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  }
}

function manifestJson(value: MemoryManifest): JsonValue {
  return value.map((entry) => ({ ...entry }));
}

function parseManifest(value: JsonValue): MemoryManifest {
  if (!Array.isArray(value)) {
    throw new StructuredOutputError("stored_manifest_invalid", { location: "manifest" });
  }
  return value.map((item) => {
    if (!isJsonObject(item)) {
      throw new StructuredOutputError("stored_manifest_invalid", { location: "manifest entry" });
    }
    const pathValue = item["path"];
    const sha = item["sha256"];
    const size = item["size"];
    const mtimeMs = item["mtimeMs"];
    if (
      typeof pathValue !== "string" ||
      typeof sha !== "string" ||
      typeof size !== "number" ||
      typeof mtimeMs !== "number"
    ) {
      throw new StructuredOutputError("stored_manifest_invalid", { location: "manifest entry fields" });
    }
    return { path: pathValue, sha256: sha, size, mtimeMs };
  });
}

function sameManifest(left: MemoryManifest, right: MemoryManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameManifestContent(left: MemoryManifest, right: MemoryManifest): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.path === candidate.path &&
        entry.sha256 === candidate.sha256 &&
        entry.size === candidate.size
      );
    })
  );
}

function assertExactKeys(value: Record<string, JsonValue>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new MemoryProposalError("invalid_schema", `Expected exactly: ${wanted.join(", ")}.`);
  }
}

function requireJsonString(value: JsonValue | undefined, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new MemoryProposalError(
      "invalid_schema",
      `${field} must be ${allowEmpty ? "a" : "a non-empty"} string.`,
    );
  }
  return value;
}

async function requireRegularFile(target: string, displayPath: string): Promise<void> {
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw new MemoryProposalError("conflict", `Memory file does not exist: ${displayPath}`, { cause: error });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
