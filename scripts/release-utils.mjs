import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const OWNERSHIP_MARKER = ".kokoro-owned-temp";
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`],
  ),
);

export function isStrictDescendant(candidate, parent) {
  const childPath = resolve(candidate);
  const parentPath = resolve(parent);
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

export function assertSafeCleanupTarget(candidate, repositoryRoot, allowedBasenames) {
  const target = resolve(candidate);
  const root = resolve(repositoryRoot);
  if (!isStrictDescendant(target, root)) {
    throw new Error(`Refusing to clean a path outside the repository: ${target}`);
  }
  if (!allowedBasenames.has(path.basename(target))) {
    throw new Error(`Refusing to clean an unexpected artifact path: ${target}`);
  }
  return target;
}

export function createOwnedTempDirectory(prefix, repositoryRoot) {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error(`Unsafe temporary-directory prefix: ${prefix}`);
  const parent = realpathSync(tmpdir());
  const repository = realpathSync(repositoryRoot);
  if (parent === repository || isStrictDescendant(parent, repository)) {
    throw new Error(`The platform temporary directory must be outside the repository: ${parent}`);
  }
  const root = realpathSync(mkdtempSync(join(parent, prefix)));
  if (!isStrictDescendant(root, parent) || root === repository || isStrictDescendant(root, repository)) {
    throw new Error(`Temporary directory is not safely outside the repository: ${root}`);
  }
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  writeFileSync(join(root, OWNERSHIP_MARKER), token, { encoding: "utf8", flag: "wx" });
  return { marker: token, parent, root };
}

export function removeOwnedTempDirectory(owned, repositoryRoot) {
  if (!existsSync(owned.root)) return;
  const stat = lstatSync(owned.root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-directory temporary path: ${owned.root}`);
  }
  const actualRoot = realpathSync(owned.root);
  const actualParent = realpathSync(owned.parent);
  if (
    actualRoot !== owned.root ||
    !isStrictDescendant(actualRoot, actualParent) ||
    actualRoot === resolve(repositoryRoot) ||
    isStrictDescendant(actualRoot, repositoryRoot)
  ) {
    throw new Error(`Refusing to remove an unverified temporary directory: ${owned.root}`);
  }
  const markerPath = join(actualRoot, OWNERSHIP_MARKER);
  if (!existsSync(markerPath) || readFileSync(markerPath, "utf8") !== owned.marker) {
    throw new Error(`Refusing to remove a temporary directory without its ownership marker: ${owned.root}`);
  }
  rmSync(actualRoot, { force: true, recursive: true });
}

export function prepareIsolatedEnvironment(root, options = {}) {
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const cache = join(root, "cache");
  const config = join(home, ".config");
  const data = join(home, ".local", "share");
  for (const directory of [home, temporary, cache, config, data, join(cache, "npm")]) {
    mkdirSync(directory, { recursive: true });
  }
  const npmUserConfig = join(root, "npm-userconfig");
  const npmGlobalConfig = join(root, "npm-globalconfig");
  const gitGlobalConfig = join(root, "git-globalconfig");
  writeFileSync(npmUserConfig, "", "utf8");
  writeFileSync(npmGlobalConfig, "", "utf8");
  writeFileSync(gitGlobalConfig, "", "utf8");

  const environment = {
    APPDATA: join(home, "AppData", "Roaming"),
    AWS_EC2_METADATA_DISABLED: "true",
    GIT_CONFIG_GLOBAL: gitGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    LOCALAPPDATA: join(home, "AppData", "Local"),
    LOGNAME: "kokoro-test",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: join(cache, "npm"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    TZ: "UTC",
    USER: "kokoro-test",
    USERPROFILE: home,
    USERNAME: "kokoro-test",
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
  };

  copyEnvironmentVariable(environment, "PATH");
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    copyEnvironmentVariable(environment, name);
  }
  if (options.preserveCi === true) {
    for (const name of ["CI", "GITHUB_ACTIONS"]) copyEnvironmentVariable(environment, name);
  }
  return environment;
}

function copyEnvironmentVariable(target, name) {
  const value = process.env[name];
  if (value !== undefined && value !== "") target[name] = value;
}

export function npmInvocation() {
  const configured = process.env.npm_execpath;
  if (
    configured &&
    /\.[cm]?js$/i.test(configured) &&
    existsSync(configured) &&
    lstatSync(configured).isFile()
  ) {
    return { args: [configured], command: process.execPath };
  }
  const adjacentCli = resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(adjacentCli) && lstatSync(adjacentCli).isFile()) {
    return { args: [adjacentCli], command: process.execPath };
  }
  if (process.platform === "win32") {
    throw new Error("Could not locate npm-cli.js without invoking a Windows command shell");
  }
  return { args: [], command: "npm" };
}

