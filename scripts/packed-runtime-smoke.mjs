import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectNodeSocket } from "@kokoro/client/node";
import { hasExactDeliveredPublicationCoverage } from "./release-utils.mjs";

const consumerDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryParent = process.platform === "win32" ? tmpdir() : "/tmp";
const root = await mkdtemp(join(temporaryParent, "kokoro-packed-runtime-"));
const stateDirectory = join(root, "state");
const personaDirectory = join(root, "personas");
const ipcDirectory = join(root, "ipc");
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\kokoro-packed-${process.pid}-${randomUUID()}`
    : join(ipcDirectory, "kokoro.sock");
const credential = `packed-secret-${randomUUID()}`;
const credentialEnvironment = `KOKORO_PACKED_API_KEY_${process.pid}`;
const personaId = `packed-persona-${randomUUID()}`;
const publicResults = [];
let client;
let cli;
let provider;
let unsubscribeObservations;
let cliStopping = false;
let failure;
const liveObservations = [];

try {
  await mkdir(ipcDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(ipcDirectory, 0o700);
  provider = await startProvider(credential);
  const configPath = join(root, "kokoro.config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        stateDirectory,
        personaDirectory,
        socketPath,
        defaultModel: { provider: "packed-provider", model: "packed-model" },
        providers: [
          {
            type: "openai-compatible",
            id: "packed-provider",
            baseUrl: provider.baseUrl,
            apiKeyEnv: credentialEnvironment,
            models: [
              {
                id: "packed-model",
                displayName: "Packed smoke model",
                contextWindow: 40_000,
                maxOutputTokens: 2_048,
                reasoning: false,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  cli = await startInstalledCli(configPath, credentialEnvironment, credential);
  client = await connectNodeSocket({
    clientName: "kokoro-packed-runtime-smoke",
    clientVersion: "0.1.0",
    requestTimeoutMs: 30_000,
    socket: { path: socketPath, connectTimeoutMs: 10_000 },
  });
  const installedRuntimeManifest = JSON.parse(
    await readFile(join(consumerDirectory, "node_modules", "@kokoro", "runtime", "package.json"), "utf8"),
  );
  assert.equal(
    client.capabilities?.serverVersion,
    installedRuntimeManifest.version,
    "the Runtime capability version does not match the installed package",
  );
  unsubscribeObservations = client.subscribeObservations((record) => {
    if (record.personaId === personaId) liveObservations.push(record);
  });

  const created = await client.createDraft(
    {
      templateId: "default",
      personaId,
      displayName: "打包运行时 Persona",
      uiLocale: "zh-CN",
      promptLocale: "zh-CN",
    },
    { expectedRevision: null },
  );
  publicResults.push(created);
  assert.equal(created.personaId, personaId);

  const draftDocuments = await client.ownerDocuments({ personaId, path: null });
  publicResults.push(draftDocuments);
  const personaDocument = draftDocuments.documents.find(
    (document) => document.path === "workspace/persona/persona.md",
  );
  assert.ok(personaDocument, "the public Owner document API did not return the draft Persona document");
  const editedPersonaContent =
    "# 打包运行时 Persona\n\n我会仔细理解收到的请求，并产出简洁、可验证的工作成果。\n";
  const editedPersona = await client.putOwnerDocument({
    personaId,
    path: personaDocument.path,
    content: editedPersonaContent,
    expectedSha256: personaDocument.sha256,
  });
  publicResults.push(editedPersona);
  const verifiedPersona = await client.ownerDocuments({ personaId, path: personaDocument.path });
  publicResults.push(verifiedPersona);
  assert.equal(verifiedPersona.documents.length, 1);
  assert.equal(verifiedPersona.documents[0]?.content, editedPersonaContent);
  assert.equal(verifiedPersona.documents[0]?.sha256, editedPersona.document.sha256);

  publicResults.push(
    await client.init({ personaId, expectedWorkingTreeDigest: null }, { expectedRevision: null }),
  );
  await waitForPersona(client, personaId, (persona) => persona.phase === "initialized", "initialization");

  publicResults.push(
    await client.start(
      {
        personaId,
        from: { kind: "current_working_tree" },
        model: null,
        promptLocale: null,
      },
      { expectedRevision: null },
    ),
  );
  await waitForPersona(client, personaId, (persona) => persona.phase === "running", "running phase");

  let observations = await waitForObservations(
    liveObservations,
    (records) =>
      hasExactDeliveredPublicationCoverage(records, 1) &&
      records.some(
        (record) => record.observation.kind === "hippocampus" && record.observation.state === "applied",
      ),
    "first Event publication and Hippocampus apply",
  );
  assert.ok(
    observations.some(
      (record) => record.observation.kind === "tool_dispatch" && record.observation.state === "dispatched",
    ),
    "the installed Runtime did not dispatch the built-in Tool",
  );
  assert.ok(
    observations.some(
      (record) => record.observation.kind === "tool_outcome" && record.observation.state === "succeeded",
    ),
    `the installed Runtime did not record a successful built-in Tool outcome: ${JSON.stringify(
      observations
        .filter((record) => record.observation.kind === "tool_outcome")
        .map((record) => record.observation),
    )}`,
  );
  const readProposal = observations.find(
    (record) => record.observation.kind === "tool_proposal" && record.observation.toolName === "read_file",
  );
  assert.ok(readProposal?.observation.kind === "tool_proposal", "the model did not verify the written file");
  const readOutcome = observations.find(
    (record) =>
      record.observation.kind === "tool_outcome" &&
      record.observation.toolCallId === readProposal.observation.toolCallId,
  );
  assert.ok(
    readOutcome?.observation.kind === "tool_outcome" && readOutcome.observation.state === "succeeded",
  );
  assert.match(JSON.stringify(readOutcome.observation.result), /通过已安装的 Runtime 写入/u);
  const packedMemory = await client.ownerDocuments({
    personaId,
    path: "workspace/memory/2026-08-30/packed-memory.md",
  });
  publicResults.push(packedMemory);
  assert.match(packedMemory.documents[0]?.content ?? "", /可长期保留的打包安装经历/u);

  const stimulus = await client.submitStimulus(
    {
      personaId,
      idempotencyKey: `packed-stimulus-${randomUUID()}`,
      stimulus: {
        kind: "user_message",
        content: { text: "请在打包安装的 Tool 结果之后再反思一次。" },
        occurredAt: null,
        source: "packed-runtime-smoke",
      },
    },
    { expectedRevision: null },
  );
  publicResults.push(stimulus);
  observations = await waitForObservations(
    liveObservations,
    (records) => hasExactDeliveredPublicationCoverage(records, 2),
    "stimulus Event checkpoint and publication",
  );

  const history = await client.history(
    { personaId, beforeCheckpointId: null, limit: 20 },
    { expectedRevision: null },
  );
  publicResults.push(history);
  assert.ok(history.checkpoints.length >= 3, "history does not contain root plus two Event Checkpoints");
  assert.equal(
    new Set(history.checkpoints.map((checkpoint) => checkpoint.commitId)).size,
    history.checkpoints.length,
  );

  publicResults.push(await client.stop(personaId, { expectedRevision: null }));
  const stopped = await waitForPersona(client, personaId, (persona) => persona.phase === "stopped", "Stop");
  const finalObservations = await allObservations(client, personaId);
  assert.ok(
    hasExactDeliveredPublicationCoverage(finalObservations, 2),
    "not every committed Event has a matching delivered publication",
  );
  assert.ok(count(finalObservations, "model_input") >= 6, "not all model roles were observable");
  assert.ok(
    finalObservations.some(
      (record) => record.observation.kind === "model_input" && record.observation.role === "hippocampus",
    ),
    "Hippocampus model input was not observable",
  );
  assert.ok(provider.roles.includes("persona"));
  assert.ok(provider.roles.includes("closeout"));
  assert.ok(provider.roles.includes("hippocampus"));
  assert.ok(provider.roles.includes("compaction"));
  const providerBodies = JSON.stringify(provider.requests.map((request) => request.body));
  assert.match(providerBodies, /文件写入结果（Tool 权威报告）/u);
  assert.match(providerBodies, /文件读取结果（Tool 数据原文）/u);
  for (const request of provider.requests) {
    const system = request.body.messages?.[0]?.content ?? "";
    if (request.role === "persona") assert.match(system, /当前在 Kokoro 中运行的 Persona/u);
    else if (request.role === "closeout") assert.match(system, /Kokoro 的 Event closeout 角色/u);
    else if (request.role === "hippocampus") assert.match(system, /Kokoro 的 Hippocampus/u);
    else assert.match(system, /Kokoro 的 Context compaction 角色/u);
  }
  assert.ok(provider.requests.every((request) => request.authorization === `Bearer ${credential}`));
  assert.ok(
    provider.requests.every((request) => !JSON.stringify(request.body).includes(credential)),
    "provider credential leaked into a model request body",
  );

  const publicData = JSON.stringify({
    commandResults: publicResults,
    snapshot: { revision: client.snapshot?.revision, persona: stopped },
    history,
    observations: finalObservations,
  });
  assert.equal(publicData.includes(credential), false, "provider credential leaked into public data");

  process.stdout.write(
    `Packed Runtime Persona loop passed (${history.checkpoints.length} checkpoints, ${finalObservations.length} observations).\n`,
  );
} catch (error) {
  failure = error;
} finally {
  unsubscribeObservations?.();
  client?.dispose();
  if (cli) {
    cliStopping = true;
    try {
      await stopChild(cli);
    } catch (error) {
      failure ??= error;
    }
  }
  if (provider) {
    try {
      await provider.close();
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    failure ??= error;
  }
}

if (failure) throw failure;

async function startInstalledCli(configPath, keyName, keyValue) {
  const manifestPath = join(consumerDirectory, "node_modules", "@kokoro", "cli", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const relativeBin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin && typeof manifest.bin === "object"
        ? (manifest.bin.kokoro ?? Object.values(manifest.bin)[0])
        : undefined;
  assert.equal(typeof relativeBin, "string", "installed @kokoro/cli has no executable");
  const packageDirectory = dirname(manifestPath);
  const executable = resolve(packageDirectory, relativeBin);
  assert.ok(
    isAbsolute(executable) &&
      executable.startsWith(`${packageDirectory}${process.platform === "win32" ? "\\" : "/"}`),
  );

  const child = spawn(process.execPath, [executable, "serve", "--config", configPath], {
    cwd: consumerDirectory,
    env: { ...process.env, [keyName]: keyValue },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`installed CLI did not listen in time\n${stdout}\n${stderr}`)),
      20_000,
    );
    const inspect = () => {
      if (!/Kokoro (?:listening on|正在监听)/u.test(stdout)) return;
      clearTimeout(timeout);
      cleanup();
      resolveReady();
    };
    const exited = (code, signal) => {
      if (cliStopping) return;
      clearTimeout(timeout);
      cleanup();
      rejectReady(
        new Error(`installed CLI exited before listening (${code ?? signal})\n${stdout}\n${stderr}`),
      );
    };
    const failed = (error) => {
      clearTimeout(timeout);
      cleanup();
      rejectReady(error);
    };
    const cleanup = () => {
      child.stdout.off("data", inspect);
      child.off("exit", exited);
      child.off("error", failed);
    };
    child.stdout.on("data", inspect);
    child.once("exit", exited);
    child.once("error", failed);
    inspect();
  });
  return child;
}

async function startProvider(expectedCredential) {
  const requests = [];
  const roles = [];
  let personaCalls = 0;
  let closeoutCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const body = JSON.parse(await readRequest(request));
      const authorization = request.headers.authorization;
      assert.equal(authorization, `Bearer ${expectedCredential}`);
      const system = body.messages?.[0]?.content;
      assert.equal(typeof system, "string");
      const role = modelRole(system);
      roles.push(role);
      requests.push({ authorization, body, role });

      let content = "";
      let toolCalls;
      let finishReason = "stop";
      if (role === "persona") {
        if (personaCalls === 0) {
          content = null;
          toolCalls = [
            {
              id: "packed-write-file-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "workspace/work/packed-output.md",
                  content: "# 打包输出\n\n这是通过已安装的 Runtime 写入的。\n",
                  expectedSha256: null,
                }),
              },
            },
          ];
          finishReason = "tool_calls";
        } else if (personaCalls === 1) {
          content = null;
          toolCalls = [
            {
              id: "packed-read-file-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "workspace/work/packed-output.md" }),
              },
            },
          ];
          finishReason = "tool_calls";
        } else if (personaCalls === 2) {
          content = `我把成功的内置 Tool 结果作为私有认知保留下来。\n${"经历".repeat(42_500)}`;
        } else {
          content = "我把新的 stimulus 纳入了第二次私有经历。";
        }
        personaCalls += 1;
      } else if (role === "closeout") {
        content = JSON.stringify({
          summary:
            closeoutCalls === 0
              ? "通过内置 Tool 创建了 Owner 可见的工作成果。"
              : "处理了明确提交的打包安装 stimulus。",
          memory: closeoutCalls === 0 ? "maintain" : "none",
        });
        closeoutCalls += 1;
      } else if (role === "hippocampus") {
        content = JSON.stringify({
          operations: [
            {
              kind: "create",
              path: "workspace/memory/2026-08-30/packed-memory.md",
              content: "# 打包记忆\n\n一次可长期保留的打包安装经历创建了经过验证的工作成果。\n",
            },
          ],
        });
      } else {
        content = JSON.stringify({ summary: "在不改变事实的前提下压缩打包安装历史。" });
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `packed-response-${requests.length}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content,
                ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
              },
              finish_reason: finishReason,
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    roles,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
  };
}

