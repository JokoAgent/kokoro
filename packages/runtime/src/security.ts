import { createHash } from "node:crypto";

export interface CredentialFinding {
  kind:
    | "access_token"
    | "api_key"
    | "authorization"
    | "cookie"
    | "exact"
    | "private_key"
    | "secret_assignment";
  line: number;
}

export interface CredentialMatcher {
  assertCredentialFree(value: string, surface: string): void;
}

export interface CredentialGuard {
  capture(): Promise<CredentialMatcher | null> | CredentialMatcher | null;
}

export interface CredentialBoundary {
  readonly credentialGuards: readonly CredentialGuard[];
}

export const NO_CREDENTIAL_GUARDS: readonly CredentialGuard[] = Object.freeze([]);

export class CredentialSnapshot implements CredentialMatcher {
  readonly #matchers: readonly CredentialMatcher[];

  constructor(matchers: readonly CredentialMatcher[]) {
    this.#matchers = Object.freeze([...matchers]);
  }

  assertCredentialFree(value: string, surface: string): void {
    assertCredentialFree(value, surface);
    for (const matcher of this.#matchers) {
      try {
        matcher.assertCredentialFree(value, surface);
      } catch (error) {
        const line =
          error instanceof CredentialBoundaryError &&
          error.finding === "exact" &&
          Number.isSafeInteger(error.line) &&
          error.line > 0
            ? error.line
            : 1;
        // Matchers are extension code. Rebuild even a CredentialBoundaryError
        // so a custom error message can never smuggle the matched value out.
        throw new CredentialBoundaryError(surface, "exact", line);
      }
    }
  }
}

export function createExactCredentialGuard(
  capture: () => Promise<string | null | undefined> | string | null | undefined,
): CredentialGuard {
  return Object.freeze({
    async capture(): Promise<CredentialMatcher | null> {
      const secret = await capture();
      return secret === null || secret === undefined || secret === ""
        ? null
        : new ExactCredentialMatcher(secret);
    },
  });
}

export function assertCredentialBoundary(
  value: unknown,
  component: string,
): asserts value is CredentialBoundary {
  let guards: unknown;
  try {
    guards = (value as { credentialGuards?: unknown } | null)?.credentialGuards;
  } catch {
    throw new CredentialBoundaryConfigurationError(component);
  }
  if (!Array.isArray(guards) || guards.some((guard) => typeof guard?.capture !== "function")) {
    throw new CredentialBoundaryConfigurationError(component);
  }
}

export function mergeCredentialBoundaries(boundaries: readonly CredentialBoundary[]): CredentialBoundary {
  return Object.freeze({
    get credentialGuards(): readonly CredentialGuard[] {
      return Object.freeze(boundaries.flatMap((boundary) => [...boundary.credentialGuards]));
    },
  });
}

export async function captureCredentialSnapshot(
  boundary: CredentialBoundary,
  component = "credential boundary",
): Promise<CredentialSnapshot> {
  let guards: readonly CredentialGuard[];
  try {
    guards = [...boundary.credentialGuards];
  } catch {
    throw new CredentialBoundaryCaptureError(component, -1);
  }
  const captured = await Promise.all(
    guards.map(async (guard, index) => {
      try {
        const matcher = await guard.capture();
        if (matcher !== null && typeof matcher.assertCredentialFree !== "function") {
          throw new Error("invalid matcher");
        }
        return matcher;
      } catch {
        throw new CredentialBoundaryCaptureError(component, index);
      }
    }),
  );
  return new CredentialSnapshot(captured.filter((matcher): matcher is CredentialMatcher => matcher !== null));
}