export function runChecked(command, args, options = {}) {
  const display = [command, ...args].map(quoteForDisplay).join(" ");
  if (!options.quiet) process.stdout.write(`$ ${display}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    shell: false,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error(`Could not start ${display}`, { cause: result.error });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`Command failed with exit code ${result.status}: ${display}`);
  }
  return { stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

export function runNpm(args, options = {}) {
  const npm = npmInvocation();
  return runChecked(npm.command, [...npm.args, ...args], options);
}

function quoteForDisplay(value) {
  return /^[a-zA-Z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function packResultFromJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm pack did not return valid JSON", { cause: error });
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "filename" in parsed
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  if (candidates.length !== 1 || typeof candidates[0]?.filename !== "string") {
    throw new Error("npm pack returned an unexpected result shape");
  }
  return candidates[0];
}

export function readTarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = [];
  let offset = 0;
  let nextLongName;
  let nextPax = {};
  let globalPax = {};
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header, offset);
    const size = readTarNumber(header.subarray(124, 136), "size");
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) throw new Error(`Truncated tar entry at byte ${offset}`);
    const body = archive.subarray(bodyStart, bodyEnd);
    const rawName = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    let name = nextLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    nextLongName = undefined;

    if (type === "L") {
      nextLongName = tarText(body);
    } else if (type === "x") {
      nextPax = { ...nextPax, ...parsePax(body) };
    } else if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(body) };
    } else {
      const pax = { ...globalPax, ...nextPax };
      if (typeof pax.path === "string") name = pax.path;
      entries.push({ body, name, size, type });
      nextPax = {};
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error(`Tarball has no package entries: ${tarballPath}`);
  return entries;
}

function verifyTarChecksum(header, offset) {
  const expected = readTarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw new Error(`Invalid tar checksum at byte ${offset}`);
}

function readTarNumber(field, label) {
  if ((field[0] & 0x80) !== 0) {
    let result = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) result = (result << 8n) | BigInt(byte);
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Tar ${label} exceeds safe integer range`);
    return Number(result);
  }
  const text = tarText(field).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid tar ${label}: ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

function tarText(bytes) {
  const zero = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(zero === -1 ? bytes : bytes.subarray(0, zero));
}

function parsePax(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const separator = bytes.indexOf(32, offset);
    if (separator === -1) throw new Error("Malformed PAX record");
    const lengthText = new TextDecoder("ascii", { fatal: true }).decode(bytes.subarray(offset, separator));
    if (!/^[0-9]+$/.test(lengthText)) throw new Error("Malformed PAX record length");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) {
      throw new Error("Malformed PAX record length");
    }
    if (bytes[offset + length - 1] !== 10) throw new Error("Malformed PAX record terminator");
    const record = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(separator + 1, offset + length - 1),
    );
    const equals = record.indexOf("=");
    if (equals !== -1) fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

export function validatePackageEntries(entries, packageName, repositoryRoot) {
  const seen = new Set();
  const rootSpellings = [resolve(repositoryRoot), resolve(repositoryRoot).replaceAll("\\", "/")];
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, "");
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      WINDOWS_DRIVE.test(name) ||
      path.posix.normalize(name) !== name ||
      !name.startsWith("package/")
    ) {
      throw new Error(`${packageName} tarball contains an unsafe path: ${entry.name}`);
    }
    if (seen.has(name)) throw new Error(`${packageName} tarball contains duplicate path: ${name}`);
    seen.add(name);
    if (entry.type !== "0" && entry.type !== "5") {
      throw new Error(`${packageName} tarball contains a link or special entry: ${name}`);
    }
    const packagePath = name.slice("package/".length);
    const components = packagePath.split("/");
    const topLevel = components[0];
    const allowedTopLevel = new Set(["README.md", "dist", "fixtures", "package.json"]);
    if (!allowedTopLevel.has(topLevel)) {
      throw new Error(`${packageName} tarball contains a non-public top-level path: ${packagePath}`);
    }
    if (topLevel === "fixtures" && packageName !== "@kokoro/protocol") {
      throw new Error(`${packageName} tarball unexpectedly contains fixtures: ${packagePath}`);
    }
    if (/^licen[cs]e(?:\.|$)/i.test(path.posix.basename(packagePath))) {
      throw new Error(`${packageName} tarball must not contain a license file: ${packagePath}`);
    }
    if (/\.(?:[cm]?ts|tsx)$/i.test(packagePath) && !/\.d\.[cm]?ts$/i.test(packagePath)) {
      throw new Error(`${packageName} tarball contains TypeScript source: ${packagePath}`);
    }
    if (/\.tsbuildinfo$/i.test(packagePath)) {
      throw new Error(`${packageName} tarball contains internal build metadata: ${packagePath}`);
    }
    if (entry.type === "0" && isProbablyText(packagePath, entry.body)) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(entry.body);
      if (rootSpellings.some((spelling) => spelling.length > 3 && text.includes(spelling))) {
        throw new Error(`${packageName} tarball leaks the repository's absolute path in ${packagePath}`);
      }
    }
  }
  for (const required of ["package/package.json", "package/README.md"]) {
    if (!seen.has(required)) throw new Error(`${packageName} tarball is missing ${required.slice(8)}`);
  }
}

