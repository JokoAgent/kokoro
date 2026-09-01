import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertClientRootIsNodeNeutral,
  createOwnedTempDirectory,
  isStrictDescendant,
  packResultFromJson,
  prepareIsolatedEnvironment,
  publicExportSpecifiers,
  readTarEntries,
  removeOwnedTempDirectory,
  runChecked,
  runNpm,
  validatePackageEntries,
} from "./release-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  { directory: "packages/protocol", name: "@kokoro/protocol" },
  { directory: "packages/client", name: "@kokoro/client" },
  { directory: "packages/runtime", name: "@kokoro/runtime" },
  { directory: "apps/cli", name: "@kokoro/cli" },
];
const packageNames = new Set(packages.map((pkg) => pkg.name));
const releaseVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
const sourceRootFiles = [
  ".npmrc",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
];
const releaseScriptFiles = [
  "check-boundaries.test.ts",
  "check-boundaries.ts",
  "clean.mjs",
  "packed-runtime-smoke.mjs",
  "release-utils.mjs",
  "release-utils.test.ts",
  "test-ci.mjs",
  "test-packed-install.mjs",
];
const workspaceRootFiles = new Set([
  "package.json",
  "README.md",
  "tsconfig.build.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "vitest.config.ts",
]);
const workspaceSourceDirectories = new Set(["fixtures", "src", "test"]);
const omittedArtifactDirectories = new Set([".tmp", "coverage", "dist", "node_modules"]);
const omittedRootEntries = new Set([
  ".agent-docs",
  ".deprecated",
  ".github",
  ".git",
  ".gitattributes",
  ".gitignore",
  ".tmp",
  "AGENTS.md",
  "coverage",
  "dist",
  "node_modules",
]);
const forbiddenSourceSegments = new Set([
  ".agent-docs",
  ".deprecated",
  "legacy",
  "old",
  "reference",
  "references",
]);
const OWNERSHIP_MARKER_NAME = ".kokoro-owned-temp";
const owned = createOwnedTempDirectory("kokoro-release-", repositoryRoot);
let failure;

try {
  const environment = prepareIsolatedEnvironment(owned.root, { preserveCi: true });
  const sourceDirectory = join(owned.root, "source");
  const tarballDirectory = join(owned.root, "tarballs");
  const consumerDirectory = join(owned.root, "consumer");
  createSourceSnapshot(sourceDirectory);
  assertSourceSnapshot(sourceDirectory);
  assertSnapshotMatchesSource(sourceDirectory);
  for (const pkg of packages) assertPackageManifest(pkg, sourceDirectory);
  mkdirSync(tarballDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: sourceDirectory,
    env: environment,
  });
  runNpm(["run", "build"], { cwd: sourceDirectory, env: environment });

  const tarballs = new Map();
  const manifests = new Map();
  for (const pkg of packages) {
    const packageDirectory = join(sourceDirectory, pkg.directory);
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    const packed = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], {
      capture: true,
      cwd: packageDirectory,
      env: environment,
    });
    const result = packResultFromJson(packed.stdout);
    if (result.name !== undefined && result.name !== pkg.name) {
      throw new Error(`npm packed ${String(result.name)} from ${pkg.directory}; expected ${pkg.name}`);
    }
    const tarball = realpathSync(join(tarballDirectory, result.filename));
    if (!isStrictDescendant(tarball, tarballDirectory)) {
      throw new Error(`npm pack returned a tarball outside its destination: ${tarball}`);
    }
    const entries = readTarEntries(tarball);
    validatePackageEntries(entries, pkg.name, sourceDirectory);
    compareNpmFileList(result, entries, pkg.name);
    tarballs.set(pkg.name, tarball);
    manifests.set(pkg.name, manifest);
  }

  const dependencies = Object.fromEntries(
    packages.map((pkg) => [pkg.name, fileDependency(consumerDirectory, tarballs.get(pkg.name))]),
  );
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ dependencies, name: "kokoro-packed-consumer", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--package-lock=false",
    ],
    { cwd: consumerDirectory, env: environment },
  );

  runPackedTypecheck(consumerDirectory, sourceDirectory, environment);
  assertClientRootIsNodeNeutral(consumerDirectory);
  const imports = packages.flatMap((pkg) => publicExportSpecifiers(pkg.name, manifests.get(pkg.name)));
  writeFileSync(join(consumerDirectory, "smoke.mjs"), smokeProgram(imports), "utf8");
  runChecked(process.execPath, [join(consumerDirectory, "smoke.mjs")], {
    cwd: consumerDirectory,
    env: environment,
  });
  runCliHelp(consumerDirectory, manifests.get("@kokoro/cli"), environment);
  writeFileSync(
    join(consumerDirectory, "packed-runtime-smoke.mjs"),
    readFileSync(join(sourceDirectory, "scripts", "packed-runtime-smoke.mjs"), "utf8"),
    "utf8",
  );
  writeFileSync(
    join(consumerDirectory, "release-utils.mjs"),
    readFileSync(join(sourceDirectory, "scripts", "release-utils.mjs"), "utf8"),
    "utf8",
  );
  runChecked(process.execPath, [join(consumerDirectory, "packed-runtime-smoke.mjs")], {
    cwd: consumerDirectory,
    env: environment,
  });
  process.stdout.write(
    "Package archives and the independent packed Persona loop passed.\n",
  );
} catch (error) {
  failure = error;
} finally {
  try {
    removeOwnedTempDirectory(owned, repositoryRoot);
  } catch (cleanupError) {
    failure = failure ?? cleanupError;
    if (failure !== cleanupError) process.stderr.write(`${formatError(cleanupError)}\n`);
  }
}

