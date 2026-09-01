import { readFileSync } from "node:fs";

export const CLI_PACKAGE_VERSION = readPackageVersion(
  new URL("../package.json", import.meta.url),
  "@kokoro/cli",
);

function readPackageVersion(manifestUrl: URL, packageName: string): string {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { name?: unknown; version?: unknown };
  if (
    manifest.name !== packageName ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    throw new Error(`Invalid ${packageName} package manifest.`);
  }
  return manifest.version;
}
