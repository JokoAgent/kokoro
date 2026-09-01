import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Observation } from "@kokoro/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthorizationDecision,
  type AuthorizationPolicy,
  type CredentialGuard,
  createExactCredentialGuard,
  type JsonValue,
  KokoroRuntime,
  type MemoryTransactionFaultPoint,
  type MessageDelivery,
  type ModelCallContext,
  type ModelCapability,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  NO_CREDENTIAL_GUARDS,
  PersonaRepository,
  type RuntimeFaultPoint,
  type RuntimeTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "../src/index.js";
import { mapObservationFact } from "../src/protocol/index.js";

const MODEL = { provider: "scripted", model: "fixture-model" } as const;
type ProviderAttemptObservation = Extract<Observation, { kind: "provider_attempt" }>;
const sandboxes: string[] = [];
const runtimes = new Set<KokoroRuntime>();

interface ScriptCall {
  request: ModelRequest;
  context: ModelCallContext;
  roleIndex: number;
}

class ScriptedProvider implements ModelProvider {
  readonly id = MODEL.provider;
  readonly credentialGuards: readonly CredentialGuard[];
  readonly requests: ModelRequest[] = [];
  readonly #respond: (call: ScriptCall) => Promise<ModelResponse> | ModelResponse;
  readonly #capability: Partial<ModelCapability>;

  constructor(
    respond: (call: ScriptCall) => Promise<ModelResponse> | ModelResponse,
    capability: Partial<ModelCapability> = {},
    credentialGuards: readonly CredentialGuard[] = NO_CREDENTIAL_GUARDS,
  ) {
    this.#respond = respond;
    this.#capability = capability;
    this.credentialGuards = credentialGuards;
  }

  listModels(): readonly ModelCapability[] {
    return [
      {
        ...MODEL,
        displayName: "Scripted fixture model",
        contextWindow: 256_000,
        maxOutputTokens: 2_048,
        reasoning: true,
        authenticated: true,
        ...this.#capability,
      },
    ];
  }

  async complete(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse> {
    const roleIndex = this.requests.filter((candidate) => candidate.role === request.role).length;
    this.requests.push(request);
    return this.#respond({ request, context, roleIndex });
  }
}

interface RuntimeFixture {
  root: string;
  stateDirectory: string;
  personaDirectory: string;
  runtime: KokoroRuntime;
}

async function runtimeFixture(
  provider: ModelProvider,
  options: {
    tools?: readonly RuntimeTool[];
    authorization?: AuthorizationPolicy;
    messageDelivery?: MessageDelivery;
    eventFault?: (point: RuntimeFaultPoint) => Promise<void> | void;
    memoryFault?: (point: MemoryTransactionFaultPoint) => Promise<void> | void;
  } = {},
): Promise<RuntimeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "kokoro-runtime-integration-"));
  sandboxes.push(root);
  const stateDirectory = path.join(root, "state");
  const personaDirectory = path.join(root, "personas");
  const runtime = await KokoroRuntime.open({
    stateDirectory,
    personaDirectory,
    providers: [provider],
    defaultModel: MODEL,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    ...(options.messageDelivery === undefined ? {} : { messageDelivery: options.messageDelivery }),
    ...(options.eventFault === undefined ? {} : { eventFault: options.eventFault }),
    ...(options.memoryFault === undefined ? {} : { memoryFault: options.memoryFault }),
  });
  runtimes.add(runtime);
  return { root, stateDirectory, personaDirectory, runtime };
}

async function readyPersona(
  runtime: KokoroRuntime,
  locale: "en" | "zh-CN" = "en",
  id = `persona-${locale.toLowerCase().replace(/[^a-z]/gu, "-")}`,
): Promise<{ id: string; rootCheckpoint: string; repository: PersonaRepository }> {
  const persona = await runtime.createPersona({
    personaId: id,
    displayName: locale === "zh-CN" ? "测试人格" : "Test Persona",
    uiLocale: locale,
    promptLocale: locale,
  });
  const repository = await PersonaRepository.open(persona.repositoryPath);
  const personaPath = path.join(persona.repositoryPath, "workspace", "persona", "persona.md");
  await writeFile(
    personaPath,
    locale === "zh-CN"
      ? "# Persona\n\n这是 Owner 编辑后的中文 Persona。\n"
      : "# Persona\n\nThis is the owner-edited English Persona.\n",
    "utf8",
  );
  const initialized = await runtime.initialize(persona.id);
  if (initialized.currentCheckpoint === null)
    throw new Error("Fixture initialization did not create a root Checkpoint.");
  return { id: persona.id, rootCheckpoint: initialized.currentCheckpoint, repository };
}

function modelResponse(
  text: string,
  options: {
    toolCalls?: ModelResponse["toolCalls"];
    stopReason?: ModelResponse["stopReason"];
  } = {},
): ModelResponse {
  return {
    text,
    toolCalls: options.toolCalls ?? [],
    stopReason: options.stopReason ?? (options.toolCalls && options.toolCalls.length > 0 ? "tool" : "stop"),
  };
}