if (failure) {
  process.stderr.write(`${formatError(failure)}\n`);
  process.exitCode = 1;
}

function assertPackageManifest(pkg, sourceDirectory) {
  const directory = join(sourceDirectory, pkg.directory);
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Required publishable package is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== pkg.name) {
    throw new Error(`${manifestPath} has name ${String(manifest.name)}; expected ${pkg.name}`);
  }
  if (manifest.private === true) throw new Error(`${pkg.name} is unexpectedly marked private`);
  if (manifest.version !== releaseVersion) {
    throw new Error(`${pkg.name} version ${String(manifest.version)} does not match ${releaseVersion}`);
  }
  for (const dependencyKind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = manifest[dependencyKind];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (packageNames.has(name) && specifier !== releaseVersion) {
        throw new Error(
          `${pkg.name} ${dependencyKind} entry ${name}@${String(specifier)} must match ${releaseVersion}`,
        );
      }
    }
  }
}

function createSourceSnapshot(sourceDirectory) {
  if (!isStrictDescendant(sourceDirectory, owned.root)) {
    throw new Error(`Source snapshot must be inside the owned release directory: ${sourceDirectory}`);
  }
  mkdirSync(sourceDirectory, { recursive: false });
  classifyRepositoryRoot();
  for (const file of sourceRootFiles) copyRequiredFile(file, sourceDirectory);

  const scriptEntries = readdirSync(join(repositoryRoot, "scripts"), { withFileTypes: true });
  for (const entry of scriptEntries) {
    if (!entry.isFile() || !releaseScriptFiles.includes(entry.name)) {
      throw new Error(`Unclassified release script entry: scripts/${entry.name}`);
    }
  }
  for (const file of releaseScriptFiles) copyRequiredFile(join("scripts", file), sourceDirectory);

  for (const parent of ["apps", "packages"]) {
    const expected = new Set(
      packages
        .map((pkg) => pkg.directory.split("/"))
        .filter(([candidateParent]) => candidateParent === parent)
        .map((segments) => segments[1]),
    );
    for (const entry of readdirSync(join(repositoryRoot, parent), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !expected.has(entry.name)) {
        throw new Error(`Unclassified workspace entry: ${parent}/${entry.name}`);
      }
    }
  }

  for (const pkg of packages) copyWorkspace(pkg.directory, sourceDirectory);
}

