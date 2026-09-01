import { describe, expect, it } from "vitest";
import { type ModelProvider, ProviderRegistry } from "../src/model.js";
import {
  assertCredentialFree,
  captureCredentialSnapshot,
  containsCredential,
  createExactCredentialGuard,
  findCredentials,
  mergeCredentialBoundaries,
  redactCredentials,
} from "../src/security.js";
import { type RuntimeTool, ToolRegistry } from "../src/tools/index.js";

describe("credential boundary", () => {
  it.each([
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "api_key=super-secret-value",
    "-----BEGIN PRIVATE KEY-----",
    "Cookie: session=abcdef0123456789",
    ["s", "k-abcdefghijklmnopqrstuvwxyz"].join(""),
    ["AK", "IAABCDEFGHIJKLMNOP"].join(""),
    ["gh", "p_abcdefghijklmnopqrstuvwxyz123456"].join(""),
    ["github_", "pat_abcdefghijklmnopqrstuvwxyz123456"].join(""),
    ["gl", "pat-abcdefghijklmnopqrstuvwxyz123456"].join(""),
    ["np", "m_abcdefghijklmnopqrstuvwxyz123456"].join(""),
    ["s", "k_live_abcdefghijklmnopqrstuvwxyz"].join(""),
    ["AI", "zaabcdefghijklmnopqrstuvwxyz12345678"].join(""),
    ["xo", "xb-1234567890-abcdefghijklmnopqrstuvwxyz"].join(""),
  ])("detects %s without retaining the matched value", (secret) => {
    expect(containsCredential(secret)).toBe(true);
    expect(findCredentials(secret)[0]).toEqual(expect.objectContaining({ line: 1 }));
    expect(JSON.stringify(findCredentials(secret))).not.toContain(secret);
    expect(redactCredentials(secret)).not.toContain(secret);
  });

  it("reports only the surface, kind, and line", () => {
    expect(() => assertCredentialFree("hello\npassword=hunter2-secret", "stimulus")).toThrow(
      /stimulus at line 2/u,
    );
  });

  it("does not alter ordinary owner prose", () => {
    const prose = "I lost the key to my old apartment.";
    expect(redactCredentials(prose)).toBe(prose);
    expect(containsCredential(prose)).toBe(false);
  });

  it("matches an opaque credential in raw and reversible encoded forms", async () => {
    const secret = 'opaque/credential "with spaces" 8b93e24d';
    const snapshot = await captureCredentialSnapshot({
      credentialGuards: [createExactCredentialGuard(async () => secret)],
    });
    const variants = [
      secret,
      JSON.stringify({ secret }),
      encodeURIComponent(secret),
      Buffer.from(secret, "utf8").toString("base64"),
      Buffer.from(secret, "utf8").toString("base64url"),
    ];
    for (const value of variants) {
      expect(() => snapshot.assertCredentialFree(value, "opaque boundary")).toThrow(
        expect.objectContaining({ finding: "exact", surface: "opaque boundary" }),
      );
    }
  });

  it("hides a credential resolver rejection and fails closed", async () => {
    const secret = "opaque-resolver-failure-8b93e24d";
    let failure: unknown;
    try {
      await captureCredentialSnapshot(
        {
          credentialGuards: [
            createExactCredentialGuard(() => {
              throw new Error(secret);
            }),
          ],
        },
        "test component",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "CredentialBoundaryCaptureError",
      code: "credential_guard_capture_failed",
      component: "test component",
      guardIndex: 0,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(secret);
  });

  it("rebuilds a matcher rejection without exposing its custom message", async () => {
    const secret = "opaque-matcher-failure-8b93e24d";
    const snapshot = await captureCredentialSnapshot({
      credentialGuards: [
        {
          capture: () => ({
            assertCredentialFree() {
              throw new Error(secret);
            },
          }),
        },
      ],
    });

    let failure: unknown;
    try {
      snapshot.assertCredentialFree("ordinary value", "custom matcher boundary");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "CredentialBoundaryError",
      finding: "exact",
      surface: "custom matcher boundary",
      line: 1,
    });
    expect(String(failure)).not.toContain(secret);
  });

  it("hides a credential boundary getter rejection and fails closed", async () => {
    const secret = "opaque-boundary-getter-failure-8b93e24d";
    const boundary = Object.defineProperty({}, "credentialGuards", {
      get() {
        throw new Error(secret);
      },
    });
    let failure: unknown;
    try {
      await captureCredentialSnapshot(boundary as { credentialGuards: [] }, "getter component");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "CredentialBoundaryCaptureError",
      code: "credential_guard_capture_failed",
      component: "getter component",
      guardIndex: -1,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(secret);
  });

  it("includes credentials from components registered after boundaries are merged", async () => {
    const providers = new ProviderRegistry();
    const tools = new ToolRegistry();
    const merged = mergeCredentialBoundaries([providers, tools]);
    const providerSecret = "opaque-dynamic-provider-8b93e24d";
    const toolSecret = "opaque-dynamic-tool-8b93e24d";

    providers.register({
      id: "dynamic-provider",
      credentialGuards: [createExactCredentialGuard(() => providerSecret)],
      listModels: () => [],
      complete: async () => {
        throw new Error("unused");
      },
    });
    tools.register({
      name: "dynamic_tool",
      effect: "none",
      credentialGuards: [createExactCredentialGuard(() => toolSecret)],
      describe: () => ({ name: "dynamic_tool", label: "Dynamic", description: "", inputSchema: {} }),
      validate: () => undefined,
      execute: async () => ({ content: "unused" }),
    });

    const snapshot = await captureCredentialSnapshot(merged);
    expect(() => snapshot.assertCredentialFree(providerSecret, "dynamic Provider output")).toThrow(
      expect.objectContaining({ finding: "exact" }),
    );
    expect(() => snapshot.assertCredentialFree(toolSecret, "dynamic Tool output")).toThrow(
      expect.objectContaining({ finding: "exact" }),
    );
  });

  it("rejects Provider and RuntimeTool registration without an explicit declaration", () => {
    const provider = {
      id: "missing-boundary",
      listModels: () => [],
      complete: async () => {
        throw new Error("unused");
      },
    } as unknown as ModelProvider;
    expect(() => new ProviderRegistry([provider])).toThrow(
      expect.objectContaining({ name: "CredentialBoundaryConfigurationError" }),
    );

    const tool = {
      name: "missing_boundary",
      effect: "none",
      describe: () => ({ name: "missing_boundary", label: "Missing", description: "", inputSchema: {} }),
      validate: () => undefined,
      execute: async () => ({ content: "unused" }),
    } as unknown as RuntimeTool;
    expect(() => new ToolRegistry([tool])).toThrow(
      expect.objectContaining({ name: "CredentialBoundaryConfigurationError" }),
    );
  });
});
