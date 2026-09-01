import { writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  type AuthorizationPolicy,
  type ByteConnection,
  createExactCredentialGuard,
  type JsonValue,
  KokoroRuntime,
  type ModelCallContext,
  type ModelCapability,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  NO_CREDENTIAL_GUARDS,
  type ProtocolConnection,
  ProtocolServer,
  type RuntimeTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "../../src/index.js";

const MODEL = { provider: "process-control", model: "fixture-model" } as const;
const PERSONA_ID = "process-control-persona";
const root = requiredEnvironment("KOKORO_CONTROL_ROOT");
const socketPath = requiredEnvironment("KOKORO_CONTROL_SOCKET");
const mode = requiredEnvironment("KOKORO_CONTROL_MODE");
const credential = requiredEnvironment("KOKORO_CONTROL_CREDENTIAL");
const locale = requiredEnvironment("KOKORO_CONTROL_LOCALE") === "zh-CN" ? "zh-CN" : "en";
const released = new Set<string>();
const gateResolvers = new Map<string, () => void>();
let hold: ReturnType<typeof setInterval> | undefined;
let runtime: KokoroRuntime | undefined;
let protocol: ProtocolServer | undefined;
let server: Server | undefined;
const connections = new Set<ProtocolConnection>();

function trace(point: string): void {
  process.send?.({ kind: "trace", point });
}

function gate(name: string): Promise<void> {
  if (released.delete(name)) return Promise.resolve();
  return new Promise<void>((resolve) => gateResolvers.set(name, resolve));
}

function release(name: string): void {
  const resolve = gateResolvers.get(name);
  if (!resolve) {
    released.add(name);
    return;
  }
  gateResolvers.delete(name);
  resolve();
}

class ControlProvider implements ModelProvider {
  readonly id = MODEL.provider;
  readonly credentialGuards;
  readonly #roleCalls = new Map<string, number>();
  readonly #credential: string;

  constructor(secret: string) {
    this.#credential = secret;
    this.credentialGuards = Object.freeze([createExactCredentialGuard(() => this.#credential)]);
  }

  listModels(): readonly ModelCapability[] {
    return [
      {
        ...MODEL,
        displayName: "Process control fixture",
        contextWindow: 256_000,
        maxOutputTokens: 2_048,
        reasoning: false,
        authenticated: this.#credential.length > 0,
      },
    ];
  }

  async complete(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse> {
    const roleIndex = this.#roleCalls.get(request.role) ?? 0;
    this.#roleCalls.set(request.role, roleIndex + 1);
    if (request.role === "persona") {
      if (mode === "queue" && roleIndex === 0) {
        trace("queue_provider_waiting");
        await gate("queue_provider");
      }
      if (mode === "force_provider" && roleIndex === 0) {
        trace("force_provider_waiting");
        await gate("force_provider");
        context.emit({ type: "reasoning_delta", delta: "late process Provider stream" });
        trace("force_provider_returned");
        return response("late process Provider response");
      }
      if (mode === "force_tool" && roleIndex === 0) {
        return response("", [{ id: "provider-late-tool", name: "process_late_repository", arguments: {} }]);
      }
      if (mode === "callback" && roleIndex === 0) {
        return response("", [
          { id: "provider-denied", name: "process_denied", arguments: {} },
          { id: "provider-callback-failed", name: "process_callback", arguments: {} },
        ]);
      }
      if (mode === "callback" && roleIndex === 1) {
        return response("", [{ id: "provider-callback-succeeded", name: "process_callback", arguments: {} }]);
      }
      return response(`private process thought ${roleIndex}`);
    }
    if (request.role === "closeout") {
      return response(JSON.stringify({ summary: `process ${mode} event`, memory: "none" }));
    }
    if (request.role === "compaction") return response('{"summary":"process compact"}');
    return response('{"operations":[]}');
  }
}

const callbackTool: RuntimeTool = {
  name: "process_callback",
  effect: "external",
  credentialGuards: NO_CREDENTIAL_GUARDS,
  describe: () => ({
    name: "process_callback",
    label: "Process callback",
    description: "Returns a receipt and waits for a callback.",
    inputSchema: { type: "object", additionalProperties: false },
  }),
  validate: requireNoArguments,
  async execute(): Promise<ToolExecutionResult> {
    return { content: "process callback accepted", details: { receipt: "process" }, callbackPending: true };
  },
};

const deniedTool: RuntimeTool = {
  name: "process_denied",
  effect: "external",
  credentialGuards: NO_CREDENTIAL_GUARDS,
  describe: () => ({
    name: "process_denied",
    label: "Process denied",
    description: "Must be denied before dispatch.",
    inputSchema: { type: "object", additionalProperties: false },
  }),
  validate: requireNoArguments,
  async execute(): Promise<ToolExecutionResult> {
    throw new Error("Denied process Tool was dispatched.");
  },
};

const lateRepositoryTool: RuntimeTool = {
  name: "process_late_repository",
  effect: "repository",
  credentialGuards: NO_CREDENTIAL_GUARDS,
  describe: () => ({
    name: "process_late_repository",
    label: "Late process repository write",
    description: "Ignores cancellation until released by the parent process.",
    inputSchema: { type: "object", additionalProperties: false },
  }),
  validate: requireNoArguments,
  async execute(
    _arguments: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    trace("force_tool_waiting");
    await gate("force_tool");
    try {
      const document = await context.repository.writeText(
        "workspace/persona/late-process-tool.md",
        "late process Tool write\n",
        null,
      );
      return { content: document.content, details: { path: document.path } };
    } finally {
      trace("force_tool_settled");
    }
  },
};

const authorization: AuthorizationPolicy = {
  credentialGuards: NO_CREDENTIAL_GUARDS,
  authorize(request) {
    return request.toolName === deniedTool.name
      ? { allow: false, revision: "process-denial-v1", reason: "process fixture denial" }
      : { allow: true, revision: "process-approval-v1" };
  },
};

function requireNoArguments(arguments_: Record<string, JsonValue>): void {
  if (Object.keys(arguments_).length !== 0) throw new Error("Process fixture Tool accepts no arguments.");
}

async function main(): Promise<void> {
  hold = setInterval(() => undefined, 60_000);
  runtime = await KokoroRuntime.open({
    stateDirectory: path.join(root, "state"),
    personaDirectory: path.join(root, "personas"),
    providers: [new ControlProvider(credential)],
    tools: [callbackTool, deniedTool, lateRepositoryTool],
    authorization,
    defaultModel: MODEL,
  });
  const persona = await runtime.createPersona({
    personaId: PERSONA_ID,
    displayName: locale === "zh-CN" ? "进程边界 Persona" : "Process boundary Persona",
    uiLocale: locale,
    promptLocale: locale,
  });
  await writeFile(
    path.join(persona.repositoryPath, "workspace", "persona", "persona.md"),
    locale === "zh-CN"
      ? "# Persona\n\n验证真实子进程边界。\n"
      : "# Persona\n\nExercise real child-process boundaries.\n",
    "utf8",
  );
  const initialized = await runtime.initialize(persona.id);
  protocol = new ProtocolServer(runtime);
  server = createServer((socket) => {
    socket.pause();
    const connection = new SocketByteConnection(socket);
    void protocol?.attach(connection).then(
      (attached) => {
        connections.add(attached);
        socket.once("close", () => connections.delete(attached));
        socket.resume();
      },
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen({ path: socketPath }, resolve);
  });
  process.on("message", (message: unknown) => {
    if (!isRecord(message)) return;
    if (message["kind"] === "release" && typeof message["gate"] === "string") {
      release(message["gate"]);
    } else if (message["kind"] === "barrier" && typeof message["id"] === "string") {
      const id = message["id"];
      setImmediate(() => process.send?.({ kind: "barrier", id }));
    } else if (message["kind"] === "shutdown") {
      void shutdown();
    }
  });
  process.send?.({
    kind: "ready",
    socketPath,
    personaId: persona.id,
    repositoryPath: persona.repositoryPath,
    checkpoint: initialized.currentCheckpoint,
  });
}

async function shutdown(): Promise<void> {
  const activeServer = server;
  const serverClosed = activeServer
    ? new Promise<void>((resolve) => activeServer.close(() => resolve()))
    : Promise.resolve();
  await protocol?.close();
  await serverClosed;
  await runtime?.close();
  if (hold) clearInterval(hold);
  process.send?.({ kind: "stopped" });
  setImmediate(() => process.exit(0));
}

class SocketByteConnection implements ByteConnection {
  readonly peerIdentity = "process-control-parent";
  readonly #socket: Socket;
  readonly #data = new Set<(chunk: Uint8Array) => void>();
  readonly #close = new Set<() => void>();

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      const retained = Uint8Array.from(chunk);
      for (const listener of this.#data) listener(retained);
    });
    socket.once("close", () => {
      for (const listener of this.#close) listener();
    });
  }

  send(frame: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
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

function response(text: string, toolCalls: ModelResponse["toolCalls"] = []): ModelResponse {
  return { text, toolCalls, stopReason: toolCalls.length > 0 ? "tool" : "stop" };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  process.send?.({
    kind: "error",
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