function classifyRepositoryRoot() {
  const allowedDirectories = new Set(["apps", "packages", "scripts"]);
  const allowedFiles = new Set(sourceRootFiles);
  for (const entry of readdirSync(repositoryRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Release source refuses symbolic links: ${entry.name}`);
    if (entry.isFile()) {
      if (allowedFiles.has(entry.name) || omittedRootEntries.has(entry.name) || entry.name.endsWith(".tgz")) {
        continue;
      }
      throw new Error(`Unclassified repository-root file: ${entry.name}`);
    }
    if (!entry.isDirectory()) throw new Error(`Unsupported repository-root entry: ${entry.name}`);
    if (allowedDirectories.has(entry.name) || omittedRootEntries.has(entry.name)) continue;
    if (forbiddenSourceSegments.has(entry.name.toLowerCase())) continue;
    throw new Error(`Unclassified repository-root directory: ${entry.name}`);
  }
}

function copyWorkspace(relativeDirectory, sourceDirectory) {
  const workspace = join(repositoryRoot, relativeDirectory);
  const entries = readdirSync(workspace, { withFileTypes: true });
  for (const entry of entries) {
    const relativeEntry = join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source snapshot refuses symbolic links: ${relativeEntry}`);
    if (entry.isFile()) {
      if (entry.name.endsWith(".tgz")) continue;
      if (!workspaceRootFiles.has(entry.name)) {
        throw new Error(`Unclassified workspace file: ${relativeEntry}`);
      }
      copyRequiredFile(relativeEntry, sourceDirectory);
      continue;
    }
    if (!entry.isDirectory()) throw new Error(`Unsupported workspace entry: ${relativeEntry}`);
    if (omittedArtifactDirectories.has(entry.name)) continue;
    assertAllowedSourceSegment(entry.name, relativeEntry);
    if (!workspaceSourceDirectories.has(entry.name)) {
      throw new Error(`Unclassified workspace directory: ${relativeEntry}`);
    }
    copySourceTree(relativeEntry, sourceDirectory);
  }
}

function copySourceTree(relativeDirectory, sourceDirectory) {
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  const stat = lstatSync(absoluteDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Source tree must be a real directory: ${relativeDirectory}`);
  }
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativeEntry = join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source snapshot refuses symbolic links: ${relativeEntry}`);
    assertAllowedSourceSegment(entry.name, relativeEntry);
    if (entry.isDirectory()) {
      copySourceTree(relativeEntry, sourceDirectory);
    } else if (entry.isFile()) {
      copyRequiredFile(relativeEntry, sourceDirectory);
    } else {
      throw new Error(`Unsupported source entry: ${relativeEntry}`);
    }
  }
}