const CREDENTIAL_PATTERNS: ReadonlyArray<{
  kind: CredentialFinding["kind"];
  expression: RegExp;
}> = [
  { kind: "private_key", expression: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/giu },
  {
    kind: "authorization",
    expression: /\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+/=-]{12,}/giu,
  },
  { kind: "cookie", expression: /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]{12,}/giu },
  { kind: "api_key", expression: /\b(?:sk|rk|pk|key)-[A-Za-z0-9_-]{16,}\b/gu },
  { kind: "api_key", expression: /\bAKIA[A-Z0-9]{16}\b/gu },
  { kind: "access_token", expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu },
  { kind: "access_token", expression: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { kind: "access_token", expression: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu },
  { kind: "access_token", expression: /\bnpm_[A-Za-z0-9]{20,}\b/gu },
  { kind: "api_key", expression: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu },
  { kind: "api_key", expression: /\bAIza[A-Za-z0-9_-]{30,}\b/gu },
  { kind: "access_token", expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  {
    kind: "secret_assignment",
    expression:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/giu,
  },
];

export function findCredentials(value: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  for (const { kind, expression } of CREDENTIAL_PATTERNS) {
    expression.lastIndex = 0;
    for (let match = expression.exec(value); match !== null; match = expression.exec(value)) {
      const line = value.slice(0, match.index).split("\n").length;
      findings.push({ kind, line });
      if (match[0].length === 0) expression.lastIndex += 1;
    }
  }
  return findings.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

export function containsCredential(value: string): boolean {
  return findCredentials(value).length > 0;
}

export function redactCredentials(value: string): string {
  let sanitized = value;
  for (const { expression } of CREDENTIAL_PATTERNS) {
    expression.lastIndex = 0;
    sanitized = sanitized.replace(expression, "[REDACTED]");
  }
  return sanitized;
}

export function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function assertCredentialFree(value: string, surface: string): void {
  const findings = findCredentials(value);
  if (findings.length > 0) {
    const first = findings[0];
    throw new CredentialBoundaryError(surface, first?.kind ?? "secret_assignment", first?.line ?? 1);
  }
}

export class CredentialBoundaryError extends Error {
  readonly surface: string;
  readonly finding: CredentialFinding["kind"];
  readonly line: number;

  constructor(surface: string, finding: CredentialFinding["kind"], line: number) {
    super(`Credential-like content was rejected from ${surface} at line ${line}.`);
    this.name = "CredentialBoundaryError";
    this.surface = surface;
    this.finding = finding;
    this.line = line;
  }
}

export class CredentialBoundaryConfigurationError extends Error {
  readonly component: string;

  constructor(component: string) {
    super(`${component} must explicitly declare credentialGuards.`);
    this.name = "CredentialBoundaryConfigurationError";
    this.component = component;
  }
}

export class CredentialBoundaryCaptureError extends Error {
  readonly code = "credential_guard_capture_failed";
  readonly component: string;
  readonly guardIndex: number;

  constructor(component: string, guardIndex: number) {
    super(`Credential guard capture failed for ${component} at index ${guardIndex}.`);
    this.name = "CredentialBoundaryCaptureError";
    this.component = component;
    this.guardIndex = guardIndex;
  }
}

class ExactCredentialMatcher implements CredentialMatcher {
  readonly #variants: readonly string[];

  constructor(secret: string) {
    const json = JSON.stringify(secret);
    const urlEncoded = encodeURIComponent(secret);
    const base64 = Buffer.from(secret, "utf8").toString("base64");
    this.#variants = Object.freeze(
      [
        ...new Set([
          secret,
          json.slice(1, -1),
          urlEncoded,
          urlEncoded.replace(/%20/gu, "+"),
          base64,
          Buffer.from(secret, "utf8").toString("base64url"),
        ]),
      ].filter((variant) => variant !== ""),
    );
  }

  assertCredentialFree(value: string, surface: string): void {
    let firstIndex = -1;
    for (const variant of this.#variants) {
      const index = value.indexOf(variant);
      if (index >= 0 && (firstIndex < 0 || index < firstIndex)) firstIndex = index;
    }
    if (firstIndex < 0) return;
    const line = value.slice(0, firstIndex).split("\n").length;
    throw new CredentialBoundaryError(surface, "exact", line);
  }
}
