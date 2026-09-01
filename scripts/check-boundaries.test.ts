import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkspaceBoundaries } from "./check-boundaries.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace dependency boundaries", () => {
  it("accepts the intended protocol, client, runtime, and CLI dependency direction", () => {
    const root = fixture();
    packageJson(root, "packages/protocol", { name: "@kokoro/protocol", version: "1.0.0" });
    packageJson(root, "packages/client", {
      name: "@kokoro/client",
      version: "1.0.0",
      dependencies: { "@kokoro/protocol": "1.0.0" },
    });
    packageJson(root, "packages/runtime", {
      name: "@kokoro/runtime",
      version: "1.0.0",
      dependencies: { "@kokoro/protocol": "1.0.0" },
    });
    packageJson(root, "apps/cli", {
      name: "@kokoro/cli",
      version: "1.0.0",
      dependencies: {
        "@kokoro/client": "1.0.0",
        "@kokoro/protocol": "1.0.0",
        "@kokoro/runtime": "1.0.0",
      },
    });

    expect(checkWorkspaceBoundaries({ workspaceRoot: root })).toEqual([]);
  });

  it("fails closed for unmapped packages, reversed dependencies, and version drift", () => {
    const root = fixture(["packages/*"]);
    packageJson(root, "packages/protocol", {
      name: "@kokoro/protocol",
      version: "1.0.0",
      dependencies: { "@kokoro/runtime": "workspace:*" },
    });
    packageJson(root, "packages/runtime", { name: "@kokoro/runtime", version: "2.0.0" });
    packageJson(root, "packages/extra", { name: "@kokoro/extra", version: "1.0.0" });

    expect(checkWorkspaceBoundaries({ workspaceRoot: root })).toEqual(expect.arrayContaining([
      expect.stringContaining("@kokoro/protocol must not depend on @kokoro/runtime"),
      expect.stringContaining("must match root version 1.0.0"),
      expect.stringContaining("@kokoro/extra is not present in the dependency boundary map"),
    ]));
  });

  it("rejects Joko and Pi runtime dependencies in every dependency section", () => {
    const root = fixture(["packages/protocol"]);
    packageJson(root, "packages/protocol", {
      name: "@kokoro/protocol",
      version: "1.0.0",
      dependencies: { "@joko/core": "1.0.0" },
      devDependencies: { "@earendil-works/pi-coding-agent": "1.0.0" },
    });
    const allowlist = { "@kokoro/protocol": new Set<string>() };

    expect(checkWorkspaceBoundaries({ workspaceRoot: root, allowlist })).toEqual(expect.arrayContaining([
      expect.stringContaining("reference package @joko/core@1.0.0 in dependencies"),
      expect.stringContaining("reference package @earendil-works/pi-coding-agent@1.0.0 in devDependencies"),
    ]));
  });

  it("rejects aliased and sibling-checkout reference dependencies", () => {
    const root = fixture(["packages/protocol"]);
    packageJson(root, "packages/protocol", {
      name: "@kokoro/protocol",
      version: "1.0.0",
      optionalDependencies: {
        "reference-core": "npm:@joko/core@1.0.0",
        "reference-runtime": "file:../../../joko/packages/adapter-pi",
      },
    });
    const errors = checkWorkspaceBoundaries({
      workspaceRoot: root,
      allowlist: { "@kokoro/protocol": new Set<string>() },
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("reference package reference-core@npm:@joko/core@1.0.0"),
      expect.stringContaining("reference package reference-runtime@file:../../../joko/packages/adapter-pi"),
    ]));
  });

  it("reports workspace patterns that match no packages", () => {
    const root = fixture(["packages/missing"]);
    expect(checkWorkspaceBoundaries({ workspaceRoot: root, allowlist: {} })).toContain(
      "Workspace package pattern packages/missing matched no package manifests",
    );
  });
});

function fixture(workspaces: readonly string[] = ["packages/*", "apps/*"]): string {
  const root = mkdtempSync(join(tmpdir(), "kokoro-boundaries-"));
  cleanups.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", private: true, workspaces }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function packageJson(root: string, directory: string, manifest: Readonly<Record<string, unknown>>): void {
  const target = join(root, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