function copyRequiredFile(relativeFile, sourceDirectory) {
  const source = resolve(repositoryRoot, relativeFile);
  const destination = resolve(sourceDirectory, relativeFile);
  if (!isStrictDescendant(source, repositoryRoot) || !isStrictDescendant(destination, sourceDirectory)) {
    throw new Error(`Source snapshot path escapes its root: ${relativeFile}`);
  }
  if (!existsSync(source)) throw new Error(`Required release source is missing: ${relativeFile}`);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Release source must be a regular file: ${relativeFile}`);
  }
  for (const segment of relativeFile.split(/[\\/]/u)) assertAllowedSourceSegment(segment, relativeFile);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function assertAllowedSourceSegment(segment, displayPath) {
  if (forbiddenSourceSegments.has(segment.toLowerCase())) {
    throw new Error(`Reference or deprecated implementation is forbidden in release source: ${displayPath}`);
  }
}

function assertSourceSnapshot(sourceDirectory) {
  for (const forbidden of [
    ".agent-docs",
    ".deprecated",
    ".github",
    "node_modules",
    "dist",
    join("packages", "runtime", "dist"),
    join("packages", "protocol", "dist"),
    join("packages", "client", "dist"),
    join("apps", "cli", "dist"),
  ]) {
    if (existsSync(join(sourceDirectory, forbidden))) {
      throw new Error(`Forbidden path entered the clean source snapshot: ${forbidden}`);
    }
  }
  if (existsSync(join(sourceDirectory, OWNERSHIP_MARKER_NAME))) {
    throw new Error("The release ownership marker must not enter the source snapshot.");
  }
}

function assertSnapshotMatchesSource(sourceDirectory) {
  for (const snapshotFile of snapshotFiles(sourceDirectory)) {
    const relativeFile = relative(sourceDirectory, snapshotFile);
    const sourceFile = resolve(repositoryRoot, relativeFile);
    if (!isStrictDescendant(sourceFile, repositoryRoot) || !existsSync(sourceFile)) {
      throw new Error(`Release source changed while its snapshot was copied: ${relativeFile}`);
    }
    const sourceStat = lstatSync(sourceFile);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Release source changed type while its snapshot was copied: ${relativeFile}`);
    }
    if (!readFileSync(snapshotFile).equals(readFileSync(sourceFile))) {
      throw new Error(`Release source changed while its snapshot was copied: ${relativeFile}`);
    }
  }
}

function snapshotFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source snapshot contains a symbolic link: ${candidate}`);
    if (entry.isDirectory()) files.push(...snapshotFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
    else throw new Error(`Source snapshot contains an unsupported entry: ${candidate}`);
  }
  return files;
}

function fileDependency(fromDirectory, tarball) {
  const pathFromConsumer = relative(fromDirectory, tarball).replaceAll("\\", "/");
  if (pathFromConsumer === "" || isAbsolute(pathFromConsumer)) {
    throw new Error(`Cannot create a relative file dependency for ${tarball}`);
  }
  return `file:${pathFromConsumer.startsWith(".") ? pathFromConsumer : `./${pathFromConsumer}`}`;
}

function compareNpmFileList(result, entries, packageName) {
  if (!Array.isArray(result.files)) throw new Error(`npm pack did not report the ${packageName} file list`);
  const npmFiles = new Set(result.files.map((file) => `package/${file.path.replaceAll("\\", "/")}`));
  const archiveFiles = new Set(entries.filter((entry) => entry.type === "0").map((entry) => entry.name));
  if (npmFiles.size !== archiveFiles.size || [...npmFiles].some((file) => !archiveFiles.has(file))) {
    throw new Error(`${packageName} npm file list does not match its tar archive`);
  }
}

function smokeProgram(imports) {
  return `import assert from "node:assert/strict";

