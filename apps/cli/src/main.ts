import { chmod, lstat, mkdir, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { connectNodeSocket } from "@kokoro/client/node";
import type { Command } from "@kokoro/protocol";
import {
  assertCredentialFree,
  type ByteConnection,
  KokoroRuntime,
  OpenAiCompatibleProvider,
  type ProtocolConnection,
  ProtocolServer,
} from "@kokoro/runtime";
import { CliConfigError, loadConfig } from "./config.js";
import { CLI_PACKAGE_VERSION } from "./package-version.js";

const HELP = {
  en: `Kokoro durable Persona harness

Usage:
  kokoro serve --config <config.json> [--locale zh-CN]
  kokoro request --socket <local-path> --json <protocol-command-json> [--locale zh-CN]
  kokoro --help [--locale zh-CN]

Config (credentials are environment-variable references, never values):
  {
    "stateDirectory": "./state",
    "personaDirectory": "./personas",
    "socketPath": "\\\\.\\pipe\\kokoro" | "./kokoro.sock",
    "defaultModel": { "provider": "provider-id", "model": "model-id" },
    "providers": [{
      "type": "openai-compatible",
      "id": "provider-id",
      "baseUrl": "https://example.invalid/v1",
      "apiKeyEnv": "PROVIDER_API_KEY",
      "models": [{ "id": "model-id", "contextWindow": 128000, "maxOutputTokens": 8192 }]
    }]
  }
`,
  "zh-CN": `Kokoro 持久 Persona harness

用法：
  kokoro serve --config <config.json> [--locale zh-CN]
  kokoro request --socket <本地路径> --json <protocol-command-json> [--locale zh-CN]
  kokoro --help [--locale zh-CN]

配置中的凭据只能引用环境变量，绝不能写入凭据值。Provider 配置字段与英文帮助示例相同。
`,
} as const;

export type CliLocale = keyof typeof HELP;

export async function runCli(argv: readonly string[]): Promise<void> {
  const locale = cliLocale(optionalOption(argv, "--locale"));
  const args = withoutOption(argv, "--locale");
  const [command] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP[locale]);
    return;
  }
  if (command === "serve") {
    await serve(requiredOption(args.slice(1), "--config"), locale);
    return;
  }
  if (command === "request") {
    await request(requiredOption(args.slice(1), "--socket"), requiredOption(args.slice(1), "--json"));
    return;
  }
  throw new CliUserError(`Unknown command: ${command}`, `未知命令：${command}`);
}

export async function serve(configPath: string, locale: CliLocale = "en"): Promise<void> {
  const config = await loadConfig(configPath);
  const runtime = await KokoroRuntime.open({
    stateDirectory: config.stateDirectory,
    personaDirectory: config.personaDirectory,
    providers: config.providers.map((provider) => new OpenAiCompatibleProvider(provider)),
    ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel }),
  });
  const protocol = new ProtocolServer(runtime);
  const connections = new Set<ProtocolConnection>();
  let accepting = false;
  let listening = false;
  let boundSocket: { dev: bigint; ino: bigint } | undefined;
  const peerIdentity = localPeerIdentity();
  const server = createServer((socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    socket.pause();
    const connection = new NetByteConnection(socket, peerIdentity);
    void protocol.attach(connection).then(
      (attached) => {
        connections.add(attached);
        socket.once("close", () => connections.delete(attached));
        socket.resume();
      },
      () => socket.destroy(),
    );
  });
  let operationFailed = false;
  let operationError: unknown;
  try {
    if (process.platform !== "win32") await prepareUnixSocket(config.socketPath);
    await listen(server, config.socketPath);
    listening = true;
    if (process.platform !== "win32") {
      const info = await lstat(config.socketPath, { bigint: true });
      if (!info.isSocket()) {
        throw new CliUserError("Bound IPC path is not a Unix socket.", "绑定的 IPC 路径不是 Unix socket。");
      }
      boundSocket = { dev: info.dev, ino: info.ino };
      await chmod(config.socketPath, 0o600);
    }
    accepting = true;
    process.stdout.write(
      locale === "zh-CN"
        ? `Kokoro 正在监听 ${config.socketPath}\n`
        : `Kokoro listening on ${config.socketPath}\n`,
    );
    await waitForShutdown();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  accepting = false;
  const cleanupErrors: unknown[] = [];
  const serverClosed = listening
    ? closeServer(server).catch((error: unknown) => {
        cleanupErrors.push(error);
      })
    : Promise.resolve();
  try {
    await protocol.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  await serverClosed;
  try {
    await runtime.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (process.platform !== "win32" && boundSocket !== undefined) {
    try {
      await removeOwnedUnixSocket(config.socketPath, boundSocket);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new CliUserError("Kokoro serve and shutdown failed.", "Kokoro 服务运行和关闭均失败。", {
        cause: new AggregateError([operationError, ...cleanupErrors]),
      });
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new CliUserError("Kokoro shutdown failed.", "Kokoro 关闭失败。", {
      cause: new AggregateError(cleanupErrors),
    });
  }
}

export async function request(socketPath: string, json: string): Promise<void> {
  assertCredentialFree(socketPath, "CLI socket path");
  const command = JSON.parse(json) as Command;
  const client = await connectNodeSocket({
    clientName: "kokoro-cli",
    clientVersion: CLI_PACKAGE_VERSION,
    socket: { path: socketPath },
  });
  try {
    const result = await client.request(command);
    process.stdout.write(`${JSON.stringify({ result, snapshot: client.snapshot }, null, 2)}\n`);
  } finally {
    client.dispose();
  }
}

class NetByteConnection implements ByteConnection {
  readonly peerIdentity: string;
  readonly #socket: Socket;
  readonly #data = new Set<(chunk: Uint8Array) => void>();
  readonly #close = new Set<() => void>();
  #tail: Promise<void> = Promise.resolve();

  constructor(socket: Socket, peerIdentity: string) {
    this.#socket = socket;
    this.peerIdentity = peerIdentity;
    socket.on("data", (chunk) => {
      const retained = Uint8Array.from(chunk);
      for (const listener of this.#data) listener(retained);
    });
    socket.once("close", () => {
      for (const listener of this.#close) listener();
      this.#data.clear();
      this.#close.clear();
    });
  }

  send(frame: Uint8Array): Promise<void> {
    const retained = Uint8Array.from(frame);
    const write = this.#tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.#socket.write(retained, (error) => (error ? reject(error) : resolve()));
        }),
    );
    this.#tail = write.catch(() => {});
    return write;
  }

  close(): void {
    this.#socket.end();
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }
}

export function formatCliFailure(error: unknown, locale: CliLocale): string {
  const fallback = locale === "zh-CN" ? "未知故障" : "Unknown failure";
  let message = fallback;
  if (error instanceof CliConfigError) message = locale === "zh-CN" ? error.zhCN : error.message;
  else if (error instanceof CliUserError) message = locale === "zh-CN" ? error.zhCN : error.message;
  else if (error instanceof SyntaxError) message = locale === "zh-CN" ? "输入的 JSON 无效。" : error.message;
  else if (error instanceof Error && error.name === "KokoroServerError") message = error.message;
  else if (error instanceof Error && locale === "en") message = error.message;
  else if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    message = code ? `操作失败（${code}）。` : "操作失败。";
  }
  try {
    assertCredentialFree(message, "CLI failure output");
  } catch {
    message =
      locale === "zh-CN" ? "操作失败；错误详情包含受保护内容。" : "Operation failed; details were protected.";
  }
  return `kokoro: ${message}\n`;
}

function requiredOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value) {
    throw new CliUserError(`Missing required option: ${name}`, `缺少必需选项：${name}`);
  }
  return value;
}

