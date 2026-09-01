import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertUnixSocketPathLength, CliConfigError, loadConfig } from "../src/config.js";

const roots: string[] = [];

async function sandbox(prefix: string): Promise<string> {
  const temporaryParent = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = await mkdtemp(path.join(temporaryParent, prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env["KOKORO_CLI_TEST_KEY"];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI configuration", () => {
  it("resolves owned paths and keeps provider credentials behind an environment reference", async () => {
    const root = await sandbox("kokoro-cli-config-");
    const file = path.join(root, "config.json");
    const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\kokoro-cli-test" : "./kokoro.sock";
    await writeFile(
      file,
      JSON.stringify({
        stateDirectory: "./state",
        personaDirectory: "./personas",
        socketPath,
        defaultModel: { provider: "fixture", model: "fixture-model" },
        providers: [
          {
            type: "openai-compatible",
            id: "fixture",
            baseUrl: "http://127.0.0.1:9876/v1",
            apiKeyEnv: "KOKORO_CLI_TEST_KEY",
            models: [
              {
                id: "fixture-model",
                displayName: "Fixture Model",
                contextWindow: 16_384,
                maxOutputTokens: 1_024,
                reasoning: false,
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const config = await loadConfig(file);
    expect(config.stateDirectory).toBe(path.join(root, "state"));
    expect(config.personaDirectory).toBe(path.join(root, "personas"));
    expect(config.socketPath).toBe(
      process.platform === "win32" ? socketPath : path.join(root, "kokoro.sock"),
    );
    expect(config.defaultModel).toEqual({ provider: "fixture", model: "fixture-model" });
    expect(config.providers[0]).not.toHaveProperty("apiKeyEnv");
    const credential = config.providers[0]?.apiKey;
    expect(typeof credential).toBe("function");
    expect(() => (credential as () => string)()).toThrow(/environment variable is not set/u);
    process.env["KOKORO_CLI_TEST_KEY"] = "credential-read-only-at-use";
    expect((credential as () => string)()).toBe("credential-read-only-at-use");
  });

  it("rejects unknown fields instead of silently accepting misspelled security settings", async () => {
    const root = await sandbox("kokoro-cli-config-invalid-");
    const file = path.join(root, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        stateDirectory: "./state",
        personaDirectory: "./personas",
        socketPath: process.platform === "win32" ? "\\\\.\\pipe\\kokoro-cli-invalid" : "./kokoro.sock",
        providers: [],
        apiKey: "must-not-be-accepted",
      }),
      "utf8",
    );

    await expect(loadConfig(file)).rejects.toBeInstanceOf(CliConfigError);
  });

  it("rejects credential-like material in paths that may reach diagnostics", async () => {
    const root = await sandbox("kokoro-cli-config-secret-path-");
    const file = path.join(root, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        stateDirectory: "./state",
        personaDirectory: "./personas",
        socketPath:
          process.platform === "win32" ? "\\\\.\\pipe\\sk-abcdefghijklmnop" : "./sk-abcdefghijklmnop.sock",
        providers: [],
      }),
      "utf8",
    );

    await expect(loadConfig(file)).rejects.toMatchObject({
      name: "CliConfigError",
      message: "socketPath contains credential-like material.",
    });
  });

  it("enforces Unix socket limits in UTF-8 bytes for macOS and Linux", () => {
    expect(() => assertUnixSocketPathLength("x".repeat(103), "darwin")).not.toThrow();
    expect(() => assertUnixSocketPathLength("x".repeat(104), "darwin")).toThrow(
      /darwin supports at most 103/u,
    );
    expect(() => assertUnixSocketPathLength("x".repeat(107), "linux")).not.toThrow();
    expect(() => assertUnixSocketPathLength("x".repeat(108), "linux")).toThrow(
      /linux supports at most 107/u,
    );
    expect(() => assertUnixSocketPathLength("界".repeat(35), "darwin")).toThrow(
      /uses 105 UTF-8 bytes/u,
    );
  });
});
