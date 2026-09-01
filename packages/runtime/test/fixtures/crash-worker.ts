import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type JsonValue,
  KokoroRuntime,
  type MemoryTransactionFaultPoint,
  type ModelCallContext,
  type ModelCapability,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  NO_CREDENTIAL_GUARDS,
  type RuntimeTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "../../src/index.js";

const MODEL = { provider: "crash-fixture", model: "fixture-model" } as const;
const PERSONA_ID = "process-crash-persona";
const root = requiredEnvironment("KOKORO_CRASH_ROOT");
const mode = requiredEnvironment("KOKORO_CRASH_MODE");
let readySent = false;

function reportReady(point: string): void {
  if (readySent) return;
  readySent = true;
  process.send?.({ kind: "ready", point });
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}

class CrashProvider implements ModelProvider {
  readonly id = MODEL.provider;
  readonly credentialGuards = NO_CREDENTIAL_GUARDS;

  listModels(): readonly ModelCapability[] {
    return [
      {
        ...MODEL,
        displayName: "Process crash fixture",
        contextWindow: 256_000,
        maxOutputTokens: 2_048,
        reasoning: false,
        authenticated: true,
      },
    ];
  }

  async complete(request: ModelRequest, _context: ModelCallContext): Promise<ModelResponse> {
    process.send?.({ kind: "trace", point: `model:${request.role}` });
    if (request.role === "persona") {
      if (mode === "external_tool_dispatch") {
        return response("", [
          { id: "provider-external-call", name: "crash_external", arguments: { value: "effect" } },
        ]);
      }
      return response("A private process-crash fixture thought.");
    }
    if (request.role === "closeout") {
      return response(
        JSON.stringify({
          summary: `Durable boundary ${mode}`,
          memory:
            mode === "hippocampus_job_created" || mode === "memory_replacement_moved" ? "maintain" : "none",
        }),
      );
    }
    if (request.role === "hippocampus") {
      return response(
        JSON.stringify({
          operations: [
            {
              kind: "create",
              path: "workspace/memory/2026-08-30/process-crash.md",
              content: "# Recovered memory\n\nInstalled exactly once across a process crash.\n",
            },
          ],
        }),
      );
    }
    return response('{"summary":"Compacted crash fixture history."}');
  }
}

const crashingTool: RuntimeTool = {
  name: "crash_external",
  effect: "external",
  credentialGuards: NO_CREDENTIAL_GUARDS,
  describe: () => ({
    name: "crash_external",
    label: "Crash external effect",
    description: "Waits at the exact external dispatch crash boundary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
  }),
  validate(arguments_: Record<string, JsonValue>): void {
    if (arguments_["value"] !== "effect" || Object.keys(arguments_).length !== 1) {
      throw new Error("invalid fixture arguments");
    }
  },
  async execute(
    _arguments: Record<string, JsonValue>,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    reportReady("external_tool_dispatch");
    return never();
  },
};

async function main(): Promise<void> {
  // A pending Promise alone does not keep Node alive. Hold one real event-loop
  // handle so the parent, rather than natural process exit, owns the crash edge.
  setInterval(() => undefined, 60_000);
  const targetEventFault =
    mode === "checkpoint_ref_advanced" ||
    mode === "publication_completed" ||
    mode === "hippocampus_job_created"
      ? mode
      : undefined;
  const targetMemoryFault: MemoryTransactionFaultPoint | undefined =
    mode === "memory_replacement_moved" ? "after_replacement_moved" : undefined;
  const runtime = await KokoroRuntime.open({
    stateDirectory: path.join(root, "state"),
    personaDirectory: path.join(root, "personas"),
    providers: [new CrashProvider()],
    tools: mode === "external_tool_dispatch" ? [crashingTool] : [],
    defaultModel: MODEL,
    ...(targetEventFault === undefined
      ? {}
      : {
          eventFault: async (point) => {
            if (point !== targetEventFault) return;
            reportReady(point);
            await never();
          },
        }),
    ...(targetMemoryFault === undefined
      ? {}
      : {
          memoryFault: async (point: MemoryTransactionFaultPoint) => {
            process.send?.({ kind: "trace", point: `memory:${point}` });
            if (point !== targetMemoryFault) return;
            reportReady(mode);
            await never();
          },
        }),
  });
  const persona = await runtime.createPersona({
    personaId: PERSONA_ID,
    displayName: "Process crash Persona",
    uiLocale: "en",
    promptLocale: "en",
  });
  await writeFile(
    path.join(persona.repositoryPath, "workspace", "persona", "persona.md"),
    "# Persona\n\nExercise durable process crash boundaries.\n",
    "utf8",
  );
  await runtime.initialize(persona.id);
  await runtime.start({ personaId: persona.id });
  await never();
}

function response(text: string, toolCalls: ModelResponse["toolCalls"] = []): ModelResponse {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool" : "stop",
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

void main().catch((error: unknown) => {
  process.send?.({
    kind: "error",
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
});