function schemaPropertyKeys(tool: ModelTool): string[] {
  const properties = tool.inputSchema["properties"];
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

function strictCloseout(locale: string, summary?: string): ModelResponse {
  return modelResponse(
    JSON.stringify({
      summary: summary ?? (locale === "zh-CN" ? "完成了一次中文经历。" : "Completed one private experience."),
      memory: "none",
    }),
  );
}

function ordinaryScript(text = "A private thought, not an outward message."): ScriptedProvider {
  return new ScriptedProvider(({ request }) => {
    if (request.role === "persona") return modelResponse(text);
    if (request.role === "closeout") return strictCloseout(request.promptLocale);
    if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
    return modelResponse('{"operations":[]}');
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUnlessAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await read();
  }
  return latest;
}

async function waitForPublications(runtime: KokoroRuntime, personaId: string, count: number): Promise<void> {
  await waitFor(
    () => runtime.store.publications(personaId),
    (publications) => publications.length === count,
    `${count} publication(s)`,
  );
}

function publicProviderAttempts(
  runtime: KokoroRuntime,
  personaId: string,
  role: ModelRequest["role"],
): ProviderAttemptObservation[] {
  const records = runtime
    .observations(personaId, 0, 10_000)
    .flatMap((fact) => mapObservationFact(fact, runtime.store));
  const attemptIds = new Set(
    records.flatMap((record) =>
      record.observation.kind === "model_input" && record.observation.role === role
        ? [record.observation.attemptId]
        : [],
    ),
  );
  return records.flatMap((record) =>
    record.observation.kind === "provider_attempt" && attemptIds.has(record.observation.attemptId)
      ? [record.observation]
      : [],
  );
}

afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  runtimes.clear();
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("KokoroRuntime authority projection", () => {
  it("fails closed on exact credentials in host options before opening the fact store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kokoro-runtime-host-boundary-"));
    sandboxes.push(root);
    const secret = "opaque.host.path.8b93e24d71f6";
    const stateDirectory = path.join(root, secret);
    const provider = new ScriptedProvider(() => modelResponse("unused"), {}, [
      createExactCredentialGuard(() => secret),
    ]);

    await expect(
      KokoroRuntime.open({
        stateDirectory,
        personaDirectory: path.join(root, "personas"),
        providers: [provider],
        defaultModel: MODEL,
      }),
    ).rejects.toMatchObject({ name: "CredentialBoundaryError", finding: "exact" });
    await expect(access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed before storage when AuthorizationPolicy or MessageDelivery omits its declaration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kokoro-runtime-component-boundary-"));
    sandboxes.push(root);
    const provider = ordinaryScript();
    const base = {
      personaDirectory: path.join(root, "personas"),
      providers: [provider],
      defaultModel: MODEL,
    };

    await expect(
      KokoroRuntime.open({
        ...base,
        stateDirectory: path.join(root, "authorization-state"),
        authorization: {
          authorize: () => ({ allow: true, revision: "missing-boundary" }),
        } as unknown as AuthorizationPolicy,
      }),
    ).rejects.toMatchObject({ name: "CredentialBoundaryConfigurationError" });
    await expect(access(path.join(root, "authorization-state"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      KokoroRuntime.open({
        ...base,
        stateDirectory: path.join(root, "delivery-state"),
        messageDelivery: {
          deliver: async () => ({ receipt: null }),
        } as unknown as MessageDelivery,
      }),
    ).rejects.toMatchObject({ name: "CredentialBoundaryConfigurationError" });
    await expect(access(path.join(root, "delivery-state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes only Owner Markdown and preserves CAS edits before init, after init, and during a run", async () => {
    const firstPersonaCall = deferred();
    const provider = new ScriptedProvider(async ({ request, roleIndex }) => {
      if (request.role === "persona") {
        if (roleIndex === 0) await firstPersonaCall.promise;
        return modelResponse("A private thought after reading the current Owner documents.");
      }
      if (request.role === "closeout") return strictCloseout(request.promptLocale);
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const credentialPersonaId = "sk-personacredentialabcdefghijkl";
    await expect(
      runtime.createPersona({
        personaId: credentialPersonaId,
        displayName: "Rejected Persona",
        uiLocale: "en",
        promptLocale: "en",
      }),
    ).rejects.toMatchObject({
      name: "CredentialBoundaryError",
      surface: "Persona id",
    });
    expect(runtime.store.getPersona(credentialPersonaId)).toBeUndefined();

    const persona = await runtime.createPersona({
      personaId: "owner-documents",
      displayName: "Owner Documents",
      uiLocale: "en",
      promptLocale: "en",
    });

    const draftDocuments = await runtime.ownerDocuments(persona.id);
    expect(draftDocuments.map((document) => document.path)).toEqual([
      "workspace/memory/initial.md",
      "workspace/persona/persona.md",
    ]);
    expect(JSON.stringify(draftDocuments)).not.toContain(persona.repositoryPath);
    const initialMemory = draftDocuments.find((document) => document.path === "workspace/memory/initial.md");
    if (!initialMemory) throw new Error("missing draft Memory document");
    const draftMemory = await runtime.putOwnerDocument({
      personaId: persona.id,
      path: initialMemory.path,
      content: "# Memory\n\nOwner-edited before Init.\n",
      expectedSha256: initialMemory.sha256,
    });
    expect(draftMemory.content).toContain("before Init");
    const credentialPath = "workspace/persona/sk-documentcredentialabcdefghijkl.md";
    await expect(
      runtime.putOwnerDocument({
        personaId: persona.id,
        path: credentialPath,
        content: "must not be written\n",
        expectedSha256: null,
      }),
    ).rejects.toMatchObject({
      name: "CredentialBoundaryError",
      surface: "Owner document path",
    });
    expect(await runtime.ownerDocuments(persona.id)).not.toContainEqual(
      expect.objectContaining({ path: credentialPath }),
    );
    const secret = "API_KEY=sk-examplecredential1234567890";
    const secretPath = path.join(persona.repositoryPath, "workspace", "persona", "leak.md");
    await writeFile(secretPath, `${secret}\n`, "utf8");
    await expect(runtime.ownerDocuments(persona.id)).rejects.toMatchObject({
      name: "CredentialBoundaryError",
      surface: "Owner documents",
    });
    expect(JSON.stringify(runtime.observations(persona.id, 0, 100))).not.toContain(secret);
    await rm(secretPath);
    await expect(runtime.ownerDocuments(persona.id, "workspace/persona/missing.md")).rejects.toMatchObject({
      code: "not_found",
    });

    const initialized = await runtime.initialize(persona.id);
    await expect(
      runtime.clone({
        personaId: persona.id,
        checkpoint: initialized.currentCheckpoint ?? "missing",
        newPersonaId: credentialPersonaId,
        displayName: "Rejected Clone",
      }),
    ).rejects.toMatchObject({
      name: "CredentialBoundaryError",
      surface: "Persona id",
    });
    expect(runtime.store.getPersona(credentialPersonaId)).toBeUndefined();
    const initialPersona = (await runtime.ownerDocuments(persona.id, "workspace/persona/persona.md"))[0];
    if (!initialPersona) throw new Error("missing initialized Persona document");
    const afterInit = await runtime.putOwnerDocument({
      personaId: persona.id,
      path: initialPersona.path,
      content: "# Persona\n\nOwner-edited after Init.\n",
      expectedSha256: initialPersona.sha256,
    });

    await runtime.start({ personaId: persona.id });
    await waitFor(
      () => provider.requests.filter((request) => request.role === "persona"),
      (requests) => requests.length === 1,
      "first in-flight Persona request",
    );
    const issuedRequest = provider.requests.find((request) => request.role === "persona");
    expect(JSON.stringify(issuedRequest)).not.toContain("Owner-edited while running");
    const whileRunning = await runtime.putOwnerDocument({
      personaId: persona.id,
      path: afterInit.path,
      content: "# Persona\n\nOwner-edited while running.\n",
      expectedSha256: afterInit.sha256,
    });
    await expect(
      runtime.putOwnerDocument({
        personaId: persona.id,
        path: afterInit.path,
        content: "stale overwrite\n",
        expectedSha256: afterInit.sha256,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await runtime.ownerDocuments(persona.id, afterInit.path))[0]).toEqual(whileRunning);

    firstPersonaCall.resolve();
    await waitForPublications(runtime, persona.id, 1);
    await runtime.submitStimulus({
      personaId: persona.id,
      idempotencyKey: "owner-documents-next-read",
      kind: "external_change",
      content: { path: whileRunning.path },
    });
    const laterRequests = await waitFor(
      () => provider.requests.filter((request) => request.role === "persona"),
      (requests) => requests.length >= 2,
      "next Persona request",
    );
    expect(JSON.stringify(laterRequests[1])).toContain("Owner-edited while running");
    await expect(
      runtime.putOwnerDocument({
        personaId: persona.id,
        path: "workspace/notes/not-owner.md",
        content: "not allowed\n",
        expectedSha256: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("keeps stable facts at one revision and advances only when the Owner changes the working tree", async () => {
    const { runtime } = await runtimeFixture(ordinaryScript());
    const { id, repository } = await readyPersona(runtime);

    const first = await runtime.authorityView();
    const repeated = await runtime.authorityView();
    const firstPersona = first.personas.find((view) => view.persona.id === id);

    expect(repeated).toEqual(first);
    expect(firstPersona?.workingTree).toMatchObject({ state: "clean" });
    expect(firstPersona?.workingTree.digest).toEqual(expect.any(String));

    await writeFile(
      path.join(repository.root, "workspace", "persona", "persona.md"),
      "# Persona\n\nThe Owner changed this Persona after initialization.\n",
      "utf8",
    );
    const changed = await runtime.authorityView();
    const changedPersona = changed.personas.find((view) => view.persona.id === id);

    expect(changed.revision).toBeGreaterThan(first.revision);
    expect(changedPersona?.workingTree).toMatchObject({ state: "dirty" });
    expect(changedPersona?.workingTree.digest).not.toBe(firstPersona?.workingTree.digest);
    expect(await runtime.authorityView()).toEqual(changed);
  });
});

describe("KokoroRuntime Event lifecycle and prompt behavior", () => {
  it.each(["response", "rotated_stream", "reverse_rotated_stream"] as const)(
    "rejects an opaque credential from a generic Provider %s with a fresh snapshot",
    async (surface) => {
      const secret = "opaque.output.8b93e24d71f6";
      let guardedValue = surface === "rotated_stream" ? "opaque.initial.71f6" : secret;
      const provider = new ScriptedProvider(
        async ({ request, context, roleIndex }) => {
          if (request.role === "persona") {
            if (surface !== "response") {
              const emitted = surface === "rotated_stream" ? secret : guardedValue;
              guardedValue =
                surface === "rotated_stream" ? secret : `opaque.rotated.after-call.${roleIndex}.9d31e4a2`;
              await context.emit({ type: "reasoning_delta", delta: emitted });
              return modelResponse("safe response after rejected stream");
            }
            return modelResponse(secret);
          }
          if (request.role === "closeout") return strictCloseout(request.promptLocale);
          if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
          return modelResponse('{"operations":[]}');
        },
        {},
        [createExactCredentialGuard(() => guardedValue)],
      );
      const { runtime } = await runtimeFixture(provider);
      const { id, repository } = await readyPersona(runtime, "en", `opaque-provider-${surface}`);

      const run = await runtime.start({ personaId: id });
      await waitFor(
        () => runtime.store.requireRun(run.id).phase,
        (phase) => phase === "faulted",
        `opaque Provider ${surface} rejection`,
      );

      expect(runtime.store.publications(id)).toEqual([]);
      expect(await repository.listCheckpoints()).toHaveLength(1);
      expect(
        JSON.stringify({
          run: runtime.store.requireRun(run.id),
          events: runtime.store.listEvents(id),
          observations: runtime.store.observations(id, 0, 10_000),
          requests: provider.requests,
        }),
      ).not.toContain(secret);
    },
  );

  it("rejects an exact credential introduced by an external Owner edit before checkpoint anchoring", async () => {
    const secret = "opaque.owner.checkpoint.8b93e24d71f6";
    let repositoryRoot: string | undefined;
    const provider = new ScriptedProvider(
      async ({ request }) => {
        if (request.role === "persona") {
          if (repositoryRoot === undefined) throw new Error("Repository fixture was not initialized.");
          await writeFile(
            path.join(repositoryRoot, "workspace", "persona", "external-owner-edit.md"),
            `# Owner edit\n\n${secret}\n`,
            "utf8",
          );
          return modelResponse("Safe response after the external Owner edit.");
        }
        if (request.role === "closeout") return strictCloseout(request.promptLocale);
        if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
        return modelResponse('{"operations":[]}');
      },
      {},
      [createExactCredentialGuard(() => secret)],
    );
    const { runtime } = await runtimeFixture(provider);
    const { id, repository } = await readyPersona(runtime, "en", "external-owner-checkpoint");
    repositoryRoot = repository.root;

    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => runtime.store.requireRun(run.id).phase,
      (phase) => phase === "faulted",
      "external Owner credential rejection before Checkpoint",
    );

    expect(await repository.listCheckpoints()).toHaveLength(1);
    expect(runtime.store.publications(id)).toEqual([]);
    expect(
      JSON.stringify({
        run: runtime.store.requireRun(run.id),
        events: runtime.store.listEvents(id),
        observations: runtime.store.observations(id, 0, 10_000),
        requests: provider.requests,
      }),
    ).not.toContain(secret);
  });

  it("queues and completes Hippocampus work even when the independent publication branch fails", async () => {
    const provider = new ScriptedProvider(({ request }) => {
      if (request.role === "persona") return modelResponse("A private experience that merits Memory review.");
      if (request.role === "closeout") {
        return modelResponse('{"summary":"Checkpointed before publication failed.","memory":"maintain"}');
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider, {
      eventFault(point) {
        if (point === "before_publication") throw new Error("publication branch fault");
      },
    });
    const { id } = await readyPersona(runtime);

    await runtime.start({ personaId: id });
    const [job] = await waitFor(
      () => runtime.store.listHippocampusJobs(id),
      (jobs) => jobs[0]?.status === "completed",
      "Hippocampus completion without publication",
    );

    expect(job).toMatchObject({ status: "completed", attempts: 1 });
    expect(runtime.store.publications(id)).toEqual([]);
    expect(runtime.store.pendingPublicationCount(id)).toBe(1);
    expect(runtime.store.listEvents(id)).toEqual([
      expect.objectContaining({ status: "checkpointed", memoryDecision: "maintain" }),
    ]);
    expect(runtime.store.activeRun(id)).toMatchObject({ phase: "faulted", endedAt: expect.any(Number) });
  });

  it("rerenders a compaction retry with the current Prompt locale", async () => {
    const largeThought = "x".repeat(85_000);
    const personaId = "compaction-locale-retry";
    let activeRuntime: KokoroRuntime | undefined;
    const provider = new ScriptedProvider(
      ({ request, roleIndex }) => {
        if (request.role === "persona" && roleIndex === 0) return modelResponse(largeThought);
        if (request.role === "persona") return modelResponse("派生上下文足以继续。");
        if (request.role === "closeout") return strictCloseout("zh-CN", "压缩上下文仍是派生信息。");
        if (request.role === "compaction" && roleIndex === 0) {
          activeRuntime?.setLocales({ personaId, uiLocale: null, promptLocale: "en" });
          return modelResponse('{"summary":42}');
        }
        if (request.role === "compaction") {
          return modelResponse('{"summary":"保留了大量上下文，且没有改变任何事实状态。"}');
        }
        return modelResponse('{"operations":[]}');
      },
      { contextWindow: 40_000, maxOutputTokens: 256 },
    );
    const { runtime } = await runtimeFixture(provider);
    activeRuntime = runtime;
    const { id } = await readyPersona(runtime, "zh-CN", personaId);

    const run = await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);
    await runtime.submitStimulus({
      personaId: id,
      kind: "message",
      content: { text: "请使用压缩后的上下文继续。" },
    });
    await waitForPublications(runtime, id, 2);

    const event = runtime.store.listEvents(id)[1];
    if (!event) throw new Error("Expected a committed Event.");
    const compactions = runtime.store
      .sessionEntries(run.sessionId)
      .filter((entry) => entry.kind === "compaction");
    expect(compactions).toEqual([
      expect.objectContaining({ eventId: null, payload: expect.objectContaining({ coversThrough: 3 }) }),
    ]);
    expect(runtime.store.turnsForSourceEvent(event.id)).toContainEqual(
      expect.objectContaining({ eventId: null, scope: "compaction", role: "compaction" }),
    );
    const frozen = event.frozen as { sessionEntries?: Array<{ kind?: string }> };
    expect(frozen.sessionEntries?.some((entry) => entry.kind === "compaction")).toBe(false);
    const secondPersonaRequest = provider.requests.filter((request) => request.role === "persona")[1];
    expect(
      secondPersonaRequest?.messages.some((message) => message.content.includes("derived_session_context")),
    ).toBe(true);
    const publicRecords = runtime
      .observations(id, 0, 10_000)
      .flatMap((fact) => mapObservationFact(fact, runtime.store));
    const compactionAttemptIds = new Set(
      publicRecords.flatMap((record) =>
        record.observation.kind === "model_input" && record.observation.role === "compaction"
          ? [record.observation.attemptId]
          : [],
      ),
    );
    const compactionAttempts = publicRecords.flatMap((record) =>
      record.observation.kind === "provider_attempt" && compactionAttemptIds.has(record.observation.attemptId)
        ? [record.observation]
        : [],
    );
    expect(compactionAttempts.map(({ attempt, state }) => ({ attempt, state }))).toEqual([
      { attempt: 1, state: "started" },
      { attempt: 1, state: "retry_wait" },
      { attempt: 2, state: "started" },
      { attempt: 2, state: "completed" },
    ]);
    expect(new Set(compactionAttempts.map((attempt) => attempt.turnId)).size).toBe(1);
    const compactionRequests = provider.requests.filter((request) => request.role === "compaction");
    expect(compactionRequests).toHaveLength(2);
    expect(compactionRequests[0]).toMatchObject({ promptLocale: "zh-CN", tools: [] });
    expect(compactionRequests[0]?.system).toContain("Context compaction 角色");
    expect(compactionRequests[1]).toMatchObject({ promptLocale: "en", tools: [] });
    expect(compactionRequests[1]?.system).toContain("Context compaction role");
    expect(compactionRequests[1]?.messages[0]?.content).toContain(
      "Field summary must be a non-empty string.",
    );
    expect(compactionRequests[1]?.messages[0]?.content).not.toContain("字段 summary 必须是非空字符串。");
    for (const storedEvent of runtime.store.listEvents(id)) {
      expect(JSON.stringify(compactionRequests)).not.toContain(storedEvent.id);
    }
  });

  it("publishes causal automatic retry chains across distinct Persona and closeout Turns", async () => {
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona" && roleIndex === 0) throw new Error("transient provider failure");
      if (request.role === "persona" && roleIndex === 1) {
        return modelResponse("Use one unavailable Tool to create another Persona Turn.", {
          toolCalls: [{ id: "missing-tool-call", name: "missing_tool", arguments: {} }],
        });
      }
      if (request.role === "persona") return modelResponse("The second Persona Turn is complete.");
      if (request.role === "closeout" && roleIndex === 0) {
        return modelResponse('{"summary":"invalid extra field","memory":"none","extra":true}');
      }
      if (request.role === "closeout") return strictCloseout("en", "Retry chains stayed causal.");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime, "en", "causal-provider-retries");

    await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);

    const records = runtime
      .observations(id, 0, 10_000)
      .flatMap((fact) => mapObservationFact(fact, runtime.store));
    const roles = new Map(
      records.flatMap((record) =>
        record.observation.kind === "model_input"
          ? [[record.observation.attemptId, record.observation.role] as const]
          : [],
      ),
    );
    const attempts = records.flatMap((record) =>
      record.observation.kind === "provider_attempt"
        ? [{ occurredAt: record.occurredAt, observation: record.observation }]
        : [],
    );
    type AttemptRecord = { occurredAt: string; observation: ProviderAttemptObservation };
    const personaTurns = new Map<string, AttemptRecord[]>();
    const closeoutTurns = new Map<string, AttemptRecord[]>();
    for (const record of attempts) {
      const collection =
        roles.get(record.observation.attemptId) === "closeout" ? closeoutTurns : personaTurns;
      const current = collection.get(record.observation.turnId) ?? [];
      current.push(record);
      collection.set(record.observation.turnId, current);
    }

    expect(personaTurns.size).toBe(2);
    const personaChains = [...personaTurns.values()].map((chain) =>
      chain.map(({ observation }) => ({ attempt: observation.attempt, state: observation.state })),
    );
    expect(personaChains).toEqual([
      [
        { attempt: 1, state: "started" },
        { attempt: 1, state: "retry_wait" },
        { attempt: 2, state: "started" },
        { attempt: 2, state: "completed" },
      ],
      [
        { attempt: 1, state: "started" },
        { attempt: 1, state: "completed" },
      ],
    ]);
    expect(
      [...closeoutTurns.values()].map((chain) =>
        chain.map(({ observation }) => ({
          attempt: observation.attempt,
          state: observation.state,
        })),
      ),
    ).toEqual([
      [
        {
          attempt: 1,
          state: "started",
        },
        {
          attempt: 1,
          state: "retry_wait",
        },
        {
          attempt: 2,
          state: "started",
        },
        {
          attempt: 2,
          state: "completed",
        },
      ],
    ]);
    for (const chain of [...personaTurns.values(), ...closeoutTurns.values()]) {
      const retryIndex = chain.findIndex((record) => record.observation.state === "retry_wait");
      if (retryIndex < 0) continue;
      const retry = chain[retryIndex];
      const next = chain[retryIndex + 1];
      expect(retry?.observation.retryAt).not.toBeNull();
      expect(retry?.observation.error?.retryable).toBe(true);
      expect(next?.observation.state).toBe("started");
      expect(next?.observation.attempt).toBe((retry?.observation.attempt ?? 0) + 1);
      expect(Date.parse(retry?.observation.retryAt ?? "")).toBeLessThanOrEqual(
        Date.parse(next?.occurredAt ?? ""),
      );
    }
    expect(attempts.some((record) => record.observation.state === "failed")).toBe(false);
  });

  it("publishes failed only when a Provider attempt will not be retried", async () => {
    const scripted = new ScriptedProvider(({ request }) => {
      if (request.role === "persona") throw new Error("permanent provider failure");
      return modelResponse("unreachable");
    });
    const provider: ModelProvider = {
      id: scripted.id,
      credentialGuards: NO_CREDENTIAL_GUARDS,
      listModels: () => scripted.listModels(),
      complete: (request, context) => scripted.complete(request, context),
      classifyError: () => "permanent",
    };
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime, "en", "final-provider-failure");

    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => runtime.store.requireRun(run.id).phase,
      (phase) => phase === "faulted",
      "permanent Provider failure",
    );

    const attempts = runtime
      .observations(id, 0, 10_000)
      .flatMap((fact) => mapObservationFact(fact, runtime.store))
      .flatMap((record) => (record.observation.kind === "provider_attempt" ? [record.observation] : []));
    expect(attempts.map(({ attempt, state, retryAt }) => ({ attempt, state, retryAt }))).toEqual([
      { attempt: 1, state: "started", retryAt: null },
      { attempt: 1, state: "failed", retryAt: null },
    ]);
    expect(new Set(attempts.map((attempt) => attempt.turnId)).size).toBe(1);
    expect(scripted.requests.filter((request) => request.role === "persona")).toHaveLength(1);
  });

  it.each(["throws", "returns_invalid_value"] as const)(
    "fails closed when an untrusted Provider error classifier %s",
    async (classifierBehavior) => {
      const classifierSecret = "classifier-secret-must-not-cross-the-boundary";
      const scripted = new ScriptedProvider(({ request }) => {
        if (request.role === "persona") throw new Error("ordinary Provider failure");
        return modelResponse("unreachable");
      });
      const provider: ModelProvider = {
        id: scripted.id,
        credentialGuards: NO_CREDENTIAL_GUARDS,
        listModels: () => scripted.listModels(),
        complete: (request, context) => scripted.complete(request, context),
        classifyError: () => {
          if (classifierBehavior === "throws") throw new Error(classifierSecret);
          return "invalid-classification" as ReturnType<NonNullable<ModelProvider["classifyError"]>>;
        },
      };
      const { runtime } = await runtimeFixture(provider);
      const { id } = await readyPersona(runtime, "en", `invalid-provider-classifier-${classifierBehavior}`);

      const run = await runtime.start({ personaId: id });
      await waitFor(
        () => runtime.store.requireRun(run.id).phase,
        (phase) => phase === "faulted",
        "throwing Provider classifier",
      );

      const [event] = runtime.store.listEvents(id);
      const attempts = runtime
        .observations(id, 0, 10_000)
        .flatMap((fact) => mapObservationFact(fact, runtime.store))
        .flatMap((record) => (record.observation.kind === "provider_attempt" ? [record.observation] : []));
      expect(attempts.map(({ state, error }) => ({ state, error }))).toEqual([
        { state: "started", error: null },
        {
          state: "failed",
          error: expect.objectContaining({
            code: "internal_error",
            message: "Kokoro could not complete the operation.",
          }),
        },
      ]);
      expect(scripted.requests.filter((request) => request.role === "persona")).toHaveLength(1);
      expect(runtime.store.turnsForSourceEvent(event?.id ?? "missing")).toEqual([
        expect.objectContaining({ role: "persona", status: "failed" }),
      ]);
      expect(
        runtime
          .observations(id, 0, 10_000)
          .filter((observation) => observation.kind === "model_attempt_failed")
          .map((observation) => observation.payload),
      ).toEqual([expect.objectContaining({ code: "operation_failed", role: "persona" })]);
      expect(JSON.stringify(runtime.store.observations(id, 0, 10_000))).not.toContain(classifierSecret);
    },
  );

  it("terminates a Turn when ModelAttempt creation fails before Provider start", async () => {
    const provider = ordinaryScript();
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime, "en", "pre-provider-attempt-failure");
    runtime.store.createModelAttempt = () => {
      throw new Error("injected ModelAttempt creation failure");
    };

    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => runtime.store.requireRun(run.id).phase,
      (phase) => phase === "faulted",
      "pre-Provider ModelAttempt failure",
    );

    const [event] = runtime.store.listEvents(id);
    expect(runtime.store.turnsForSourceEvent(event?.id ?? "missing")).toEqual([
      expect.objectContaining({ role: "persona", status: "failed", completedAt: expect.any(Number) }),
    ]);
    expect(provider.requests).toEqual([]);
    expect(
      runtime
        .observations(id, 0, 10_000)
        .filter(
          (observation) => observation.kind === "model_request" || observation.kind === "provider_attempt",
        ),
    ).toEqual([]);
  });

  it("terminates a derived Turn when request construction fails before ModelAttempt creation", async () => {
    const provider = new ScriptedProvider(
      ({ request }) => {
        if (request.role === "persona") return modelResponse("x".repeat(80_000));
        if (request.role === "closeout") return strictCloseout("en");
        if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
        return modelResponse('{"operations":[]}');
      },
      { contextWindow: 20_000, maxOutputTokens: 256 },
    );
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime, "en", "pre-provider-request-failure");

    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => runtime.store.requireRun(run.id).phase,
      (phase) => phase === "faulted",
      "pre-Provider closeout request failure",
    );

    const [event] = runtime.store.listEvents(id);
    expect(runtime.store.turnsForSourceEvent(event?.id ?? "missing")).toEqual([
      expect.objectContaining({ role: "persona", status: "completed" }),
      expect.objectContaining({ role: "closeout", status: "failed", completedAt: expect.any(Number) }),
    ]);
    expect(provider.requests.filter((request) => request.role === "closeout")).toEqual([]);
    const roles = runtime
      .observations(id, 0, 10_000)
      .flatMap((fact) => mapObservationFact(fact, runtime.store))
      .flatMap((record) => (record.observation.kind === "model_input" ? [record.observation.role] : []));
    expect(roles).toEqual(["persona"]);
  });

  it("commits and publishes an English Event after strict closeout, without treating assistant text as delivery", async () => {
    const delivered: Array<{ recipient: string; text: string }> = [];
    let closeoutCalls = 0;
    const provider = new ScriptedProvider(({ request }) => {
      if (request.role === "persona") return modelResponse("Hello, this remains private cognition.");
      if (request.role === "closeout") {
        closeoutCalls += 1;
        if (closeoutCalls === 1) {
          return modelResponse('{"summary":"invalid extra field","memory":"none","extra":true}');
        }
        return strictCloseout("en", "English Event summary");
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const messageDelivery: MessageDelivery = {
      credentialGuards: NO_CREDENTIAL_GUARDS,
      async deliver(input) {
        delivered.push({ recipient: input.recipient, text: input.text });
        return { receipt: { delivered: true } };
      },
    };
    const { runtime } = await runtimeFixture(provider, { messageDelivery });
    const { id, rootCheckpoint, repository } = await readyPersona(runtime, "en");

    const run = await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);

    const [event] = runtime.store.listEvents(id);
    expect(event).toMatchObject({
      runId: run.id,
      sessionId: run.sessionId,
      sourceKind: "start",
      status: "checkpointed",
      summary: "English Event summary",
      memoryDecision: "none",
    });
    expect(event?.checkpoint).not.toBe(rootCheckpoint);
    expect(await repository.head()).toBe(event?.checkpoint);
    expect(await repository.isDirty()).toBe(false);
    expect(runtime.store.publications(id)).toEqual([
      expect.objectContaining({
        eventId: event?.id,
        payload: expect.objectContaining({
          version: 1,
          committed: true,
          checkpoint: event?.checkpoint,
          summary: "English Event summary",
        }),
      }),
    ]);
    expect(closeoutCalls).toBe(2);
    const closeoutRequests = provider.requests.filter((request) => request.role === "closeout");
    expect(closeoutRequests[1]?.messages[0]?.content).toContain("Return exactly these fields");
    const personaRequest = provider.requests.find((request) => request.role === "persona");
    expect(personaRequest?.promptLocale).toBe("en");
    expect(personaRequest?.system).toContain("Ordinary assistant text is private cognition");
    expect(JSON.stringify(personaRequest?.messages)).toContain("owner-edited English Persona");
    expect(delivered).toEqual([]);
    expect(runtime.store.listQueue(run.id)).toHaveLength(1);
  });

  it("applies Prompt locale changes to the next attempt in the same Turn", async () => {
    const personaId = "same-turn-prompt-locale";
    let activeRuntime: KokoroRuntime | undefined;
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona" && roleIndex === 0) {
        activeRuntime?.setLocales({ personaId, uiLocale: null, promptLocale: "zh-CN" });
        throw new Error("transient Provider failure before the locale change takes effect");
      }
      if (request.role === "persona") return modelResponse("本次重试使用新的 Prompt locale。");
      if (request.role === "closeout" && roleIndex === 0) {
        activeRuntime?.setLocales({ personaId, uiLocale: null, promptLocale: "en" });
        return modelResponse('{"summary":"字段过多","memory":"none","extra":true}');
      }
      if (request.role === "closeout") {
        return strictCloseout("en", "Each retry used the current Prompt locale.");
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const fixture = await runtimeFixture(provider);
    activeRuntime = fixture.runtime;
    await readyPersona(fixture.runtime, "en", personaId);

    await fixture.runtime.start({ personaId });
    await waitForPublications(fixture.runtime, personaId, 1);

    const personaRequests = provider.requests.filter((request) => request.role === "persona");
    expect(personaRequests.map((request) => request.promptLocale)).toEqual(["en", "zh-CN"]);
    expect(personaRequests[0]?.system).toContain("Ordinary assistant text is private cognition");
    expect(personaRequests[1]?.system).toContain("普通 assistant 文本是私有认知");
    expect(JSON.stringify(personaRequests[0]?.messages)).toContain("OWNER PERSONA DOCUMENTS");
    expect(JSON.stringify(personaRequests[1]?.messages)).toContain("OWNER PERSONA 文档原文");
    expect(JSON.stringify(personaRequests[0]?.tools)).toContain("Continue experience");
    expect(JSON.stringify(personaRequests[1]?.tools)).toContain("继续经历");
    expect(personaRequests[1]?.tools.map((tool) => tool.name)).toEqual(
      personaRequests[0]?.tools.map((tool) => tool.name),
    );
    expect(personaRequests[1]?.tools.map(schemaPropertyKeys)).toEqual(
      personaRequests[0]?.tools.map(schemaPropertyKeys),
    );

    const closeoutRequests = provider.requests.filter((request) => request.role === "closeout");
    expect(closeoutRequests.map((request) => request.promptLocale)).toEqual(["zh-CN", "en"]);
    expect(closeoutRequests[0]?.system).toContain("Event closeout 角色");
    expect(closeoutRequests[1]?.system).toContain("Event closeout role");
    expect(closeoutRequests[1]?.messages[0]?.content).toContain("Return exactly these fields");
    expect(closeoutRequests[1]?.messages[0]?.content).not.toContain("只返回这些字段");
    expect(fixture.runtime.store.requirePersona(personaId)).toMatchObject({
      uiLocale: "en",
      promptLocale: "en",
    });

    const event = fixture.runtime.store.listEvents(personaId)[0];
    if (!event) throw new Error("Expected one committed Event.");
    const personaTurn = fixture.runtime.store
      .turnsForSourceEvent(event.id)
      .find((turn) => turn.scope === "event");
    if (!personaTurn) throw new Error("Expected one Persona Turn.");
    const attempts = fixture.runtime
      .observations(personaId, 0, 10_000)
      .flatMap((fact) => mapObservationFact(fact, fixture.runtime.store))
      .flatMap((record) =>
        record.observation.kind === "provider_attempt" && record.observation.turnId === personaTurn.id
          ? [record.observation]
          : [],
      );
    expect(attempts.map(({ attempt, state }) => ({ attempt, state }))).toEqual([
      { attempt: 1, state: "started" },
      { attempt: 1, state: "retry_wait" },
      { attempt: 2, state: "started" },
      { attempt: 2, state: "completed" },
    ]);
  });

  it("derives built-in Tool messages from raw results in the current Prompt locale", async () => {
    const personaId = "derived-tool-result-locale";
    const deliveryStarted = deferred();
    const releaseDelivery = deferred();
    let activeRuntime: KokoroRuntime | undefined;
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona" && roleIndex === 0) {
        return modelResponse("Send one message through the authorized Tool.", {
          toolCalls: [
            {
              id: "provider-send-message",
              name: "send_message",
              arguments: { recipient: "owner", text: "hello" },
            },
          ],
        });
      }
      if (request.role === "persona" && roleIndex === 1) {
        activeRuntime?.setLocales({ personaId, uiLocale: null, promptLocale: "en" });
        return modelResponse("再读取一次目录。", {
          toolCalls: [{ id: "provider-list-files", name: "list_files", arguments: { path: "." } }],
        });
      }
      if (request.role === "persona") return modelResponse("The derived Tool views remained causal.");
      if (request.role === "closeout") return strictCloseout("en", "Tool results remained raw facts.");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const messageDelivery: MessageDelivery = {
      credentialGuards: NO_CREDENTIAL_GUARDS,
      async deliver() {
        deliveryStarted.resolve();
        await releaseDelivery.promise;
        return { receipt: { delivered: true } };
      },
    };
    const fixture = await runtimeFixture(provider, { messageDelivery });
    activeRuntime = fixture.runtime;
    const run = await readyPersona(fixture.runtime, "en", personaId).then(async () =>
      fixture.runtime.start({ personaId }),
    );

    await deliveryStarted.promise;
    fixture.runtime.setLocales({ personaId, uiLocale: null, promptLocale: "zh-CN" });
    releaseDelivery.resolve();
    await waitForPublications(fixture.runtime, personaId, 1);

    const personaRequests = provider.requests.filter((request) => request.role === "persona");
    expect(personaRequests.map((request) => request.promptLocale)).toEqual(["en", "zh-CN", "en"]);
    const chineseToolMessage = personaRequests[1]?.messages.find((message) => message.role === "tool");
    expect(chineseToolMessage?.content).toContain("消息行动结果（Tool 权威报告）");
    expect(chineseToolMessage?.content).not.toContain("Message action result");
    const rerenderedEnglishMessages = personaRequests[2]?.messages.filter(
      (message) => message.role === "tool",
    );
    expect(rerenderedEnglishMessages?.[0]?.content).toContain(
      "Message action result (authoritative Tool report)",
    );
    expect(rerenderedEnglishMessages?.[0]?.content).not.toContain("消息行动结果");

    const rawToolCalls = fixture.runtime.store.toolCallsForPersona(personaId);
    const storedToolEntries = fixture.runtime.store
      .sessionEntries(run.sessionId)
      .filter((entry) => entry.kind === "tool");
    expect(storedToolEntries).toHaveLength(2);
    const firstStoredPayload = storedToolEntries[0]?.payload;
    if (
      typeof firstStoredPayload !== "object" ||
      firstStoredPayload === null ||
      Array.isArray(firstStoredPayload)
    ) {
      throw new Error("Expected an object Tool Session payload.");
    }
    expect(firstStoredPayload).toMatchObject({
      toolName: "send_message",
      rawResult: rawToolCalls[0]?.result,
    });
    expect(JSON.stringify(firstStoredPayload)).toContain("Message action result");
    expect(JSON.stringify(firstStoredPayload["rawResult"])).not.toContain("Message action result");
    expect(JSON.stringify(firstStoredPayload["rawResult"])).not.toContain("消息行动结果");
  });

  it("uses zh-CN Persona, Tool result, closeout retry, and Hippocampus prompts end to end", async () => {
    const providerCallId = "zh-list-files-provider-control-id";
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona" && roleIndex === 0) {
        return modelResponse("我要先查看可见文件。", {
          toolCalls: [{ id: providerCallId, name: "list_files", arguments: { path: "." } }],
        });
      }
      if (request.role === "persona") return modelResponse("这是私有认知，不是对外消息。");
      if (request.role === "closeout" && roleIndex === 0) {
        return modelResponse('{"summary":"包含了多余字段","memory":"maintain","extra":true}');
      }
      if (request.role === "closeout") {
        return modelResponse('{"summary":"完成了一次中文经历。","memory":"maintain"}');
      }
      if (request.role === "compaction") return modelResponse('{"summary":"中文压缩摘要"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime, "zh-CN");

    await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);
    await waitFor(
      () => runtime.store.listHippocampusJobs(id)[0],
      (job) => job?.status === "completed",
      "completed zh-CN Hippocampus work",
    );

    const personaRequests = provider.requests.filter((request) => request.role === "persona");
    const closeoutRequests = provider.requests.filter((request) => request.role === "closeout");
    const hippocampusRequest = provider.requests.find((request) => request.role === "hippocampus");
    const personaRequest = personaRequests[0];
    const closeoutRequest = closeoutRequests[1];
    expect(personaRequest?.promptLocale).toBe("zh-CN");
    expect(personaRequest?.system).toContain("普通 assistant 文本是私有认知");
    expect(JSON.stringify(personaRequest?.messages)).toContain("Owner 编辑后的中文 Persona");
    expect(JSON.stringify(personaRequests[1]?.messages)).toContain("文件列表结果（Tool 数据原文）");
    expect(JSON.stringify(personaRequests[1]?.messages)).toContain('"toolCallId":"action-1"');
    expect(JSON.stringify(personaRequests[1]?.messages)).not.toContain(providerCallId);
    expect(closeoutRequest?.promptLocale).toBe("zh-CN");
    expect(closeoutRequest?.system).toContain("只返回一个仅含 summary 和 memory 的 JSON 对象");
    expect(closeoutRequest?.messages[0]?.content).toContain("只返回这些字段：memory, summary。");
    expect(closeoutRequest?.messages[0]?.content).not.toContain("Return exactly these fields");
    expect(hippocampusRequest).toMatchObject({
      promptLocale: "zh-CN",
      tools: [],
      continuation: false,
    });
    expect(hippocampusRequest?.system).toContain("Kokoro 的 Hippocampus");
    expect(runtime.store.listEvents(id)[0]).toMatchObject({
      status: "checkpointed",
      summary: "完成了一次中文经历。",
      memoryDecision: "maintain",
    });
    const [event] = runtime.store.listEvents(id);
    const [toolCall] = runtime.store.toolCallsForPersona(id);
    expect(JSON.stringify(closeoutRequests)).not.toContain(event?.id);
    expect(JSON.stringify(hippocampusRequest)).not.toContain(event?.id);
    expect(JSON.stringify(closeoutRequests)).not.toContain(toolCall?.id);
    expect(JSON.stringify(hippocampusRequest)).not.toContain(toolCall?.id);
  });

  it("persists independent UI and Prompt locale selection across runtime restart", async () => {
    const fixture = await runtimeFixture(ordinaryScript());
    const { id } = await readyPersona(fixture.runtime, "en", "mixed-locale-restart");
    fixture.runtime.setLocales({ personaId: id, uiLocale: "zh-CN", promptLocale: null });

    await fixture.runtime.close();
    runtimes.delete(fixture.runtime);
    const reopenedProvider = ordinaryScript("This request must remain English after restart.");
    const reopened = await KokoroRuntime.open({
      stateDirectory: fixture.stateDirectory,
      personaDirectory: fixture.personaDirectory,
      providers: [reopenedProvider],
      defaultModel: MODEL,
    });
    runtimes.add(reopened);

    expect(reopened.store.requirePersona(id)).toMatchObject({
      uiLocale: "zh-CN",
      promptLocale: "en",
    });
    await reopened.start({ personaId: id });
    await waitForPublications(reopened, id, 1);
    const personaRequest = reopenedProvider.requests.find((request) => request.role === "persona");
    expect(personaRequest?.promptLocale).toBe("en");
    expect(personaRequest?.system).toContain("Ordinary assistant text is private cognition");
    expect(personaRequest?.system).not.toContain("普通 assistant 文本是私有认知");
  });

  it("runs Hippocampus only from the committed Event and leaves its atomic Memory edit after that Checkpoint", async () => {
    const provider = new ScriptedProvider(({ request }) => {
      if (request.role === "persona") return modelResponse("I learned a durable preference privately.");
      if (request.role === "closeout") {
        return modelResponse('{"summary":"Learned a durable preference.","memory":"maintain"}');
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse(
        JSON.stringify({
          operations: [
            {
              kind: "create",
              path: "workspace/memory/2026-08-30/preference.md",
              content: "# Preference\n\nThe Owner prefers concise status updates.\n",
            },
          ],
        }),
      );
    });
    const { runtime } = await runtimeFixture(provider);
    const { id, rootCheckpoint, repository } = await readyPersona(runtime);

    await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);
    const [event] = runtime.store.listEvents(id);
    const job = await waitFor(
      () => runtime.store.listHippocampusJobs(id)[0],
      (candidate) => candidate?.status === "completed",
      "completed Hippocampus work",
    );

    expect(event).toMatchObject({ status: "checkpointed", memoryDecision: "maintain" });
    expect(event?.checkpoint).not.toBe(rootCheckpoint);
    expect(job).toMatchObject({
      eventId: event?.id,
      sourceCheckpoint: event?.checkpoint,
      status: "completed",
      attempts: 1,
    });
    expect(await repository.head()).toBe(event?.checkpoint);
    expect(await repository.isDirty()).toBe(true);
    expect(
      await readFile(
        path.join(repository.root, "workspace", "memory", "2026-08-30", "preference.md"),
        "utf8",
      ),
    ).toBe("# Preference\n\nThe Owner prefers concise status updates.\n");
    const hippocampusRequest = provider.requests.find((request) => request.role === "hippocampus");
    expect(hippocampusRequest).toMatchObject({ tools: [], continuation: false, promptLocale: "en" });
    expect(JSON.stringify(hippocampusRequest?.messages)).toContain(
      "I learned a durable preference privately.",
    );
    expect(JSON.stringify(hippocampusRequest?.messages)).not.toContain(event?.id);
  });

  it("reapplies H completed after the restored Checkpoint and preserves it once a later Checkpoint captures it", async () => {
    const firstHippocampusGate = deferred();
    const memoryPath = "workspace/memory/2026-08-30/force-causality.md";
    const memoryContent = "# Force causality\n\nThis Memory obligation must survive Force.\n";
    const firstProvider = new ScriptedProvider(async ({ request, roleIndex }) => {
      if (request.role === "persona") return modelResponse(`Private Event ${roleIndex + 1}.`);
      if (request.role === "closeout") {
        return modelResponse(
          JSON.stringify({
            summary: `Checkpoint ${roleIndex + 1}.`,
            memory: roleIndex === 0 ? "maintain" : "none",
          }),
        );
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      await firstHippocampusGate.promise;
      return modelResponse(
        JSON.stringify({ operations: [{ kind: "create", path: memoryPath, content: memoryContent }] }),
      );
    });
    const fixture = await runtimeFixture(firstProvider);
    const { id, repository } = await readyPersona(fixture.runtime, "en", "force-h-causality");

    await fixture.runtime.start({ personaId: id });
    await waitForPublications(fixture.runtime, id, 1);
    const originalJob = await waitFor(
      () => fixture.runtime.store.listHippocampusJobs(id)[0],
      (job) => job?.status === "running",
      "delayed first H work",
    );
    await fixture.runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 2 } });
    await waitForPublications(fixture.runtime, id, 2);
    const secondCheckpoint = fixture.runtime.store.listEvents(id).at(-1)?.checkpoint;
    if (!originalJob || !secondCheckpoint) throw new Error("Expected H work and a second Checkpoint.");

    firstHippocampusGate.resolve();
    await waitFor(
      () => fixture.runtime.store.requireHippocampusJob(originalJob.id),
      (job) => job.status === "completed",
      "H work completed after the second Checkpoint",
    );
    expect(fixture.runtime.store.memoryTransactionForJob(originalJob.id)).toMatchObject({
      phase: "completed",
      capturedCheckpoint: null,
      forceRevertedAt: null,
    });
    expect((await repository.readText(memoryPath)).content).toBe(memoryContent);

    await fixture.runtime.force(id);
    expect(await repository.head()).toBe(secondCheckpoint);
    await expect(repository.readText(memoryPath)).rejects.toMatchObject({ code: "invalid_path" });
    expect(fixture.runtime.store.requireHippocampusJob(originalJob.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      proposal: null,
    });
    expect(fixture.runtime.store.memoryTransactionForJob(originalJob.id)).toMatchObject({
      phase: "reverted",
      capturedCheckpoint: null,
      forceRevertedAt: expect.any(Number),
    });

    await fixture.runtime.close();
    runtimes.delete(fixture.runtime);
    const eventGate = deferred();
    const retryProvider = new ScriptedProvider(async ({ request }) => {
      if (request.role === "persona") {
        await eventGate.promise;
        return modelResponse("A later Event captures the reapplied Memory.");
      }
      if (request.role === "closeout") {
        return modelResponse('{"summary":"Captured reapplied Memory.","memory":"none"}');
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse(
        JSON.stringify({ operations: [{ kind: "create", path: memoryPath, content: memoryContent }] }),
      );
    });
    const reopened = await KokoroRuntime.open({
      stateDirectory: fixture.stateDirectory,
      personaDirectory: fixture.personaDirectory,
      providers: [retryProvider],
      defaultModel: MODEL,
    });
    runtimes.add(reopened);
    await reopened.start({ personaId: id });
    await waitFor(
      () => reopened.store.requireHippocampusJob(originalJob.id),
      (job) => job.status === "completed",
      "reapplied H work after restart",
    );
    const reopenedRepository = await PersonaRepository.open(repository.root);
    expect((await reopenedRepository.readText(memoryPath)).content).toBe(memoryContent);
    expect(reopened.store.memoryTransactionForJob(originalJob.id)).toMatchObject({
      phase: "completed",
      capturedCheckpoint: null,
      forceRevertedAt: null,
    });

    eventGate.resolve();
    await waitForPublications(reopened, id, 3);
    const capturedCheckpoint = reopened.store.listEvents(id).at(-1)?.checkpoint;
    if (!capturedCheckpoint) throw new Error("The later Event did not complete its Checkpoint.");
    expect(reopened.store.memoryTransactionForJob(originalJob.id)).toMatchObject({
      phase: "completed",
      capturedCheckpoint,
      forceRevertedAt: null,
    });

    await reopened.force(id);
    expect(reopened.store.requireHippocampusJob(originalJob.id)).toMatchObject({
      status: "completed",
      attempts: 1,
    });
    expect(retryProvider.requests.filter((request) => request.role === "hippocampus")).toHaveLength(1);
    expect(await reopenedRepository.head()).toBe(capturedCheckpoint);
    expect((await reopenedRepository.readText(memoryPath)).content).toBe(memoryContent);
    expect(await reopenedRepository.isDirty()).toBe(false);
  });

  it.each(["after_original_moved", "after_replacement_moved"] as const)(
    "settles a live Memory swap at %s before a queued Event can capture its tree",
    async (faultPoint) => {
      const memoryFaultReached = deferred();
      const releaseMemoryFault = deferred();
      const startHippocampusApply = deferred();
      const secondCheckpointReady = deferred();
      const releaseSecondCheckpoint = deferred();
      const memoryPath = "workspace/memory/2026-08-30/recovered-swap.md";
      const memoryContent = `# Recovered ${faultPoint}\n`;
      let checkpointCount = 0;
      let memoryFaulted = false;
      const provider = new ScriptedProvider(async ({ request, roleIndex }) => {
        if (request.role === "persona") return modelResponse(`Private Event ${roleIndex + 1}.`);
        if (request.role === "closeout") {
          return modelResponse(
            JSON.stringify({
              summary: `Memory recovery Event ${roleIndex + 1}.`,
              memory: roleIndex === 0 ? "maintain" : "none",
            }),
          );
        }
        if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
        await startHippocampusApply.promise;
        return modelResponse(
          JSON.stringify({ operations: [{ kind: "create", path: memoryPath, content: memoryContent }] }),
        );
      });
      const fixture = await runtimeFixture(provider, {
        async eventFault(point) {
          if (point !== "before_checkpoint") return;
          checkpointCount += 1;
          if (checkpointCount !== 2) return;
          secondCheckpointReady.resolve();
          await releaseSecondCheckpoint.promise;
        },
        async memoryFault(point) {
          if (point !== faultPoint || memoryFaulted) return;
          memoryFaulted = true;
          memoryFaultReached.resolve();
          await releaseMemoryFault.promise;
          throw new Error(`simulated live Memory fault at ${point}`);
        },
      });
      const { id, repository } = await readyPersona(
        fixture.runtime,
        "en",
        `memory-swap-${faultPoint.replaceAll("_", "-")}`,
      );

      await fixture.runtime.start({ personaId: id });
      await waitForPublications(fixture.runtime, id, 1);
      await fixture.runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 2 } });
      await secondCheckpointReady.promise;
      startHippocampusApply.resolve();
      await memoryFaultReached.promise;
      releaseSecondCheckpoint.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseMemoryFault.resolve();
      await waitForPublications(fixture.runtime, id, 2);

      const [firstEvent, secondEvent] = fixture.runtime.store.listEvents(id);
      const job = fixture.runtime.store.listHippocampusJobs(id)[0];
      if (!firstEvent?.checkpoint || !secondEvent?.checkpoint || !job) {
        throw new Error("Expected two Checkpoints and one recovered H job.");
      }
      expect(fixture.runtime.store.memoryTransactionForJob(job.id)).toMatchObject({
        phase: "completed",
        capturedCheckpoint: secondEvent.checkpoint,
        forceRevertedAt: null,
      });
      expect(fixture.runtime.store.pendingMemoryTransaction(id)).toBeUndefined();
      expect((await repository.readText(memoryPath)).content).toBe(memoryContent);
      expect(await repository.head()).toBe(secondEvent.checkpoint);
      expect(await repository.isDirty()).toBe(false);
    },
  );

  it("fails a queued Event closed when live Memory recovery cannot settle the recorded swap", async () => {
    const memoryFaultReached = deferred();
    const releaseMemoryFault = deferred();
    const startHippocampusApply = deferred();
    const secondCheckpointReady = deferred();
    const releaseSecondCheckpoint = deferred();
    let checkpointCount = 0;
    let memoryRoot = "";
    const provider = new ScriptedProvider(async ({ request, roleIndex }) => {
      if (request.role === "persona") return modelResponse(`Private Event ${roleIndex + 1}.`);
      if (request.role === "closeout") {
        return modelResponse(
          JSON.stringify({
            summary: `Unrecoverable Memory Event ${roleIndex + 1}.`,
            memory: roleIndex === 0 ? "maintain" : "none",
          }),
        );
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      await startHippocampusApply.promise;
      return modelResponse(
        JSON.stringify({
          operations: [
            {
              kind: "create",
              path: "workspace/memory/2026-08-30/unrecoverable-swap.md",
              content: "This candidate must not be checkpointed from a partial swap.\n",
            },
          ],
        }),
      );
    });
    const fixture = await runtimeFixture(provider, {
      async eventFault(point) {
        if (point !== "before_checkpoint") return;
        checkpointCount += 1;
        if (checkpointCount !== 2) return;
        secondCheckpointReady.resolve();
        await releaseSecondCheckpoint.promise;
      },
      async memoryFault(point) {
        if (point !== "after_original_moved") return;
        await writeFile(memoryRoot, "Owner bytes occupying the Memory root.\n", "utf8");
        memoryFaultReached.resolve();
        await releaseMemoryFault.promise;
        throw new Error("simulated unrecoverable live Memory fault");
      },
    });
    const { id, repository } = await readyPersona(fixture.runtime, "en", "memory-recovery-fail-closed");
    memoryRoot = path.join(repository.root, "workspace", "memory");

    await fixture.runtime.start({ personaId: id });
    await waitForPublications(fixture.runtime, id, 1);
    const firstCheckpoint = fixture.runtime.store.listEvents(id)[0]?.checkpoint;
    if (!firstCheckpoint) throw new Error("The first Event did not complete its Checkpoint.");
    await fixture.runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 2 } });
    await secondCheckpointReady.promise;
    startHippocampusApply.resolve();
    await memoryFaultReached.promise;
    releaseSecondCheckpoint.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseMemoryFault.resolve();

    await waitFor(
      () =>
        fixture.runtime.store.requireRun(fixture.runtime.store.listEvents(id)[0]?.runId ?? "missing").phase,
      (phase) => phase === "faulted",
      "Event faulted behind an unsettled Memory transaction",
    );
    expect(await repository.head()).toBe(firstCheckpoint);
    expect(fixture.runtime.store.preparedCheckpointIntents(id)).toEqual([]);
    expect(fixture.runtime.store.pendingMemoryTransaction(id)).toEqual(expect.any(String));
    expect(fixture.runtime.store.publications(id)).toHaveLength(1);
    expect(await readFile(memoryRoot, "utf8")).toBe("Owner bytes occupying the Memory root.\n");
  });

  it("fences an uncooperative Hippocampus Provider across Force and requeues its source Checkpoint", async () => {
    const hippocampusGate = deferred();
    const hippocampusReturned = deferred();
    const lateMemoryPath = path.join("workspace", "memory", "late-hippocampus.md");
    const provider = new ScriptedProvider(async ({ request, context }) => {
      if (request.role === "persona") return modelResponse("This Event requests Memory maintenance.");
      if (request.role === "closeout") {
        return modelResponse('{"summary":"Force during Memory maintenance.","memory":"maintain"}');
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      await hippocampusGate.promise;
      context.emit({ type: "reasoning_delta", delta: "late cognition after Force" });
      hippocampusReturned.resolve();
      return modelResponse(
        JSON.stringify({
          operations: [
            {
              kind: "create",
              path: lateMemoryPath.replaceAll("\\", "/"),
              content: "# Late Memory\n\nThis must never be applied.\n",
            },
          ],
        }),
      );
    });
    const { runtime } = await runtimeFixture(provider);
    const { id, repository } = await readyPersona(runtime);
    const run = await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);
    const [event] = runtime.store.listEvents(id);
    const runningJob = await waitFor(
      () => runtime.store.listHippocampusJobs(id)[0],
      (job) => job?.status === "running",
      "uncooperative Hippocampus Provider",
    );
    await waitFor(
      () => provider.requests.filter((request) => request.role === "hippocampus").length,
      (count) => count === 1,
      "dispatched Hippocampus Provider request",
    );
    if (!event?.checkpoint || !runningJob) throw new Error("Expected a checkpointed Event and H job.");
    const untracked = path.join(repository.root, "workspace", "memory", "force-discard.md");
    await writeFile(untracked, "Force must discard this Memory edit.\n", "utf8");

    const forced = await Promise.race([
      runtime.force(id),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Force waited for an uncooperative Hippocampus Provider.")), 5_000),
      ),
    ]);

    expect(forced).toMatchObject({ id: run.id, phase: "forced" });
    expect(await repository.head()).toBe(event.checkpoint);
    expect(await repository.isDirty()).toBe(false);
    await expect(readFile(untracked, "utf8")).rejects.toThrow();
    expect(runtime.store.requireHippocampusJob(runningJob.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      proposal: null,
      error: null,
      sourceCheckpoint: event.checkpoint,
    });
    expect(
      publicProviderAttempts(runtime, id, "hippocampus").map(({ state, error }) => ({ state, error })),
    ).toEqual([
      { state: "started", error: null },
      {
        state: "aborted",
        error: expect.objectContaining({ message: "The operation was aborted before it completed." }),
      },
    ]);
    expect(runtime.store.turnsForSourceEvent(event.id)).toContainEqual(
      expect.objectContaining({ role: "hippocampus", status: "failed", completedAt: expect.any(Number) }),
    );
    expect(
      runtime
        .observations(id, 0, 10_000)
        .filter((observation) => observation.kind === "model_attempt_failed")
        .map((observation) => observation.payload),
    ).toContainEqual(expect.objectContaining({ role: "hippocampus", error: { code: "aborted" } }));
    const observationsAfterForce = runtime.store.observations(id, 0, 10_000);

    hippocampusGate.resolve();
    await Promise.race([
      hippocampusReturned.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("The old Hippocampus Provider did not resume.")), 5_000),
      ),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.store.requireHippocampusJob(runningJob.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      proposal: null,
      error: null,
    });
    expect(runtime.store.observations(id, 0, 10_000)).toEqual(observationsAfterForce);
    await expect(repository.readText(lateMemoryPath)).rejects.toMatchObject({ code: "invalid_path" });
    expect(await repository.isDirty()).toBe(false);
  });

  it("makes bounded Hippocampus failure visible and supports an explicit manual Retry", async () => {
    const personaId = "hippocampus-locale-retry";
    let activeRuntime: KokoroRuntime | undefined;
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona") return modelResponse("This experience may need Memory maintenance.");
      if (request.role === "closeout") {
        return modelResponse('{"summary":"Needs Memory review.","memory":"maintain"}');
      }
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      if (roleIndex === 0) {
        activeRuntime?.setLocales({ personaId, uiLocale: null, promptLocale: "zh-CN" });
      }
      return roleIndex < 3 ? modelResponse('{"invalid":true}') : modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    activeRuntime = runtime;
    const { id } = await readyPersona(runtime, "en", personaId);

    await runtime.start({ personaId: id });
    const failed = await waitFor(
      () => runtime.store.listHippocampusJobs(id)[0],
      (candidate) => candidate?.status === "failed",
      "bounded Hippocampus failure",
    );
    expect(failed?.attempts).toBe(3);
    await runtime.retryHippocampus(id, failed?.id ?? "missing");
    const completed = await waitFor(
      () => runtime.store.requireHippocampusJob(failed?.id ?? "missing"),
      (candidate) => candidate.status === "completed",
      "manually retried Hippocampus work",
    );

    expect(completed.attempts).toBe(1);
    const hippocampusRequests = provider.requests.filter((request) => request.role === "hippocampus");
    expect(hippocampusRequests).toHaveLength(4);
    expect(hippocampusRequests.map((request) => request.promptLocale)).toEqual([
      "en",
      "zh-CN",
      "zh-CN",
      "zh-CN",
    ]);
    expect(hippocampusRequests[1]?.system).toContain("Kokoro 的 Hippocampus");
    expect(hippocampusRequests[1]?.messages[0]?.content).toContain("请按照校验代码 invalid_schema");
    const publicRecords = runtime
      .observations(id, 0, 10_000)
      .flatMap((fact) => mapObservationFact(fact, runtime.store));
    const hippocampusAttemptIds = new Set(
      publicRecords.flatMap((record) =>
        record.observation.kind === "model_input" && record.observation.role === "hippocampus"
          ? [record.observation.attemptId]
          : [],
      ),
    );
    const providerAttempts = publicRecords.flatMap((record) =>
      record.observation.kind === "provider_attempt" &&
      hippocampusAttemptIds.has(record.observation.attemptId)
        ? [record.observation]
        : [],
    );
    const providerTurns = new Map<string, ProviderAttemptObservation[]>();
    for (const providerAttempt of providerAttempts) {
      const turn = providerTurns.get(providerAttempt.turnId) ?? [];
      turn.push(providerAttempt);
      providerTurns.set(providerAttempt.turnId, turn);
    }
    const [firstFailedTurn, secondFailedTurn] = [...providerTurns.values()];
    expect(providerTurns.size).toBe(4);
    expect(firstFailedTurn?.map(({ attempt, state }) => ({ attempt, state }))).toEqual([
      { attempt: 1, state: "started" },
      { attempt: 1, state: "failed" },
    ]);
    expect(secondFailedTurn?.map(({ attempt, state }) => ({ attempt, state }))).toEqual([
      { attempt: 1, state: "started" },
      { attempt: 1, state: "failed" },
    ]);
    expect([...providerTurns.keys()][0]).not.toBe([...providerTurns.keys()][1]);
    expect(providerAttempts.every((providerAttempt) => providerAttempt.attempt === 1)).toBe(true);
    const hippocampusProgress = publicRecords.flatMap((record) =>
      record.observation.kind === "hippocampus" ? [record.observation] : [],
    );
    const firstRetryIndex = hippocampusProgress.findIndex(
      (observation) => observation.state === "retry_wait" && observation.attempt === 1,
    );
    const nextJobAttempt = hippocampusProgress
      .slice(firstRetryIndex + 1)
      .find((observation) => observation.state === "running");
    expect(firstRetryIndex).toBeGreaterThanOrEqual(0);
    expect(nextJobAttempt).toMatchObject({ state: "running", attempt: 2 });
    const states = runtime
      .observations(id, 0, 1_000)
      .filter((observation) => observation.kind === "hippocampus")
      .map((observation) =>
        typeof observation.payload === "object" &&
        observation.payload !== null &&
        !Array.isArray(observation.payload)
          ? observation.payload["state"]
          : null,
      );
    expect(states).toContain("retry_wait");
    expect(states).toContain("failed");
    expect(states).toContain("queued");
    expect(states.at(-1)).toBe("applied");
  });

  it("schedules a source-linked continuation only after an explicit continue_experience ToolCall", async () => {
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona" && roleIndex === 0) {
        return modelResponse("I choose to keep reflecting.", {
          toolCalls: [
            {
              id: "provider-continuation-1",
              name: "continue_experience",
              arguments: { focus: "next thought" },
            },
          ],
        });
      }
      if (request.role === "persona") return modelResponse("The explicit continuation is now complete.");
      if (request.role === "closeout") return strictCloseout("en", `Event closeout ${roleIndex + 1}`);
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id, rootCheckpoint } = await readyPersona(runtime);

    const run = await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 2);

    const [firstEvent, continuationEvent] = runtime.store.listEvents(id);
    const [startItem, continuationItem] = runtime.store.listQueue(run.id);
    const [continuationCall] = runtime.store.toolCallsForEvent(firstEvent?.id ?? "missing");
    expect(startItem).toMatchObject({ kind: "start", status: "completed" });
    expect(continuationCall).toMatchObject({ name: "continue_experience", status: "succeeded" });
    expect(continuationItem).toMatchObject({
      kind: "continuation",
      status: "completed",
      sourceEventId: firstEvent?.id,
      sourceToolCallId: continuationCall?.id,
      payload: { focus: "next thought" },
    });
    expect(continuationEvent).toMatchObject({
      queueItemId: continuationItem?.id,
      sourceKind: "continuation",
      status: "checkpointed",
    });
    expect(runtime.store.requireRun(run.id).startingCheckpoint).toBe(rootCheckpoint);
    expect(
      runtime.store
        .turnsForEvent(firstEvent?.id ?? "missing")
        .every((turn) => turn.startingCheckpoint === rootCheckpoint),
    ).toBe(true);
    expect(
      runtime.store
        .turnsForEvent(continuationEvent?.id ?? "missing")
        .every((turn) => turn.startingCheckpoint === firstEvent?.checkpoint),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.store.listQueue(run.id)).toHaveLength(2);
    expect(runtime.store.listEvents(id)).toHaveLength(2);
  });

  it("never proposes or dispatches a ToolCall from a length-truncated response", async () => {
    const deliveries: string[] = [];
    const provider = new ScriptedProvider(({ request, roleIndex }) => {
      if (request.role === "persona" && roleIndex === 0) {
        return modelResponse("truncated", {
          stopReason: "length",
          toolCalls: [
            {
              id: "truncated-send",
              name: "send_message",
              arguments: { recipient: "outside", text: "must never be sent" },
            },
          ],
        });
      }
      if (request.role === "persona")
        return modelResponse("Recovered without dispatching the truncated proposal.");
      if (request.role === "closeout") return strictCloseout("en");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider, {
      messageDelivery: {
        credentialGuards: NO_CREDENTIAL_GUARDS,
        async deliver(input) {
          deliveries.push(input.text);
          return { receipt: { delivered: true } };
        },
      },
    });
    const { id } = await readyPersona(runtime);

    await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);

    const event = runtime.store.listEvents(id)[0];
    expect(deliveries).toEqual([]);
    expect(runtime.store.toolCallsForEvent(event?.id ?? "missing")).toEqual([]);
    expect(
      runtime
        .observations(id, 0, 1_000)
        .filter((observation) => observation.kind === "model_attempt_failed")
        .map((observation) => observation.payload),
    ).toContainEqual(expect.objectContaining({ code: "response_truncated", role: "persona" }));
  });
});