function modelRole(system) {
  if (
    system.includes("Persona currently running in Kokoro") ||
    system.includes("当前在 Kokoro 中运行的 Persona")
  ) {
    return "persona";
  }
  if (system.includes("Event closeout role") || system.includes("Event closeout 角色")) return "closeout";
  if (system.includes("Kokoro's Hippocampus") || system.includes("Kokoro 的 Hippocampus")) {
    return "hippocampus";
  }
  if (system.includes("Context compaction role") || system.includes("Context compaction 角色")) {
    return "compaction";
  }
  throw new Error("unrecognized Kokoro model role");
}

async function readRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error("provider request exceeded smoke limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForPersona(clientInstance, selectedPersonaId, accept, label) {
  const deadline = Date.now() + 30_000;
  let latest;
  for (;;) {
    await clientInstance.refreshSnapshot({ expectedRevision: null });
    latest = clientInstance.snapshot?.personas.find((persona) => persona.personaId === selectedPersonaId);
    if (latest && accept(latest)) return latest;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(latest)}`);
    await delay(25);
  }
}

async function waitForObservations(observed, accept, label) {
  const deadline = Date.now() + 40_000;
  let latest = [];
  for (;;) {
    latest = [...observed];
    if (accept(latest)) return latest;
    if (Date.now() >= deadline) {
      const diagnostics = latest
        .filter((item) => item.observation.kind === "diagnostic")
        .map((item) => item.observation);
      throw new Error(
        `timed out waiting for ${label}; observed: ${latest.map((item) => item.observation.kind).join(", ")}; diagnostics: ${JSON.stringify(diagnostics)}`,
      );
    }
    await delay(25);
  }
}

async function allObservations(clientInstance, selectedPersonaId) {
  const result = await clientInstance.observations(
    { personaId: selectedPersonaId, afterCursor: null, limit: 10_000, kinds: null },
    { expectedRevision: null },
  );
  return result.observations;
}

function count(observations, kind) {
  return observations.filter((record) => record.observation.kind === kind).length;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
