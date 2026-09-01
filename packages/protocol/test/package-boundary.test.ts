import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("has no runtime dependency or Node import", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(manifest.dependencies).toBeUndefined();
  for (const name of await readdir(new URL("../src", import.meta.url))) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
    expect(source, name).not.toMatch(/(?:from|import\s*)\s*["']node:/);
  }
});