describe("KokoroRuntime Tool causality", () => {
  it("does not dispatch or append authorization facts when an uncooperative policy resolves after Force", async () => {
    const authorizationStarted = deferred();
    const releaseAuthorization = deferred();
    let authorizationCalls = 0;
    let executions = 0;
    const authorization: AuthorizationPolicy = {
      credentialGuards: NO_CREDENTIAL_GUARDS,
      async authorize(): Promise<AuthorizationDecision> {
        authorizationCalls += 1;
        authorizationStarted.resolve();
        await releaseAuthorization.promise;
        return { allow: true, revision: "late-owner-approval" };
      },
    };
    const tool = fixtureTool("late_authorization_external", "external", async () => {
      executions += 1;
      return { content: "must not execute" };
    });
    const provider = toolThenThoughtScript(tool.name);
    const { runtime } = await runtimeFixture(provider, { tools: [tool], authorization });
    const { id, rootCheckpoint, repository } = await readyPersona(runtime, "en", "late-authorization");
    const run = await runtime.start({ personaId: id });
    await authorizationStarted.promise;

    const forced = await runtime.force(id);
    const afterForce = {
      events: runtime.store.listEvents(id),
      calls: runtime.store.toolCallsForPersona(id),
      observations: runtime.store.observations(id, 0, 10_000),
      publications: runtime.store.publications(id),
    };
    releaseAuthorization.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(forced).toMatchObject({ id: run.id, phase: "forced" });
    expect(authorizationCalls).toBe(1);
    expect(executions).toBe(0);
    const [call] = runtime.store.toolCallsForPersona(id);
    expect(call).toMatchObject({ name: tool.name, status: "proposed" });
    expect(runtime.store.authorizationDecisionsForToolCall(call?.id ?? "missing")).toEqual([]);
    expect(runtime.store.observations(id, 0, 10_000)).toEqual(afterForce.observations);
    expect(runtime.store.listEvents(id)).toEqual(afterForce.events);
    expect(runtime.store.toolCallsForPersona(id)).toEqual(afterForce.calls);
    expect(runtime.store.publications(id)).toEqual(afterForce.publications);
    expect(await repository.head()).toBe(rootCheckpoint);
  });

  it("does not persist a Tool result when its post-execution credential capture resolves after Force", async () => {
    const captureStarted = deferred();
    const releaseCapture = deferred();
    let captureAfterExecution = false;
    let blockedCapture = false;
    let executions = 0;
    const lateGuard: CredentialGuard = {
      async capture() {
        if (!captureAfterExecution || blockedCapture) return null;
        blockedCapture = true;
        captureStarted.resolve();
        await releaseCapture.promise;
        return null;
      },
    };
    const tool = fixtureTool(
      "late_execution_capture",
      "external",
      async () => {
        executions += 1;
        captureAfterExecution = true;
        return { content: "late external receipt", details: { receipt: "receipt-1" } };
      },
      [lateGuard],
    );
    const provider = toolThenThoughtScript(tool.name);
    const { runtime } = await runtimeFixture(provider, { tools: [tool] });
    const { id, rootCheckpoint, repository } = await readyPersona(runtime, "en", "late-execution-capture");
    const run = await runtime.start({ personaId: id });
    await captureStarted.promise;

    const forced = await runtime.force(id);
    const factsAfterForce = {
      events: runtime.store.listEvents(id),
      calls: runtime.store.toolCallsForPersona(id),
      observations: runtime.store.observations(id, 0, 10_000),
      publications: runtime.store.publications(id),
    };
    releaseCapture.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(forced).toMatchObject({ id: run.id, phase: "forced" });
    expect(executions).toBe(1);
    expect(runtime.store.toolCallsForPersona(id)).toEqual([
      expect.objectContaining({ name: tool.name, status: "unknown", result: null }),
    ]);
    expect(runtime.store.listEvents(id)).toEqual(factsAfterForce.events);
    expect(runtime.store.toolCallsForPersona(id)).toEqual(factsAfterForce.calls);
    expect(runtime.store.observations(id, 0, 10_000)).toEqual(factsAfterForce.observations);
    expect(runtime.store.publications(id)).toEqual(factsAfterForce.publications);
    expect(await repository.head()).toBe(rootCheckpoint);
  });

  it.each(["proposal", "dispatch"] as const)(
    "rejects a credential-bearing %s AuthorizationDecision before it becomes a fact",
    async (credentialStage) => {
      const secret = "opaque-authorization-8b93e24d-71f6";
      let authorizationCalls = 0;
      let executions = 0;
      const authorization: AuthorizationPolicy = {
        credentialGuards: [createExactCredentialGuard(() => secret)],
        authorize(): AuthorizationDecision {
          authorizationCalls += 1;
          if (credentialStage === "proposal" || authorizationCalls === 2) {
            return { allow: true, revision: `policy-${authorizationCalls}`, reason: secret };
          }
          return { allow: true, revision: "policy-1", reason: "owner-approved" };
        },
      };
      const tool = fixtureTool(`credential_${credentialStage}_decision`, "external", async () => {
        executions += 1;
        return { content: "must not execute" };
      });
      const provider = toolThenThoughtScript(tool.name);
      const { runtime } = await runtimeFixture(provider, { tools: [tool], authorization });
      const { id, repository } = await readyPersona(runtime, "en", `credential-${credentialStage}`);

      const run = await runtime.start({ personaId: id });
      await waitFor(
        () => runtime.store.requireRun(run.id).phase,
        (phase) => phase === "faulted",
        `credential-bearing ${credentialStage} authorization decision rejection`,
      );

      const [call] = runtime.store.toolCallsForPersona(id);
      expect(authorizationCalls).toBe(credentialStage === "proposal" ? 1 : 2);
      expect(executions).toBe(0);
      expect(call).toMatchObject({
        name: tool.name,
        status: credentialStage === "proposal" ? "proposed" : "intent_recorded",
      });
      expect(runtime.store.authorizationDecisionsForToolCall(call?.id ?? "missing")).toHaveLength(
        credentialStage === "proposal" ? 0 : 1,
      );
      expect(runtime.store.listEvents(id)).toEqual([
        expect.objectContaining({ status: "faulted", checkpoint: null }),
      ]);
      expect(runtime.store.publications(id)).toEqual([]);
      expect(await repository.listCheckpoints()).toHaveLength(1);
      expect(
        JSON.stringify({
          run: runtime.store.requireRun(run.id),
          calls: runtime.store.toolCallsForPersona(id),
          observations: runtime.store.observations(id, 0, 10_000),
          events: runtime.store.listEvents(id),
          requests: provider.requests,
        }),
      ).not.toContain(secret);
    },
  );

  it.each(["external", "repository", "none"] as const)(
    "rejects a credential-bearing %s Tool result at the first persistence boundary",
    async (effect) => {
      const secret = "opaque-tool-result-8b93e24d-71f6";
      let executions = 0;
      const tool = fixtureTool(
        `credential_${effect}_result`,
        effect,
        async () => {
          executions += 1;
          return {
            content: "completed",
            details: { receipt: secret },
            continuation: { focus: secret },
          };
        },
        [createExactCredentialGuard(() => secret)],
      );
      const provider = toolThenThoughtScript(tool.name);
      const { runtime } = await runtimeFixture(provider, { tools: [tool] });
      const { id, repository } = await readyPersona(runtime, "en", `credential-result-${effect}`);

      await runtime.start({ personaId: id });
      await waitForPublications(runtime, id, 1);

      const [event] = runtime.store.listEvents(id);
      const [call] = runtime.store.toolCallsForPersona(id);
      const expectedCode = effect === "external" ? "external_outcome_unknown" : "operation_failed";
      expect(executions).toBe(1);
      expect(call).toMatchObject({
        name: tool.name,
        status: effect === "external" ? "unknown" : "failed",
        result: { code: expectedCode },
      });
      expect(
        runtime.store
          .observations(id, 0, 10_000)
          .filter((observation) => observation.kind === "tool_outcome")
          .map((observation) => observation.payload),
      ).toContainEqual(
        expect.objectContaining({
          state: effect === "external" ? "unknown" : "failed",
          result: effect === "external" ? null : { code: expectedCode },
          code: expectedCode,
        }),
      );
      expect(await repository.listCheckpoints()).toHaveLength(2);
      expect(
        JSON.stringify({
          calls: runtime.store.toolCallsForPersona(id),
          observations: runtime.store.observations(id, 0, 10_000),
          events: runtime.store.listEvents(id),
          entries: runtime.store.sessionEntriesForEvent(event?.id ?? "missing"),
          publications: runtime.store.publications(id),
          requests: provider.requests,
        }),
      ).not.toContain(secret);
    },
  );

  it("records intent, rechecks authorization, and blocks a permission revoked before dispatch", async () => {
    let authorizationCalls = 0;
    let executions = 0;
    const authorization: AuthorizationPolicy = {
      credentialGuards: NO_CREDENTIAL_GUARDS,
      authorize(): AuthorizationDecision {
        authorizationCalls += 1;
        return authorizationCalls === 1
          ? { allow: true, revision: "policy-allow-1" }
          : { allow: false, revision: "policy-deny-2", reason: "revoked" };
      },
    };
    const tool = fixtureTool("revocable_external", "external", async () => {
      executions += 1;
      return { content: "should not execute" };
    });
    const provider = toolThenThoughtScript(tool.name);
    const { runtime } = await runtimeFixture(provider, { tools: [tool], authorization });
    const { id } = await readyPersona(runtime);

    await runtime.start({ personaId: id });
    await waitForPublications(runtime, id, 1);

    const [call] = runtime.store.toolCallsForPersona(id);
    expect(authorizationCalls).toBe(2);
    expect(executions).toBe(0);
    expect(call).toMatchObject({
      name: tool.name,
      status: "blocked",
      authorizationRevision: "policy-deny-2",
      result: { code: "permission_revoked_before_dispatch" },
    });
    expect(call?.intentAt).not.toBeNull();
    expect(call?.dispatchAt).toBeNull();
  });

  it("holds a throwing external dispatch as unknown and never replays it on reopen", async () => {
    let executions = 0;
    const tool = fixtureTool("throwing_external", "external", async () => {
      executions += 1;
      throw new Error("external system disconnected after request");
    });
    const provider = toolThenThoughtScript(tool.name);
    const fixture = await runtimeFixture(provider, { tools: [tool] });
    const { id } = await readyPersona(fixture.runtime);

    await fixture.runtime.start({ personaId: id });
    await waitForPublications(fixture.runtime, id, 1);
    const [call] = fixture.runtime.store.toolCallsForPersona(id);
    expect(call).toMatchObject({
      name: tool.name,
      status: "unknown",
      result: { code: "external_outcome_unknown" },
    });
    expect(executions).toBe(1);

    await fixture.runtime.close();
    const reopenedProvider = ordinaryScript();
    const reopened = await KokoroRuntime.open({
      stateDirectory: fixture.stateDirectory,
      personaDirectory: fixture.personaDirectory,
      providers: [reopenedProvider],
      tools: [tool],
      defaultModel: MODEL,
    });
    runtimes.add(reopened);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executions).toBe(1);
    expect(reopenedProvider.requests).toEqual([]);
    expect(reopened.store.requireToolCall(call?.id ?? "missing").status).toBe("unknown");
  });

  it("waits for the original pending ToolCall callback without creating callback queue work or a new Event", async () => {
    let executions = 0;
    const tool = fixtureTool("pending_external", "external", async () => {
      executions += 1;
      return { content: "accepted by remote system", callbackPending: true };
    });
    const provider = toolThenThoughtScript(tool.name);
    const { runtime } = await runtimeFixture(provider, { tools: [tool] });
    const { id } = await readyPersona(runtime);
    const run = await runtime.start({ personaId: id });

    const pendingCall = await waitFor(
      () => runtime.store.toolCallsForPersona(id)[0],
      (call) => call?.status === "awaiting_callback",
      "ToolCall awaiting its callback",
    );
    expect(executions).toBe(1);
    expect(runtime.store.requireRun(run.id).waitingCode).toBe(`tool_callback:${pendingCall?.id}`);
    expect(runtime.store.listQueue(run.id)).toHaveLength(1);
    expect(runtime.store.listEvents(id)).toHaveLength(1);

    const callback = await runtime.submitCallback({
      personaId: id,
      callbackId: "callback-1",
      toolCallId: pendingCall?.id ?? "missing",
      outcome: { state: "succeeded", result: { receipt: "remote-receipt-1" } },
    });
    expect(callback).toEqual({ callbackId: "callback-1", recorded: true });
    await waitForPublications(runtime, id, 1);

    expect(runtime.store.requireToolCall(pendingCall?.id ?? "missing")).toMatchObject({
      status: "succeeded",
      result: { state: "succeeded", result: { receipt: "remote-receipt-1" } },
    });
    expect(runtime.store.listQueue(run.id)).toEqual([
      expect.objectContaining({ kind: "start", status: "completed" }),
    ]);
    expect(runtime.store.listEvents(id)).toEqual([
      expect.objectContaining({ sourceKind: "start", status: "checkpointed" }),
    ]);
  });
});

