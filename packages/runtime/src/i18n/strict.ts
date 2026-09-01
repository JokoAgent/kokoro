const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/gu;

export type TemplateValue = string | number | boolean;

export type CatalogValidationIssueKind =
  | "missing-key"
  | "extra-key"
  | "type-mismatch"
  | "empty-string"
  | "placeholder-mismatch";

export interface CatalogValidationIssue {
  readonly kind: CatalogValidationIssueKind;
  readonly path: string;
  readonly detail: string;
}

export class CatalogValidationError extends Error {
  readonly issues: readonly CatalogValidationIssue[];

  constructor(issues: readonly CatalogValidationIssue[]) {
    super(`Locale catalog validation failed:\n${issues.map(formatCatalogIssue).join("\n")}`);
    this.name = "CatalogValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export class TemplateInterpolationError extends Error {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly invalid: readonly string[];

  constructor(options: {
    readonly missing?: readonly string[];
    readonly extra?: readonly string[];
    readonly invalid?: readonly string[];
    readonly detail?: string;
  }) {
    const missing = Object.freeze([...(options.missing ?? [])]);
    const extra = Object.freeze([...(options.extra ?? [])]);
    const invalid = Object.freeze([...(options.invalid ?? [])]);
    const parts = [
      missing.length > 0 ? `missing variables: ${missing.join(", ")}` : undefined,
      extra.length > 0 ? `unexpected variables: ${extra.join(", ")}` : undefined,
      invalid.length > 0 ? `invalid variables: ${invalid.join(", ")}` : undefined,
      options.detail,
    ].filter((part): part is string => part !== undefined);

    super(`Strict template interpolation failed${parts.length > 0 ? ` (${parts.join("; ")})` : "."}`);
    this.name = "TemplateInterpolationError";
    this.missing = missing;
    this.extra = extra;
    this.invalid = invalid;
  }
}

export function templatePlaceholders(template: string): readonly string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return Object.freeze([...names].sort());
}

export function interpolateStrict(template: string, values: Readonly<Record<string, TemplateValue>>): string {
  const expected = templatePlaceholders(template);
  const supplied = Object.keys(values).sort();
  const missing = expected.filter((name) => !Object.hasOwn(values, name));
  const extra = supplied.filter((name) => !expected.includes(name));
  const invalid = expected.filter((name) => {
    if (!Object.hasOwn(values, name)) return false;
    const value = values[name];
    return typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean";
  });

  if (missing.length > 0 || extra.length > 0 || invalid.length > 0) {
    throw new TemplateInterpolationError({ missing, extra, invalid });
  }

  let rendered = "";
  let cursor = 0;
  let replacements = 0;
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index;
    const name = match[1];
    if (index === undefined || name === undefined || !Object.hasOwn(values, name)) {
      throw new TemplateInterpolationError({ detail: "an unresolved catalog placeholder remains" });
    }
    rendered += template.slice(cursor, index);
    rendered += String(values[name]);
    cursor = index + match[0].length;
    replacements += 1;
  }
  rendered += template.slice(cursor);

  const placeholderOccurrences = [...template.matchAll(PLACEHOLDER_PATTERN)].length;
  if (replacements !== placeholderOccurrences) {
    throw new TemplateInterpolationError({ detail: "an unresolved catalog placeholder remains" });
  }

  // Do not scan rendered variable content. Owner, user, and Tool data is opaque and
  // may legitimately contain text such as "{name}"; only catalog placeholders are ours.
  return rendered;
}

export function catalogParityIssues(
  reference: unknown,
  candidate: unknown,
): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  compareCatalogNodes(reference, candidate, "$", issues);
  return Object.freeze(issues);
}

export function validateCatalogParity(reference: unknown, candidate: unknown): void {
  const issues = catalogParityIssues(reference, candidate);
  if (issues.length > 0) throw new CatalogValidationError(issues);
}

function compareCatalogNodes(
  reference: unknown,
  candidate: unknown,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (typeof reference === "string" && typeof candidate === "string") {
    if (reference.length === 0 || candidate.length === 0) {
      issues.push({ kind: "empty-string", path, detail: "catalog strings must not be empty" });
    }
    const expectedPlaceholders = templatePlaceholders(reference);
    const actualPlaceholders = templatePlaceholders(candidate);
    if (!sameStrings(expectedPlaceholders, actualPlaceholders)) {
      issues.push({
        kind: "placeholder-mismatch",
        path,
        detail: `expected [${expectedPlaceholders.join(", ")}], received [${actualPlaceholders.join(", ")}]`,
      });
    }
    return;
  }

  if (isCatalogObject(reference) && isCatalogObject(candidate)) {
    const referenceKeys = Object.keys(reference).sort();
    const candidateKeys = Object.keys(candidate).sort();

    for (const key of referenceKeys) {
      if (!Object.hasOwn(candidate, key)) {
        issues.push({
          kind: "missing-key",
          path: childPath(path, key),
          detail: "key is missing from the candidate catalog",
        });
      }
    }
    for (const key of candidateKeys) {
      if (!Object.hasOwn(reference, key)) {
        issues.push({
          kind: "extra-key",
          path: childPath(path, key),
          detail: "key does not exist in the reference catalog",
        });
      }
    }
    for (const key of referenceKeys) {
      if (Object.hasOwn(candidate, key)) {
        compareCatalogNodes(reference[key], candidate[key], childPath(path, key), issues);
      }
    }
    return;
  }

  issues.push({
    kind: "type-mismatch",
    path,
    detail: `expected ${catalogNodeType(reference)}, received ${catalogNodeType(candidate)}`,
  });
}

function isCatalogObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogNodeType(value: unknown): string {
  if (typeof value === "string") return "string";
  if (isCatalogObject(value)) return "object";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function childPath(parent: string, key: string): string {
  return parent === "$" ? `$.${key}` : `${parent}.${key}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatCatalogIssue(issue: CatalogValidationIssue): string {
  return `- ${issue.path}: ${issue.kind}: ${issue.detail}`;
}
