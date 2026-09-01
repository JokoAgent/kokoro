import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface PackageManifest {
  readonly name: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface RootManifest extends PackageManifest {
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
}

export const WORKSPACE_DEPENDENCY_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  "@kokoro/protocol": new Set(),
  "@kokoro/client": new Set(["@kokoro/protocol"]),
  "@kokoro/runtime": new Set(["@kokoro/protocol"]),
  "@kokoro/cli": new Set(["@kokoro/client", "@kokoro/protocol", "@kokoro/runtime"]),
};

export interface BoundaryCheckOptions {
  readonly workspaceRoot: string;
  readonly allowlist?: Readonly<Record<string, ReadonlySet<string>>>;
}

export function checkWorkspaceBoundaries(options: BoundaryCheckOptions): readonly string[] {
  const workspaceRoot = resolve(options.workspaceRoot);
  const allowlist = options.allowlist ?? WORKSPACE_DEPENDENCY_ALLOWLIST;
  const rootManifestPath = join(workspaceRoot, "package.json");
  const errors: string[] = [];
  let rootManifest: RootManifest;
  try {
    rootManifest = parseManifest(rootManifestPath) as RootManifest;
  } catch (error) {
    return [`${rootManifestPath}: ${messageOf(error)}`];
  }
  const patterns = workspacePatterns(rootManifest);
  if (patterns.length === 0) return [`${rootManifestPath}: workspaces must contain at least one pattern`];

  const discovery = discoverWorkspaceManifests(workspaceRoot, patterns);
  errors.push(...discovery.errors);
  const manifests = new Map<string, { readonly path: string; readonly value: PackageManifest }>();
  for (const manifestPath of discovery.manifestPaths) {
    let manifest: PackageManifest;
    try {
      manifest = parseManifest(manifestPath);
    } catch (error) {
      errors.push(`${displayPath(workspaceRoot, manifestPath)}: ${messageOf(error)}`);
      continue;
    }
    const existing = manifests.get(manifest.name);
    if (existing !== undefined) {
      errors.push(
        `Duplicate workspace package name ${manifest.name}: ${displayPath(workspaceRoot, existing.path)} and ${displayPath(workspaceRoot, manifestPath)}`,
      );
      continue;
    }
    manifests.set(manifest.name, { path: manifestPath, value: manifest });
  }

  for (const name of Object.keys(allowlist)) {
    if (!manifests.has(name)) errors.push(`Boundary allowlist contains non-workspace package ${name}`);
  }

  for (const [name, entry] of manifests) {
    const allowed = allowlist[name];
    if (allowed === undefined) {
      errors.push(`${displayPath(workspaceRoot, entry.path)}: package ${name} is not present in the dependency boundary map`);
      continue;
    }
    if (rootManifest.version !== undefined && entry.value.version !== rootManifest.version) {
      errors.push(`${name} version ${String(entry.value.version)} does not match root version ${rootManifest.version}`);
    }
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [dependency, specifier] of Object.entries(entry.value[section] ?? {})) {
        if (forbiddenReferenceDependency(dependency, specifier)) {
          errors.push(`${name} must not depend on reference package ${dependency}@${specifier} in ${section}`);
        }
        if (!dependency.startsWith("@kokoro/")) continue;
        if (!manifests.has(dependency)) {
          errors.push(`${name} declares unknown workspace dependency ${dependency} in ${section}`);
        } else if (!allowed.has(dependency)) {
          errors.push(`${name} must not depend on ${dependency} in ${section}`);
        }
        if (rootManifest.version !== undefined && specifier !== rootManifest.version) {
          errors.push(
            `${name} ${section} entry ${dependency}@${specifier} must match root version ${rootManifest.version}`,
          );
        }
      }
    }
  }
  return errors;
}

function workspacePatterns(manifest: RootManifest): readonly string[] {
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces;
  if (manifest.workspaces !== undefined && !Array.isArray(manifest.workspaces)) {
    return manifest.workspaces.packages ?? [];
  }
  return [];
}

function discoverWorkspaceManifests(
  workspaceRoot: string,
  patterns: readonly string[],
): { readonly manifestPaths: readonly string[]; readonly errors: readonly string[] } {
  const selected = new Map<string, string>();
  const excluded = new Set<string>();
  const errors: string[] = [];
  for (const rawPattern of patterns) {
    if (typeof rawPattern !== "string" || rawPattern.trim() === "") {
      errors.push("Workspace patterns must be non-empty strings");
      continue;
    }
    const isExclusion = rawPattern.startsWith("!");
    const packagePattern = isExclusion ? rawPattern.slice(1) : rawPattern;
    const manifestPattern = packagePattern.endsWith("package.json")
      ? packagePattern
      : `${packagePattern.replace(/[\\/]+$/u, "")}/package.json`;
    const matches = globSync(manifestPattern, { cwd: workspaceRoot })
      .map((path) => resolve(workspaceRoot, path))
      .sort((left, right) => left.localeCompare(right, "en"));
    if (!isExclusion && matches.length === 0) {
      errors.push(`Workspace package pattern ${rawPattern} matched no package manifests`);
    }
    for (const manifestPath of matches) {
      const key = pathComparisonKey(manifestPath);
      if (isExclusion) excluded.add(key);
      else selected.set(key, manifestPath);
    }
  }
  for (const key of excluded) selected.delete(key);
  return {
    manifestPaths: [...selected.values()].sort((left, right) => left.localeCompare(right, "en")),
    errors,
  };
}

function parseManifest(path: string): PackageManifest {
  if (!existsSync(path)) throw new Error("package manifest is missing");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isManifest(parsed)) throw new Error("invalid package manifest");
  return parsed;
}

function forbiddenReferenceDependency(name: string, specifier: string): boolean {
  if (name.startsWith("@joko/") || name === "joko" || /(?:^|[/_-])pi-coding-agent$/iu.test(name)) return true;
  const normalizedSpecifier = specifier.replaceAll("\\", "/");
  return normalizedSpecifier.startsWith("npm:@joko/") ||
    /(?:^|\/)joko(?:\/|@|$)/iu.test(normalizedSpecifier) ||
    /(?:^|\/)pi-coding-agent(?:\/|@|$)/iu.test(normalizedSpecifier);
}

function displayPath(workspaceRoot: string, value: string): string {
  const displayed = relative(workspaceRoot, value);
  return displayed === "" || isAbsolute(displayed) ? value : displayed;
}

function pathComparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isManifest(value: unknown): value is PackageManifest {
  if (
    typeof value !== "object" || value === null ||
    !("name" in value) || typeof value.name !== "string" || value.name.trim() === ""
  ) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return DEPENDENCY_SECTIONS.every((section) => {
    if (!(section in record)) return true;
    const dependencies = record[section];
    return typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies) &&
      Object.values(dependencies).every((specifier) => typeof specifier === "string");
  });
}

function runCli(): void {
  const errors = checkWorkspaceBoundaries({
    workspaceRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  });
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Workspace dependency boundaries are valid.\n");
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) runCli();