class CliUserError extends Error {
  readonly zhCN: string;

  constructor(message: string, zhCN: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliUserError";
    this.zhCN = zhCN;
  }
}

function optionalOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function withoutOption(argv: readonly string[], name: string): string[] {
  const output = [...argv];
  const index = output.indexOf(name);
  if (index >= 0) output.splice(index, 2);
  return output;
}

export function cliLocale(value: string | undefined): CliLocale {
  if (value === undefined || value === "en") return "en";
  if (value === "zh-CN") return "zh-CN";
  throw new Error(`Unsupported CLI locale: ${value}`);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function prepareUnixSocket(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directoryInfo = await stat(directory);
  if (!directoryInfo.isDirectory()) {
    throw new CliUserError("IPC parent is not a directory.", "IPC 父路径不是目录。");
  }
  if (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()) {
    throw new CliUserError("IPC parent is not owned by the current user.", "IPC 父目录不属于当前用户。");
  }
  if ((directoryInfo.mode & 0o077) !== 0) {
    throw new CliUserError(
      "IPC parent must not be accessible by group or other users.",
      "IPC 父目录不得允许用户组或其他用户访问。",
    );
  }
  const ownerUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  try {
    const existing = await lstat(socketPath, { bigint: true });
    if (!existing.isSocket()) {
      throw new CliUserError(
        "Refusing to replace a non-socket IPC path.",
        "拒绝替换不是 socket 的 IPC 路径。",
      );
    }
    if (ownerUid !== undefined && existing.uid !== ownerUid) {
      throw new CliUserError(
        "Refusing to replace an IPC socket owned by another user.",
        "拒绝替换属于其他用户的 IPC socket。",
      );
    }
    if (await unixSocketAcceptsConnections(socketPath)) {
      throw new CliUserError("Refusing to replace a live IPC socket.", "拒绝替换仍在监听的 IPC socket。");
    }
    const current = await lstat(socketPath, { bigint: true });
    if (
      !current.isSocket() ||
      current.dev !== existing.dev ||
      current.ino !== existing.ino ||
      (ownerUid !== undefined && current.uid !== ownerUid)
    ) {
      throw new CliUserError(
        "IPC socket changed while its stale state was checked.",
        "检查失效状态期间 IPC socket 已发生变化。",
      );
    }
    await rm(socketPath, { force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeOwnedUnixSocket(
  socketPath: string,
  expected: { dev: bigint; ino: bigint },
): Promise<void> {
  const ownerUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  try {
    const current = await lstat(socketPath, { bigint: true });
    if (
      !current.isSocket() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      (ownerUid !== undefined && current.uid !== ownerUid)
    ) {
      throw new CliUserError(
        "Refusing to remove an IPC path that replaced Kokoro's bound socket.",
        "拒绝删除已经替换 Kokoro 绑定 socket 的 IPC 路径。",
      );
    }
    await rm(socketPath, { force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unixSocketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new CliUserError("Timed out while checking an existing IPC socket.", "检查现有 IPC socket 时超时。"),
      );
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

function localPeerIdentity(): string {
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    return `unix-owner-uid:${process.getuid()}`;
  }
  const domain = process.env["USERDOMAIN"] ?? "local";
  const user = process.env["USERNAME"] ?? "current-user";
  return `windows-default-dacl:${domain}\\${user}`;
}