const publicImports = ${JSON.stringify(imports, null, 2)};
for (const specifier of publicImports) {
  const options = specifier.endsWith(".json") ? { with: { type: "json" } } : undefined;
  const module = options ? await import(specifier, options) : await import(specifier);
  assert.ok(Object.keys(module).length > 0, \`Public export \${specifier} is empty\`);
}

const protocol = await import("@kokoro/protocol");
const payload = { message: "Kokoro framing smoke: 世界", nested: [true, 7, null] };
const frame = protocol.encodeJsonFrame(payload);
const decoder = new protocol.JsonFrameDecoder();
const decoded = [
  ...decoder.push(frame.subarray(0, 1)),
  ...decoder.push(frame.subarray(1, 5)),
  ...decoder.push(frame.subarray(5)),
];
decoder.end();
assert.equal(JSON.stringify(decoded), JSON.stringify([payload]));

const client = await import("@kokoro/client");
assert.equal(typeof client.KokoroClient, "function");
const runtime = await import("@kokoro/runtime");
assert.equal(typeof runtime.KokoroRuntime, "function");
process.stdout.write("Public export and protocol smoke tests passed.\\n");
`;
}

function runPackedTypecheck(consumerDirectory, sourceDirectory, environment) {
  const typecheckPath = join(sourceDirectory, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(typecheckPath))
    throw new Error(`The clean source install has no TypeScript CLI: ${typecheckPath}`);
  writeFileSync(
    join(consumerDirectory, "type-smoke.ts"),
    `import {
  KokoroClient,
  type ByteTransportFactory,
  type KokoroClientOptions,
} from "@kokoro/client";
import { connectNodeSocket, type NodeKokoroClientOptions } from "@kokoro/client/node";
import {
  encodeClientEnvelope,
  type ClientEnvelope,
  type ObservationRecord,
  type StartCommand,
} from "@kokoro/protocol";
import { KokoroRuntime, ProtocolServer } from "@kokoro/runtime";
import { RuntimeFactStore } from "@kokoro/runtime/testing";
import { runCli } from "@kokoro/cli";

declare const transportFactory: ByteTransportFactory;
const clientOptions: KokoroClientOptions = {
  clientName: "packed-type-consumer",
  clientVersion: "1.0.0",
  transportFactory,
};
const client = new KokoroClient(clientOptions);
const start: StartCommand = {
  type: "start",
  personaId: "persona-1",
  from: { kind: "current_working_tree" },
  model: null,
  promptLocale: null,
};
const hello: ClientEnvelope = {
  protocol: "kokoro/1",
  kind: "hello",
  messageId: "hello-1",
  correlationId: "connection-1",
  client: { name: "packed-type-consumer", version: "1.0.0" },
  maxFrameBytes: 1024,
};
encodeClientEnvelope(hello);
const { type: startType, ...startInput } = start;
startType satisfies "start";
client.start(startInput);
client.subscribeObservations((record: ObservationRecord) => {
  if (record.observation.kind === "publication" && record.observation.state === "delivered") {
    record.observation.checkpointId satisfies string;
  }
});
const nodeOptions: NodeKokoroClientOptions = {
  clientName: "packed-node-consumer",
  clientVersion: "1.0.0",
  socket: { path: "kokoro.sock" },
};
void connectNodeSocket(nodeOptions);
void [KokoroRuntime, ProtocolServer, RuntimeFactStore, runCli];
client.dispose();
`,
    "utf8",
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: [],
          verbatimModuleSyntax: true,
        },
        files: ["type-smoke.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  runChecked(process.execPath, [typecheckPath, "-p", join(consumerDirectory, "tsconfig.json")], {
    cwd: consumerDirectory,
    env: environment,
  });
}

function runCliHelp(consumerDirectory, manifest, environment) {
  const bin = manifest.bin;
  const relativeBin =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object"
        ? (bin.kokoro ?? Object.values(bin)[0])
        : undefined;
  if (typeof relativeBin !== "string") throw new Error("@kokoro/cli does not declare an executable bin");
  const packageDirectory = join(consumerDirectory, "node_modules", "@kokoro", "cli");
  const executable = resolve(packageDirectory, relativeBin);
  if (!isStrictDescendant(executable, packageDirectory) || !existsSync(executable)) {
    throw new Error(`@kokoro/cli bin is missing or escapes its package: ${relativeBin}`);
  }
  const installedBin = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "kokoro.cmd" : "kokoro",
  );
  if (!isStrictDescendant(installedBin, consumerDirectory) || !existsSync(installedBin)) {
    throw new Error("npm did not create the installed kokoro executable");
  }
  if (process.platform !== "win32" && realpathSync(installedBin) !== realpathSync(executable)) {
    throw new Error("the installed kokoro executable does not target @kokoro/cli's declared bin");
  }
  const result = runNpm(["exec", "--offline", "--", "kokoro", "--help"], {
    capture: true,
    cwd: consumerDirectory,
    env: environment,
  });
  const help = `${result.stdout}\n${result.stderr}`;
  if (!/(?:kokoro|usage|commands|options)/i.test(help)) {
    throw new Error("@kokoro/cli --help returned no recognizable help text");
  }
}

function formatError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