describe("KokoroRuntime run queue boundaries", () => {
  it("freezes accepted FIFO work on Pause and resumes it in the same run and Session", async () => {
    const gate = deferred();
    const provider = new ScriptedProvider(async ({ request, context, roleIndex }) => {
      if (request.role === "persona") {
        if (roleIndex === 0) await waitUnlessAborted(gate.promise, context.signal);
        return modelResponse(`private event ${roleIndex + 1}`);
      }
      if (request.role === "closeout") return strictCloseout("en", `closeout ${roleIndex + 1}`);
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime);
    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => provider.requests.filter((request) => request.role === "persona").length,
      (count) => count === 1,
      "active start Event",
    );
    const first = await runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 1 } });
    const second = await runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 2 } });

    runtime.pause(id);
    gate.resolve();
    await waitFor(
      () => runtime.store.requireRun(run.id).phase,
      (phase) => phase === "paused",
      "paused run",
    );
    expect(runtime.store.requireRun(run.id)).toMatchObject({
      id: run.id,
      sessionId: run.sessionId,
      phase: "paused",
    });
    expect(runtime.store.requireQueueItem(first.item.id).status).toBe("queued");
    expect(runtime.store.requireQueueItem(second.item.id).status).toBe("queued");
    expect(runtime.store.listEvents(id)).toHaveLength(1);

    const resumed = await runtime.resume(id);
    expect(resumed).toMatchObject({ id: run.id, sessionId: run.sessionId, phase: "running" });
    await waitForPublications(runtime, id, 3);
    expect(runtime.store.listQueue(run.id).map((item) => [item.sequence, item.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
      [3, "completed"],
    ]);
    expect(runtime.store.listEvents(id).map((event) => event.sourceKind)).toEqual([
      "start",
      "stimulus",
      "stimulus",
    ]);
  });

  it("sets a Stop admission cutoff, rejects later stimulus, and drains every accepted item without continuation", async () => {
    const gate = deferred();
    const provider = new ScriptedProvider(async ({ request, context, roleIndex }) => {
      if (request.role === "persona") {
        if (roleIndex === 0) {
          await waitUnlessAborted(gate.promise, context.signal);
          return modelResponse("request continuation while Stop is already draining", {
            toolCalls: [{ id: "stop-continuation", name: "continue_experience", arguments: {} }],
          });
        }
        return modelResponse(`drained private event ${roleIndex + 1}`);
      }
      if (request.role === "closeout") return strictCloseout("en", `drain closeout ${roleIndex + 1}`);
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id } = await readyPersona(runtime);
    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => provider.requests.filter((request) => request.role === "persona").length,
      (count) => count === 1,
      "active start Event",
    );
    await runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 1 } });
    await runtime.submitStimulus({ personaId: id, kind: "message", content: { ordinal: 2 } });

    const stopping = await runtime.stop(id);
    expect(stopping).toMatchObject({ phase: "stopping", stopCutoffSequence: 3 });
    await expect(
      runtime.submitStimulus({ personaId: id, kind: "late", content: { ordinal: 3 } }),
    ).rejects.toThrow(/not accepting new stimulus/u);
    gate.resolve();

    await waitFor(
      () => runtime.store.requireRun(run.id).phase,
      (phase) => phase === "stopped",
      "graceful Stop",
      30_000,
    );
    expect(runtime.store.listQueue(run.id)).toHaveLength(3);
    expect(runtime.store.listQueue(run.id).every((item) => item.status === "completed")).toBe(true);
    expect(runtime.store.listEvents(id)).toHaveLength(3);
    expect(runtime.store.toolCallsForPersona(id)).toContainEqual(
      expect.objectContaining({ name: "continue_experience", status: "succeeded" }),
    );
  });

  it("marks a crashed run and discards, rather than restores, its queued work on reopen", async () => {
    const gate = deferred();
    const firstProvider = new ScriptedProvider(async ({ request, context }) => {
      if (request.role === "persona") {
        await waitUnlessAborted(gate.promise, context.signal);
        return modelResponse("must be aborted");
      }
      if (request.role === "closeout") return strictCloseout("en");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const fixture = await runtimeFixture(firstProvider);
    const { id } = await readyPersona(fixture.runtime);
    const oldRun = await fixture.runtime.start({ personaId: id });
    await waitFor(
      () => firstProvider.requests.length,
      (count) => count === 1,
      "blocked active Event",
    );
    await fixture.runtime.submitStimulus({ personaId: id, kind: "message", content: { queued: true } });

    await fixture.runtime.close();
    const secondProvider = ordinaryScript("new run only");
    const reopened = await KokoroRuntime.open({
      stateDirectory: fixture.stateDirectory,
      personaDirectory: fixture.personaDirectory,
      providers: [secondProvider],
      defaultModel: MODEL,
    });
    runtimes.add(reopened);

    expect(reopened.store.requireRun(oldRun.id).phase).toBe("crashed");
    expect(reopened.store.listQueue(oldRun.id).map((item) => item.status)).toEqual([
      "discarded",
      "discarded",
    ]);
    expect(secondProvider.requests).toEqual([]);
    const newRun = await reopened.start({ personaId: id });
    expect(newRun.id).not.toBe(oldRun.id);
    expect(newRun.sessionId).not.toBe(oldRun.sessionId);
    await waitForPublications(reopened, id, 1);
    expect(reopened.store.listQueue(newRun.id)).toEqual([
      expect.objectContaining({ sequence: 1, kind: "start", status: "completed" }),
    ]);
  });

  it("creates no Checkpoint intent when Force crosses the Repository mutex first", async () => {
    const beforeCheckpoint = deferred();
    const releaseCheckpoint = deferred();
    let blocked = false;
    const provider = ordinaryScript("Event closed before its speculative Checkpoint.");
    const { runtime } = await runtimeFixture(provider, {
      async eventFault(point) {
        if (point !== "before_checkpoint" || blocked) return;
        blocked = true;
        beforeCheckpoint.resolve();
        await releaseCheckpoint.promise;
      },
    });
    const { id, rootCheckpoint, repository } = await readyPersona(runtime, "en", "force-before-checkpoint");
    const run = await runtime.start({ personaId: id });
    await beforeCheckpoint.promise;

    const forced = await runtime.force(id);
    const factsAfterForce = {
      events: runtime.store.listEvents(id),
      observations: runtime.store.observations(id, 0, 10_000),
      publications: runtime.store.publications(id),
    };
    releaseCheckpoint.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(forced).toMatchObject({ id: run.id, phase: "forced" });
    expect(await repository.head()).toBe(rootCheckpoint);
    expect(await repository.listCheckpoints()).toHaveLength(1);
    expect(runtime.store.preparedCheckpointIntents(id)).toEqual([]);
    expect(runtime.store.requirePersona(id)).toMatchObject({
      lifecycle: "forced",
      currentCheckpoint: rootCheckpoint,
      selectedCheckpoint: rootCheckpoint,
    });
    expect(runtime.store.listEvents(id)).toEqual([
      expect.objectContaining({ status: "closed", checkpoint: null }),
    ]);
    expect(runtime.store.publications(id)).toEqual([]);
    expect(runtime.store.listHippocampusJobs(id)).toEqual([]);
    expect(runtime.store.listQueue(run.id)).toEqual([expect.objectContaining({ status: "discarded" })]);
    expect(runtime.store.listEvents(id)).toEqual(factsAfterForce.events);
    expect(runtime.store.observations(id, 0, 10_000)).toEqual(factsAfterForce.observations);
    expect(runtime.store.publications(id)).toEqual(factsAfterForce.publications);
  });

  it.each(["checkpoint_intent_recorded", "checkpoint_ref_advanced", "checkpoint_fact_completed"] as const)(
    "finishes the committed Checkpoint and reconciles publication/H when Force follows %s",
    async (checkpointPoint) => {
      const checkpointReached = deferred();
      const releaseCheckpoint = deferred();
      const points: RuntimeFaultPoint[] = [];
      let blocked = false;
      const provider = new ScriptedProvider(({ request }) => {
        if (request.role === "persona") return modelResponse("Checkpoint boundary experience.");
        if (request.role === "closeout") {
          return modelResponse(
            JSON.stringify({ summary: `Force boundary at ${checkpointPoint}.`, memory: "maintain" }),
          );
        }
        if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
        return modelResponse('{"operations":[]}');
      });
      const { runtime } = await runtimeFixture(provider, {
        async eventFault(point) {
          points.push(point);
          if (point !== checkpointPoint || blocked) return;
          blocked = true;
          checkpointReached.resolve();
          await releaseCheckpoint.promise;
        },
      });
      const { id, rootCheckpoint, repository } = await readyPersona(
        runtime,
        "en",
        `force-after-${checkpointPoint.replaceAll("_", "-")}`,
      );
      const run = await runtime.start({ personaId: id });
      await checkpointReached.promise;

      const forcePromise = runtime.force(id);
      await waitFor(
        () => runtime.store.requireRun(run.id).phase,
        (phase) => phase === "forcing",
        `Force waiting after ${checkpointPoint}`,
      );
      releaseCheckpoint.resolve();
      const forced = await forcePromise;
      const [event] = runtime.store.listEvents(id);
      const checkpoint = event?.checkpoint;
      if (!checkpoint) throw new Error("The linearized Event did not complete its Checkpoint.");
      const factsAfterForce = {
        events: runtime.store.listEvents(id),
        observations: runtime.store.observations(id, 0, 10_000),
        publications: runtime.store.publications(id),
        jobs: runtime.store.listHippocampusJobs(id),
      };
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(checkpoint).not.toBe(rootCheckpoint);
      expect(forced).toMatchObject({ id: run.id, phase: "forced" });
      expect(await repository.head()).toBe(checkpoint);
      expect(runtime.store.requirePersona(id)).toMatchObject({
        lifecycle: "forced",
        currentCheckpoint: checkpoint,
        selectedCheckpoint: checkpoint,
      });
      expect(event).toMatchObject({ status: "checkpointed", checkpoint });
      expect(runtime.store.preparedCheckpointIntents(id)).toEqual([]);
      expect(runtime.store.publications(id)).toEqual([expect.objectContaining({ eventId: event.id })]);
      expect(runtime.store.listHippocampusJobs(id)).toEqual([
        expect.objectContaining({
          eventId: event.id,
          sourceCheckpoint: checkpoint,
          status: "queued",
        }),
      ]);
      expect(provider.requests.filter((request) => request.role === "hippocampus")).toEqual([]);
      expect(points).not.toContain("hippocampus_job_created");
      expect(points).not.toContain("before_publication");
      expect(points).not.toContain("publication_completed");
      const observations = runtime.store.observations(id, 0, 10_000);
      expect(observations.filter((observation) => observation.kind === "event_committed")).toHaveLength(1);
      expect(observations.filter((observation) => observation.kind === "publication")).toHaveLength(1);
      expect(observations.filter((observation) => observation.kind === "hippocampus")).toHaveLength(1);
      expect(runtime.store.listQueue(run.id)).toEqual([expect.objectContaining({ status: "discarded" })]);
      expect(runtime.store.listEvents(id)).toEqual(factsAfterForce.events);
      expect(runtime.store.observations(id, 0, 10_000)).toEqual(factsAfterForce.observations);
      expect(runtime.store.publications(id)).toEqual(factsAfterForce.publications);
      expect(runtime.store.listHippocampusJobs(id)).toEqual(factsAfterForce.jobs);
    },
  );

  it("waits for forced cancellation and restores the Repository before Force returns", async () => {
    const gate = deferred();
    const provider = new ScriptedProvider(async ({ request, context }) => {
      if (request.role === "persona") {
        await waitUnlessAborted(gate.promise, context.signal);
        return modelResponse("must never finish");
      }
      if (request.role === "closeout") return strictCloseout("en");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id, rootCheckpoint, repository } = await readyPersona(runtime);
    const original = await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8");
    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => provider.requests.filter((request) => request.role === "persona").length,
      (count) => count === 1,
      "active Event before Force",
    );
    await writeFile(
      path.join(repository.root, "workspace", "persona", "persona.md"),
      "# Persona\n\nPost-checkpoint work that Force must discard.\n",
      "utf8",
    );
    const untracked = path.join(repository.root, "workspace", "memory", "untracked.md");
    await writeFile(untracked, "untracked\n", "utf8");

    const forced = await runtime.force(id);

    expect(forced).toMatchObject({ id: run.id, phase: "forced", currentQueueItemId: null });
    expect(await repository.head()).toBe(rootCheckpoint);
    expect(await repository.isDirty()).toBe(false);
    expect(await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8")).toBe(
      original,
    );
    await expect(readFile(untracked, "utf8")).rejects.toThrow();
    expect(runtime.store.listQueue(run.id).every((item) => item.status === "discarded")).toBe(true);
  });

  it("returns Force in bounded time when a Provider ignores AbortSignal forever", async () => {
    const provider = new ScriptedProvider(async ({ request }) => {
      if (request.role === "persona") await new Promise<never>(() => undefined);
      if (request.role === "closeout") return strictCloseout("en");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const { runtime } = await runtimeFixture(provider);
    const { id, rootCheckpoint, repository } = await readyPersona(runtime);
    const original = await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8");
    const run = await runtime.start({ personaId: id });
    await waitFor(
      () => provider.requests.filter((request) => request.role === "persona").length,
      (count) => count === 1,
      "uncancellable Provider call",
    );
    await writeFile(
      path.join(repository.root, "workspace", "persona", "persona.md"),
      "# Persona\n\nForce must discard this edit despite an uncooperative Provider.\n",
      "utf8",
    );

    const forced = await Promise.race([
      runtime.force(id),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Force waited for an uncooperative Provider.")), 5_000),
      ),
    ]);

    expect(forced).toMatchObject({ id: run.id, phase: "forced", currentQueueItemId: null });
    expect(await repository.head()).toBe(rootCheckpoint);
    expect(await repository.isDirty()).toBe(false);
    expect(await readFile(path.join(repository.root, "workspace", "persona", "persona.md"), "utf8")).toBe(
      original,
    );
    const [event] = runtime.store.listEvents(id);
    expect(
      publicProviderAttempts(runtime, id, "persona").map(({ state, error }) => ({ state, error })),
    ).toEqual([
      { state: "started", error: null },
      {
        state: "aborted",
        error: expect.objectContaining({ message: "The operation was aborted before it completed." }),
      },
    ]);
    expect(runtime.store.turnsForSourceEvent(event?.id ?? "missing")).toEqual([
      expect.objectContaining({ role: "persona", status: "failed", completedAt: expect.any(Number) }),
    ]);
    expect(
      runtime
        .observations(id, 0, 10_000)
        .filter((observation) => observation.kind === "model_attempt_failed")
        .map((observation) => observation.payload),
    ).toEqual([expect.objectContaining({ role: "persona", code: "aborted" })]);
  });

  it("does not persist late Provider or repository Tool work after Force returns", async () => {
    const providerGate = deferred();
    const provider = new ScriptedProvider(async ({ request }) => {
      if (request.role === "persona") {
        await providerGate.promise;
        return modelResponse("late Provider response");
      }
      if (request.role === "closeout") return strictCloseout("en");
      if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
      return modelResponse('{"operations":[]}');
    });
    const providerFixture = await runtimeFixture(provider);
    const providerPersona = await readyPersona(providerFixture.runtime, "en", "late-provider");
    await providerFixture.runtime.start({ personaId: providerPersona.id });
    await waitFor(
      () => provider.requests.filter((request) => request.role === "persona").length,
      (count) => count === 1,
      "late Provider call",
    );
    await providerFixture.runtime.force(providerPersona.id);
    const [providerEvent] = providerFixture.runtime.store.listEvents(providerPersona.id);
    expect(
      publicProviderAttempts(providerFixture.runtime, providerPersona.id, "persona").map(
        ({ state, error }) => ({ state, error }),
      ),
    ).toEqual([
      { state: "started", error: null },
      {
        state: "aborted",
        error: expect.objectContaining({ message: "The operation was aborted before it completed." }),
      },
    ]);
    expect(providerFixture.runtime.store.turnsForSourceEvent(providerEvent?.id ?? "missing")).toEqual([
      expect.objectContaining({ role: "persona", status: "failed", completedAt: expect.any(Number) }),
    ]);
    const observationsAfterForce = providerFixture.runtime.store.observations(providerPersona.id, 0, 10_000);
    providerGate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(providerFixture.runtime.store.observations(providerPersona.id, 0, 10_000)).toEqual(
      observationsAfterForce,
    );
    expect(providerFixture.runtime.store.listEvents(providerPersona.id)).toEqual([
      expect.objectContaining({ status: "open", checkpoint: null }),
    ]);

    const toolGate = deferred();
    const latePath = "workspace/persona/late-tool.md";
    const lateTool = fixtureTool("late_repository_write", "repository", async (_arguments, context) => {
      expect(Object.isFrozen(context.repository)).toBe(true);
      expect("root" in context.repository).toBe(false);
      expect(Object.keys(context.repository).sort()).toEqual(["listFiles", "readText", "writeText"]);
      await toolGate.promise;
      const document = await context.repository.writeText(latePath, "late write\n", null);
      return {
        content: "file_written",
        details: { path: document.path, sha256: document.sha256 },
      };
    });
    const toolProvider = toolThenThoughtScript(lateTool.name);
    const toolFixture = await runtimeFixture(toolProvider, { tools: [lateTool] });
    const toolPersona = await readyPersona(toolFixture.runtime, "en", "late-tool");
    await toolFixture.runtime.start({ personaId: toolPersona.id });
    await waitFor(
      () => toolFixture.runtime.store.toolCallsForPersona(toolPersona.id)[0]?.status,
      (status) => status === "dispatching",
      "late repository Tool dispatch",
    );
    await toolFixture.runtime.force(toolPersona.id);
    const toolObservationsAfterForce = toolFixture.runtime.store.observations(toolPersona.id, 0, 10_000);
    toolGate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(toolPersona.repository.readText(latePath)).rejects.toMatchObject({ code: "invalid_path" });
    expect(toolFixture.runtime.store.observations(toolPersona.id, 0, 10_000)).toEqual(
      toolObservationsAfterForce,
    );
    expect(toolFixture.runtime.store.toolCallsForPersona(toolPersona.id)).toEqual([
      expect.objectContaining({ status: "unknown", result: null }),
    ]);
  });
});

function fixtureTool(
  name: string,
  effect: RuntimeTool["effect"],
  execute: (
    arguments_: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>,
  credentialGuards: readonly CredentialGuard[] = NO_CREDENTIAL_GUARDS,
): RuntimeTool {
  return {
    name,
    effect,
    credentialGuards,
    describe(locale: string): ModelTool {
      return {
        name,
        label: `${locale}:${name}`,
        description: `Fixture Tool ${name}`,
        inputSchema: { type: "object", additionalProperties: false },
      };
    },
    validate(arguments_: Record<string, JsonValue>): void {
      if (Object.keys(arguments_).length > 0) throw new Error("Fixture Tool accepts no arguments.");
    },
    execute,
  };
}

function toolThenThoughtScript(toolName: string): ScriptedProvider {
  return new ScriptedProvider(({ request, roleIndex }) => {
    if (request.role === "persona" && roleIndex === 0) {
      return modelResponse("I choose the fixture Tool.", {
        toolCalls: [{ id: `provider-${toolName}`, name: toolName, arguments: {} }],
      });
    }
    if (request.role === "persona") return modelResponse("I retain the authoritative Tool result.");
    if (request.role === "closeout") return strictCloseout("en");
    if (request.role === "compaction") return modelResponse('{"summary":"compact"}');
    return modelResponse('{"operations":[]}');
  });
}
