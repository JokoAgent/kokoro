import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface FilesystemDirectoryIdentity {
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/** Resolves links and captures the filesystem's own identity for an existing directory. */
export async function filesystemDirectoryIdentity(
  directory: string,
): Promise<FilesystemDirectoryIdentity> {
  const realPath = await realpath(path.resolve(directory));
  const information = await stat(realPath, { bigint: true });
  if (!information.isDirectory()) {
    throw new Error("The filesystem path is not a directory.");
  }
  return {
    realPath,
    device: information.dev,
    inode: information.ino,
  };
}

export function sameFilesystemDirectory(
  left: FilesystemDirectoryIdentity,
  right: FilesystemDirectoryIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/**
 * Compares existing directories by filesystem identity rather than path spelling.
 * This follows the host filesystem's case, Unicode, link, and junction behavior.
 */
export async function filesystemDirectoriesEqual(left: string, right: string): Promise<boolean> {
  const [leftIdentity, rightIdentity] = await Promise.all([
    filesystemDirectoryIdentity(left),
    filesystemDirectoryIdentity(right),
  ]);
  return sameFilesystemDirectory(leftIdentity, rightIdentity);
}

/** Determines whether either existing directory physically contains the other. */
export async function filesystemDirectoriesOverlap(
  left: FilesystemDirectoryIdentity,
  right: FilesystemDirectoryIdentity,
): Promise<boolean> {
  if (sameFilesystemDirectory(left, right)) return true;
  return (
    (await directoryContainsIdentity(left, right)) ||
    (await directoryContainsIdentity(right, left))
  );
}

/**
 * Checks an existing or not-yet-created directory against an existing protected
 * directory. A missing candidate is located through its nearest existing
 * physical ancestor; an existing link or junction is compared by target identity.
 */
export async function filesystemPathOverlapsDirectory(
  candidate: string,
  protectedDirectory: string,
): Promise<boolean> {
  const [candidateResolution, protectedIdentity] = await Promise.all([
    nearestExistingDirectory(candidate),
    filesystemDirectoryIdentity(protectedDirectory),
  ]);
  if (candidateResolution.exact) {
    return filesystemDirectoriesOverlap(candidateResolution.identity, protectedIdentity);
  }
  return directoryContainsIdentity(protectedIdentity, candidateResolution.identity);
}

async function directoryContainsIdentity(
  ancestor: FilesystemDirectoryIdentity,
  descendant: FilesystemDirectoryIdentity,
): Promise<boolean> {
  let candidate = descendant.realPath;
  for (;;) {
    const identity = await filesystemDirectoryIdentity(candidate);
    if (sameFilesystemDirectory(ancestor, identity)) return true;
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

async function nearestExistingDirectory(
  target: string,
): Promise<{ identity: FilesystemDirectoryIdentity; exact: boolean }> {
  const resolved = path.resolve(target);
  let candidate = resolved;
  for (;;) {
    try {
      return {
        identity: await filesystemDirectoryIdentity(candidate),
        exact: candidate === resolved,
      };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error("No existing filesystem ancestor is available.");
    }
    candidate = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
