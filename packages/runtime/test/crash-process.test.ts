import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  KokoroRuntime,
  type ModelCallContext,
  type ModelCapability,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  NO_CREDENTIAL_GUARDS,
  PersonaRepository,
} from "../src/index.js";

const MODEL = { provider: "crash-fixture", model: "fixture-model" } as const;
const PERSONA_ID = "process-crash-persona";
const worker = fileURLToPath(new URL("./fixtures/crash-worker.ts", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();
const runtimes = new Set<KokoroRuntime>();

class RecoveryProvider implements ModelProvider {
  readonly id = MODEL.provider;
  readonly credentialGuards = NO_CREDENTIAL_GUARDS;
  calls = 0;

  listModels(): readonly ModelCapability[] {
    return [
      {
        ...MODEL,
        displayName: "Process recovery fixture",
        contextWindow: 256_000,
        maxOutputTokens: 2_048,
        reasoning: false,
        authenticated: true,
      },
    ];
  }

  async complete(request: ModelRequest, _context: ModelCallContext): Promise<ModelResponse> {
    this.calls += 1;
    if (request.role !== "hippocampus") throw new Error(`Unexpected recovered ${request.role} call`);
    return {
      text: JSON.stringify({
        operations: [
          {
            kind: "create",
            path: "workspace/memory/2026-08-30/process-crash.md",
            content: "# Recovered memory\n\nInstalled exactly once across a process crash.\n",
          },
        ],
      }),
      toolCalls: [],
      stopReason: "stop",
    };
  }
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const runtime of runtimes) await runtime.close();
  runtimes.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("KokoroRuntime real-process crash conformance", () => {
  it.each(["checkpoint_ref_advanced", "publication_completed"] as const)(
    "reconciles %s without restoring the queue or duplicating publication",
    async (mode) => {
      const root = await crashAt(mode);
      const provider = new RecoveryProvider();
      const runtime = await recover(root, provider);
      const events = runtime.store.listEvents(PERSONA_ID);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "checkpointed", memoryDecision: "none" });
      expect(runtime.store.publications(PERSONA_ID)).toHaveLength(1);
      expect(runtime.store.listQueue(events[0]?.runId as string)).toEqual([
        expect.objectContaining({ status: "discarded" }),
      ]);
      expect(runtime.store.requireRun(events[0]?.runId as string).phase).toBe("crashed");
      expect(provider.calls).toBe(0);
      const repository = await PersonaRepository.open(
        runtime.store.requirePersona(PERSONA_ID).repositoryPath,
      );
      expect(await repository.listCheckpoints()).toHaveLength(2);
      expect(
        runtime.store.observations(PERSONA_ID).filter((observation) => observation.kind === "publication"),
      ).toHaveLength(1);
    },
  );

  it("derives and completes missing Hippocampus work from committed authority", async () => {
    const root = await crashAt("hippocampus_job_created");
    const provider = new RecoveryProvider();
    const runtime = await recover(root, provider);
    const jobs = await waitFor(
      () => runtime.store.listHippocampusJobs(PERSONA_ID),
      (value) => value.length === 1 && value[0]?.status === "completed",
      "recovered Hippocampus completion",
    );
    expect(jobs[0]).toMatchObject({ attempts: 1, status: "completed" });
    expect(provider.calls).toBe(1);
    expect(
      await readFile(
        path.join(
          runtime.store.requirePersona(PERSONA_ID).repositoryPath,
          "workspace",
          "memory",
          "2026-08-30",
          "process-crash.md",
        ),
        "utf8",
      ),
    ).toContain("Installed exactly once");
  });

  it("recognizes a whole-tree Memory replacement that survived process death", async () => {
    const root = await crashAt("memory_replacement_moved");
    const provider = new RecoveryProvider();
    const runtime = await recover(root, provider);
    expect(runtime.store.listHippocampusJobs(PERSONA_ID)).toEqual([
      expect.objectContaining({ attempts: 1, status: "completed" }),
    ]);
    expect(provider.calls).toBe(0);
    const memoryPath = path.join(
      runtime.store.requirePersona(PERSONA_ID).repositoryPath,
      "workspace",
      "memory",
      "2026-08-30",
      "process-crash.md",
    );
    expect(await readFile(memoryPath, "utf8")).toContain("Installed exactly once");
  });

  it("marks an interrupted external dispatch unknown and never replays it", async () => {
    const root = await crashAt("external_tool_dispatch");
    const provider = new RecoveryProvider();
    const runtime = await recover(root, provider);
    const calls = runtime.store.toolCallsForPersona(PERSONA_ID);
    expect(calls).toEqual([
      expect.objectContaining({
        name: "crash_external",
        status: "unknown",
        result: null,
      }),
    ]);
    expect(provider.calls).toBe(0);
    expect(runtime.store.publications(PERSONA_ID)).toHaveLength(0);
    expect(
      runtime.store
        .observations(PERSONA_ID)
        .filter((observation) => observation.kind === "tool_outcome")
        .map((observation) => observation.payload),
    ).toEqual([expect.objectContaining({ state: "unknown", externalEffect: "unknown" })]);
  });
});

async function crashAt(mode: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kokoro-process-crash-"));
  roots.push(root);
  const child = fork(worker, [], {
    env: { ...process.env, KOKORO_CRASH_ROOT: root, KOKORO_CRASH_MODE: mode },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  let stderr = "";
  const trace: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Timed out waiting for child ${mode}. trace: ${trace.join(", ")}. stderr: ${stderr}`),
        ),
      30_000,
    );
    child.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message["kind"] === "trace") trace.push(String(message["point"]));
      if (message["kind"] === "ready" && message["point"] === mode) {
        clearTimeout(timer);
        resolve();
      } else if (message["kind"] === "error") {
        clearTimeout(timer);
        reject(new Error(`Crash worker failed: ${String(message["message"])}\n${stderr}`));
      }
    });
    child.once("exit", (code, signal) => {
      if (child.killed) return;
      clearTimeout(timer);
      reject(new Error(`Crash worker exited early (${code ?? signal}). stderr: ${stderr}`));
    });
  });
  if (!child.kill("SIGKILL")) throw new Error(`Could not terminate crash worker ${mode}`);
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Crash worker ${mode} did not terminate`)), 10_000),
    ),
  ]);
  children.delete(child);
  return root;
}

async function recover(root: string, provider: ModelProvider): Promise<KokoroRuntime> {
  const runtime = await KokoroRuntime.open({
    stateDirectory: path.join(root, "state"),
    personaDirectory: path.join(root, "personas"),
    providers: [provider],
    defaultModel: MODEL,
  });
  runtimes.add(runtime);
  return runtime;
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 15_000;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await read();
  }
  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
