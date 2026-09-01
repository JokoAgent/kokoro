import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertSafeCleanupTarget,
  hasExactDeliveredPublicationCoverage,
  isStrictDescendant,
  publicExportSpecifiers,
  validatePackageEntries,
} from "./release-utils.mjs";

const fileEntry = (name: string, text = "") => ({
  body: new TextEncoder().encode(text),
  name,
  size: text.length,
  type: "0",
});

describe("release path guards", () => {
  test("recognizes only strict descendants", () => {
    const root = resolve("test-repository");
    expect(isStrictDescendant(join(root, "packages", "a"), root)).toBe(true);
    expect(isStrictDescendant(root, root)).toBe(false);
    expect(isStrictDescendant(`${root}-other`, root)).toBe(false);
  });

  test("cleanup accepts only named artifacts below the repository", () => {
    const root = resolve("test-repository");
    const artifact = join(root, "packages", "a", "dist");
    expect(assertSafeCleanupTarget(artifact, root, new Set(["dist"]))).toBe(artifact);
    expect(() =>
      assertSafeCleanupTarget(resolve(`${root}-outside`, "dist"), root, new Set(["dist"])),
    ).toThrow();
    expect(() =>
      assertSafeCleanupTarget(join(root, "packages", "a", "src"), root, new Set(["dist"])),
    ).toThrow();
  });
});

describe("packed archive guards", () => {
  test("allows the intentionally public package surface", () => {
    expect(() =>
      validatePackageEntries(
        [
          fileEntry("package/package.json", "{}"),
          fileEntry("package/README.md", "Kokoro"),
          fileEntry("package/dist/index.js", "export const ok = true;"),
          fileEntry("package/dist/index.d.ts", "export declare const ok: true;"),
        ],
        "@kokoro/client",
        "/repo",
      ),
    ).not.toThrow();
  });

  test.each([
    "package/LICENSE",
    "package/src/index.ts",
    "package/test/runtime.test.js",
    "package/dist/.tsbuildinfo",
    "package/../../outside",
  ])("rejects non-release path %s", (name) => {
    expect(() =>
      validatePackageEntries(
        [fileEntry("package/package.json", "{}"), fileEntry("package/README.md"), fileEntry(name)],
        "@kokoro/runtime",
        "/repo",
      ),
    ).toThrow();
  });
});

test("public exports are explicit and importable", () => {
  expect(
    publicExportSpecifiers("@kokoro/client", {
      exports: { ".": "./dist/index.js", "./node": "./dist/node.js", "./package.json": "./package.json" },
    }),
  ).toEqual(["@kokoro/client", "@kokoro/client/node", "@kokoro/client/package.json"]);
  expect(() => publicExportSpecifiers("pkg", { exports: { "./*": "./dist/*.js" } })).toThrow();
});

describe("packed Persona publication coverage", () => {
  const committed = (eventId: string, checkpointId: string) => ({
    observation: {
      kind: "event_committed",
      eventId,
      checkpoint: { checkpointId },
    },
  });
  const publication = (eventId: string, checkpointId: string, state: string) => ({
    observation: { kind: "publication", eventId, checkpointId, state },
  });

  test("requires a matching delivered publication for every distinct committed Event", () => {
    const commits = [committed("event-1", "checkpoint-1"), committed("event-2", "checkpoint-2")];
    expect(
      hasExactDeliveredPublicationCoverage(
        [
          ...commits,
          publication("event-1", "checkpoint-1", "pending"),
          publication("event-1", "checkpoint-1", "delivering"),
        ],
        2,
      ),
    ).toBe(false);
    expect(
      hasExactDeliveredPublicationCoverage(
        [
          ...commits,
          publication("event-1", "checkpoint-1", "delivered"),
          publication("event-1", "checkpoint-1", "delivered"),
        ],
        2,
      ),
    ).toBe(false);
    expect(
      hasExactDeliveredPublicationCoverage(
        [
          ...commits,
          publication("event-1", "wrong-checkpoint", "delivered"),
          publication("event-2", "checkpoint-2", "delivered"),
        ],
        2,
      ),
    ).toBe(false);
    expect(
      hasExactDeliveredPublicationCoverage(
        [
          ...commits,
          publication("event-1", "checkpoint-1", "pending"),
          publication("event-1", "checkpoint-1", "delivered"),
          publication("event-2", "checkpoint-2", "delivered"),
        ],
        2,
      ),
    ).toBe(true);
  });

  test("rejects duplicate Event authority that changes its checkpoint", () => {
    expect(
      hasExactDeliveredPublicationCoverage(
        [
          committed("event-1", "checkpoint-1"),
          committed("event-1", "checkpoint-2"),
          publication("event-1", "checkpoint-2", "delivered"),
        ],
        1,
      ),
    ).toBe(false);
  });
});