function isProbablyText(name, bytes) {
  if (/\.(?:js|json|map|md|ts)$/i.test(name)) return true;
  return bytes
    .subarray(0, Math.min(bytes.length, 512))
    .every((byte) => byte === 9 || byte === 10 || byte === 13 || byte >= 32);
}

export function publicExportSpecifiers(packageName, manifest) {
  const exportsField = manifest.exports;
  if (exportsField === undefined) return manifest.main ? [packageName] : [];
  const keys =
    typeof exportsField === "object" &&
    exportsField !== null &&
    Object.keys(exportsField).some((key) => key.startsWith("."))
      ? Object.keys(exportsField)
      : ["."];
  return keys.map((key) => {
    if (key.includes("*")) throw new Error(`${packageName} uses an unbounded wildcard export: ${key}`);
    return key === "." ? packageName : `${packageName}${key.slice(1)}`;
  });
}

export function hasExactDeliveredPublicationCoverage(records, minimumCommittedEvents = 1) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  if (!Number.isSafeInteger(minimumCommittedEvents) || minimumCommittedEvents < 1) {
    throw new RangeError("minimumCommittedEvents must be a positive safe integer");
  }

  const committed = new Map();
  const delivered = new Set();
  for (const record of records) {
    const observation = record?.observation;
    if (!observation || typeof observation !== "object") continue;
    if (observation.kind === "event_committed") {
      const eventId = observation.eventId;
      const checkpointId = observation.checkpoint?.checkpointId;
      if (typeof eventId !== "string" || typeof checkpointId !== "string") continue;
      const existing = committed.get(eventId);
      if (existing !== undefined && existing !== checkpointId) return false;
      committed.set(eventId, checkpointId);
      continue;
    }
    if (
      observation.kind === "publication" &&
      observation.state === "delivered" &&
      typeof observation.eventId === "string" &&
      typeof observation.checkpointId === "string"
    ) {
      delivered.add(`${observation.eventId}\u0000${observation.checkpointId}`);
    }
  }
  return (
    committed.size >= minimumCommittedEvents &&
    [...committed].every(([eventId, checkpointId]) => delivered.has(`${eventId}\u0000${checkpointId}`))
  );
}

export function assertClientRootIsNodeNeutral(consumerDirectory) {
  const clientDirectory = join(consumerDirectory, "node_modules", "@kokoro", "client");
  const protocolDirectory = join(consumerDirectory, "node_modules", "@kokoro", "protocol");
  const clientManifest = JSON.parse(readFileSync(join(clientDirectory, "package.json"), "utf8"));
  const protocolManifest = JSON.parse(readFileSync(join(protocolDirectory, "package.json"), "utf8"));
  const roots = [
    resolveExportFile(clientDirectory, clientManifest, "."),
    resolveExportFile(protocolDirectory, protocolManifest, "."),
  ];
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    if (/\b(?:process\s*\.|Buffer\b|__dirname\b|__filename\b)/.test(source)) {
      throw new Error(`The client root's reachable graph assumes Node globals: ${file}`);
    }
    for (const specifier of staticModuleSpecifiers(source)) {
      if (NODE_BUILTINS.has(specifier)) {
        throw new Error(`The client root's reachable graph imports Node builtin ${specifier}: ${file}`);
      }
      if (specifier.startsWith(".")) {
        const resolved = resolve(path.dirname(file), specifier);
        if (
          !isStrictDescendant(resolved, clientDirectory) &&
          !isStrictDescendant(resolved, protocolDirectory)
        ) {
          throw new Error(`The client root's module graph escapes its packages: ${specifier} from ${file}`);
        }
        pending.push(resolved);
      } else if (specifier === "@kokoro/protocol") {
        pending.push(roots[1]);
      } else {
        throw new Error(`The client root has an unexpected runtime dependency: ${specifier}`);
      }
    }
  }
}

function resolveExportFile(packageDirectory, manifest, key) {
  let target = manifest.exports?.[key] ?? (key === "." ? manifest.exports : undefined);
  while (target && typeof target === "object") {
    target = target.import ?? target.default ?? target.node ?? Object.values(target)[0];
  }
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(`${manifest.name} has no importable ${key} export`);
  }
  const file = resolve(packageDirectory, target);
  if (!isStrictDescendant(file, packageDirectory))
    throw new Error(`${manifest.name} export escapes its package`);
  return file;
}

function staticModuleSpecifiers(source) {
  const specifiers = [];
  const expression = /(?:\b(?:import|export)\s+(?:[^"']*?\s+from\s*)?|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) specifiers.push(match[1]);
  return specifiers;
}

export function vitestCliPath() {
  return require.resolve("vitest/vitest.mjs");
}
