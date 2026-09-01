import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("published package boundary", () => {
  it("keeps every root-entry source free of Node imports", async () => {
    const rootSources = ["client.ts", "errors.ts", "index.ts", "state.ts", "transport.ts", "types.ts"];
    for (const name of rootSources) {
      const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(source, name).not.toMatch(/(?:from|import\s*)\s*["']node:/);
    }
  });

  it("exports Node transport only through ./node and has one runtime dependency", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    expect(manifest.dependencies).toEqual({ "@kokoro/protocol": "0.1.0" });
    expect(Object.keys(manifest.exports ?? {})).toEqual([".", "./node", "./package.json"]);
  });

  it("does not accidentally add another environment-specific source entry", async () => {
    const entries = (await readdir(new URL("../src", import.meta.url))).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(entries.filter((name) => name !== "node.ts").sort()).toEqual([
      "client.ts",
      "errors.ts",
      "index.ts",
      "state.ts",
      "transport.ts",
      "types.ts",
    ]);
  });
});
