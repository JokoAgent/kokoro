import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeCleanupTarget } from "./release-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = join(repositoryRoot, "package.json");
if (!existsSync(rootManifest)) throw new Error(`Repository manifest not found: ${rootManifest}`);

const artifactDirectories = new Set([".tmp", "coverage", "dist"]);
const candidates = [];

collectArtifacts(repositoryRoot);
for (const workspaceParentName of ["apps", "packages"]) {
  const workspaceParent = join(repositoryRoot, workspaceParentName);
  if (!existsSync(workspaceParent) || !lstatSync(workspaceParent).isDirectory()) continue;
  for (const entry of readdirSync(workspaceParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    collectArtifacts(join(workspaceParent, entry.name));
  }
}

for (const candidate of candidates.sort()) {
  const allowed = candidate.endsWith(".tgz")
    ? new Set([candidate.split(/[\\/]/).at(-1)])
    : artifactDirectories;
  const target = assertSafeCleanupTarget(candidate, repositoryRoot, allowed);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to clean a symbolic-link artifact: ${target}`);
  }
  rmSync(target, { force: true, recursive: stat.isDirectory() });
  process.stdout.write(`removed ${target}\n`);
}

function collectArtifacts(directory) {
  for (const basename of artifactDirectories) {
    const candidate = join(directory, basename);
    if (existsSync(candidate)) candidates.push(candidate);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tgz")) candidates.push(join(directory, entry.name));
  }
}
