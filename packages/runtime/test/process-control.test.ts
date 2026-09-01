import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KokoroClient } from "@kokoro/client";
import { KokoroServerError } from "@kokoro/client";
import { connectNodeSocket } from "@kokoro/client/node";
import type { ObservationRecord, PersonaSnapshot } from "@kokoro/protocol";
import { afterEach, describe, expect, it } from "vitest";

const worker = fileURLToPath(new URL("./fixtures/control-worker.ts", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();
const harnesses = new Set<ProcessHarness>();
let sequence = 0;

type Mode = "queue" | "force_provider" | "force_tool" | "callback" | "locale";

interface ReadyMessage {
  kind: "ready";
  socketPath: string;
  personaId: string;
  repositoryPath: string;
  checkpoint: string;
}

interface ProcessHarness {
  root: string;
  credential: string;
  child: ChildProcess;
  client: KokoroClient;
  ready: ReadyMessage;
  messages: unknown[];
  stdout: () => string;
  stderr: () => string;
}

afterEach(async () => {
  for (const harness of harnesses) await closeHarness(harness);
  harnesses.clear();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Kokoro real-process control and protocol conformance", () => {
  it("pauses, resumes, and drains Stop through the public socket without losing frozen FIFO work", async () => {
    const harness = await startHarness("queue", "en");
    const { client, ready } = harness;
    await start(client, ready.personaId);
    await waitForMessage(
      harness,
      (message) => message["kind"] === "trace" && message["point"] === "queue_provider_waiting",
    );
    await client.submitStimulus({
      personaId: ready.personaId,
      idempotencyKey: "process-stimulus-1",
      stimulus: {
        kind: "user_message",
        content: { ordinal: 1 },
        occurredAt: null,
        source: "process-test",
      },
    });
    await client.submitStimulus({
      personaId: ready.personaId,
      idempotencyKey: "process-stimulus-2",
      stimulus: {
        kind: "user_message",
        content: { ordinal: 2 },
        occurredAt: null,
        source: "process-test",
      },
    });
    await client.pause(ready.personaId, { expectedRevision: null });
    harness.child.send({ kind: "release", gate: "queue_provider" });
    const paused = await waitForPersona(harness, (persona) => persona.phase === "paused");
    expect(paused.queue).toHaveLength(2);
    expect(paused.queue.every((item) => item.state === "frozen_by_pause")).toBe(true);

    await client.resume(ready.personaId, { expectedRevision: null });
    await client.stop(ready.personaId, { expectedRevision: null, timeoutMs: 45_000 });
    const stopped = await waitForPersona(harness, (persona) => persona.phase === "stopped");
    expect(stopped.queue).toEqual([]);
    const observations = await allObservations(harness);
    expect(observations.filter((record) => record.observation.kind === "event_committed")).toHaveLength(3);
    expectCredentialAbsent(harness, observations);
  }, 90_000);

  it.each([
    ["force_provider", "force_provider_waiting", "force_provider", "force_provider_returned"],
    ["force_tool", "force_tool_waiting", "force_tool", "force_tool_settled"],
  ] as const)(
    "Force fences late facts and files from an uncooperative %s child-process boundary",
    async (mode, waitingPoint, gate, settledPoint) => {
      const harness = await startHarness(mode, "en");
      const { client, ready } = harness;
      await start(client, ready.personaId);
      await waitForMessage(
        harness,
        (message) => message["kind"] === "trace" && message["point"] === waitingPoint,
      );
      const ownerEdit = path.join(ready.repositoryPath, "workspace", "persona", "force-owner-edit.md");
      if (mode === "force_provider") {
        await writeFile(ownerEdit, "Force must discard this process edit.\n", "utf8");
      }

      await client.force(ready.personaId, { expectedRevision: null, timeoutMs: 10_000 });
      const forced = await waitForPersona(harness, (persona) => persona.phase === "stopped");
      expect(forced.currentCheckpointId).toBe(ready.checkpoint);
      expect(forced.workingTree.state).toBe("clean");
      if (mode === "force_provider") await expect(access(ownerEdit)).rejects.toBeDefined();
      const factsAfterForce = await allObservations(harness);

      harness.child.send({ kind: "release", gate });
      await waitForMessage(
        harness,
        (message) => message["kind"] === "trace" && message["point"] === settledPoint,
      );
      await childBarrier(harness);

      expect(await allObservations(harness)).toEqual(factsAfterForce);
      expect((await currentPersona(harness)).workingTree.state).toBe("clean");
      if (mode === "force_tool") {
        await expect(
          access(path.join(ready.repositoryPath, "workspace", "persona", "late-process-tool.md")),
        ).rejects.toBeDefined();
      }
      expectCredentialAbsent(harness, factsAfterForce);
    },
  );

  it("keeps denied authorization and failed/succeeded callbacks attached to their original ToolCalls", async () => {
    const harness = await startHarness("callback", "en");
    const { client, ready } = harness;
    await start(client, ready.personaId);
    const firstWaiting = await waitForPersona(
      harness,
      (persona) => persona.waiting?.kind === "tool_callback",
    );
    const firstCall = firstWaiting.waiting?.kind === "tool_callback" ? firstWaiting.waiting.toolCallId : "";
    await client.submitCallback({
      personaId: ready.personaId,
      toolCallId: firstCall,
      callbackId: "process-callback-failed",
      outcome: {
        state: "failed",
        error: {
          code: "permission_denied",
          message: "Process callback denied.",
          retryable: false,
          details: null,
        },
      },
    });
    const secondWaiting = await waitForPersona(
      harness,
      (persona) => persona.waiting?.kind === "tool_callback" && persona.waiting.toolCallId !== firstCall,
    );
    const secondCall =
      secondWaiting.waiting?.kind === "tool_callback" ? secondWaiting.waiting.toolCallId : "";
    await client.submitCallback({
      personaId: ready.personaId,
      toolCallId: secondCall,
      callbackId: "process-callback-succeeded",
      outcome: { state: "succeeded", result: { approved: true } },
    });
    const observations = await waitForObservations(harness, (records) =>
      records.some((record) => record.observation.kind === "event_committed"),
    );
    await client.stop(ready.personaId, { expectedRevision: null });
    await waitForPersona(harness, (persona) => persona.phase === "stopped");

    const dispatches = observations
      .map((record) => record.observation)
      .filter((observation) => observation.kind === "tool_dispatch");
    expect(dispatches).toContainEqual(
      expect.objectContaining({
        state: "blocked",
        authority: expect.arrayContaining([expect.objectContaining({ allowed: false })]),
      }),
    );
    expect(dispatches).toContainEqual(
      expect.objectContaining({
        state: "dispatched",
        authority: expect.arrayContaining([expect.objectContaining({ allowed: true })]),
      }),
    );
    expect(
      observations
        .map((record) => record.observation)
        .filter((observation) => observation.kind === "tool_callback")
        .map((observation) => observation.outcome.state),
    ).toEqual(["failed", "succeeded"]);
    expectCredentialAbsent(harness, observations);
  });

  it("returns a zh-CN visible lifecycle error without exposing the process credential", async () => {
    const harness = await startHarness("locale", "zh-CN");
    let caught: unknown;
    try {
      await harness.client.resume(harness.ready.personaId, { expectedRevision: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KokoroServerError);
    expect(caught).toMatchObject({ error: { code: "invalid_state" } });
    expect((caught as Error).message).toMatch(/不能执行/u);
    expectCredentialAbsent(harness, caught);
  });
});

async function startHarness(mode: Mode, locale: "en" | "zh-CN"): Promise<ProcessHarness> {
  const temporaryParent = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = await mkdtemp(path.join(temporaryParent, "kokoro-process-control-"));
  roots.push(root);
  if (process.platform !== "win32") await chmod(root, 0o700);
  const id = ++sequence;
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\kokoro-process-control-${process.pid}-${id}`
      : path.join(root, "control.sock");
  const credential = `sk-process-boundary-${process.pid}-${id}-abcdefghijklmnop`;
  const child = fork(worker, [], {
    env: {
      ...process.env,
      KOKORO_CONTROL_ROOT: root,
      KOKORO_CONTROL_SOCKET: socketPath,
      KOKORO_CONTROL_MODE: mode,
      KOKORO_CONTROL_LOCALE: locale,
      KOKORO_CONTROL_CREDENTIAL: credential,
    },
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  const messages: unknown[] = [];
  let stdout = "";
  let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const partial = { root, credential, child, messages, stdout: () => stdout, stderr: () => stderr };
  const ready = (await waitForMessage(
    partial,
    (message) => message["kind"] === "ready",
  )) as unknown as ReadyMessage;
  const client = await connectNodeSocket({
    clientName: "process-control-test",
    clientVersion: "0.1.0",
    socket: { path: ready.socketPath, connectTimeoutMs: 10_000 },
    requestTimeoutMs: 30_000,
  });
  const harness = { ...partial, client, ready };
  harnesses.add(harness);
  return harness;
}

async function closeHarness(harness: ProcessHarness): Promise<void> {
  harnesses.delete(harness);
  harness.client.dispose();
  if (harness.child.exitCode !== null || harness.child.signalCode !== null) return;
  harness.child.send({ kind: "shutdown" });
  try {
    await waitForExit(harness.child, 5_000);
  } catch {
    const exited = once(harness.child, "exit");
    harness.child.kill("SIGKILL");
    await exited;
  }
  children.delete(harness.child);
}

async function start(client: KokoroClient, personaId: string): Promise<void> {
  await client.start(
    {
      personaId,
      from: { kind: "current_working_tree" },
      model: null,
      promptLocale: null,
    },
    { expectedRevision: null },
  );
}

async function currentPersona(harness: ProcessHarness): Promise<PersonaSnapshot> {
  try {
    await harness.client.refreshSnapshot({ expectedRevision: null });
  } catch (error) {
    throw new Error(
      `Could not refresh process authority. messages=${JSON.stringify(harness.messages)} stderr=${harness.stderr()}`,
      { cause: error },
    );
  }
  const persona = harness.client.snapshot?.personas.find(
    (candidate) => candidate.personaId === harness.ready.personaId,
  );
  if (!persona) throw new Error("Process Persona is missing from the authority snapshot.");
  return persona;
}

async function waitForPersona(
  harness: ProcessHarness,
  accept: (persona: PersonaSnapshot) => boolean,
): Promise<PersonaSnapshot> {
  const deadline = Date.now() + 30_000;
  let persona = await currentPersona(harness);
  while (!accept(persona)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Persona: ${JSON.stringify(persona)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    persona = await currentPersona(harness);
  }
  return persona;
}

async function allObservations(harness: ProcessHarness): Promise<ObservationRecord[]> {
  return (
    await harness.client.observations({
      personaId: harness.ready.personaId,
      afterCursor: null,
      limit: 1_000,
      kinds: null,
    })
  ).observations.slice();
}

async function waitForObservations(
  harness: ProcessHarness,
  accept: (records: ObservationRecord[]) => boolean,
): Promise<ObservationRecord[]> {
  const deadline = Date.now() + 30_000;
  let records = await allObservations(harness);
  while (!accept(records)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for observations: ${JSON.stringify(records)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    records = await allObservations(harness);
  }
  return records;
}

async function waitForMessage(
  harness: Pick<ProcessHarness, "child" | "messages" | "stderr">,
  accept: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const existing = harness.messages.find((message) => isRecord(message) && accept(message));
  if (isRecord(existing)) return existing;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child message. stderr: ${harness.stderr()}`));
    }, 30_000);
    const onMessage = (message: unknown) => {
      if (!isRecord(message)) return;
      if (message["kind"] === "error") {
        cleanup();
        reject(new Error(`Process worker failed: ${String(message["message"])}\n${harness.stderr()}`));
      } else if (accept(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Process worker exited early (${code ?? signal}). stderr: ${harness.stderr()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      harness.child.off("message", onMessage);
      harness.child.off("exit", onExit);
    };
    harness.child.on("message", onMessage);
    harness.child.once("exit", onExit);
  });
}

async function childBarrier(harness: ProcessHarness): Promise<void> {
  const id = `barrier-${++sequence}`;
  harness.child.send({ kind: "barrier", id });
  await waitForMessage(harness, (message) => message["kind"] === "barrier" && message["id"] === id);
}

function expectCredentialAbsent(harness: ProcessHarness, facts: unknown): void {
  const surfaces = [
    harness.stdout(),
    harness.stderr(),
    JSON.stringify(harness.messages),
    JSON.stringify(facts),
  ];
  for (const surface of surfaces) expect(surface).not.toContain(harness.credential);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Process control worker did not stop."));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}
