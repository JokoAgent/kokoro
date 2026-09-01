import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatCliFailure } from "../src/main.js";

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

describe("Kokoro CLI real-process boundary", () => {
  it("prints a zh-CN visible error without leaking an inherited Provider credential", async () => {
    const credential = "sk-cli-process-boundary-abcdefghijklmnop";
    const result = await runProcess(["unknown-process-command", "--locale", "zh-CN"], {
      KOKORO_CLI_PROCESS_CREDENTIAL: credential,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("未知命令：unknown-process-command");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(credential);
  });

  it("localizes missing required options instead of exposing parser English", async () => {
    const result = await runProcess(["serve", "--locale", "zh-CN"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("kokoro: 缺少必需选项：--config\n");
    expect(result.stderr).not.toContain("Missing required option");
  });

  it("redacts credential-like exception messages before writing stderr", () => {
    const credential = "sk-cli-exception-abcdefghijklmnop";
    const formatted = formatCliFailure(new Error(`provider failed with ${credential}`), "en");

    expect(formatted).toBe("kokoro: Operation failed; details were protected.\n");
    expect(formatted).not.toContain(credential);
  });
});

async function runProcess(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", bin, ...args], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI process did not terminate."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { exitCode, stdout, stderr };
}
