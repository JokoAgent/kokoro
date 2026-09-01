import type { JsonValue } from "./types.js";

export class ProtocolValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.path = path;
  }
}

export type RecordValue = Record<string, unknown>;

export function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

export function objectAt(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain object");
  const record = value as RecordValue;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
  }
  return record;
}

export function stringAt(
  value: unknown,
  path: string,
  options: { nonEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (options.nonEmpty && value.length === 0) fail(path, "must not be empty");
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    fail(path, `must contain at most ${options.maxLength} UTF-16 code units`);
  }
  assertNoLoneSurrogates(value, path);
  return value;
}

export function idAt(value: unknown, path: string): string {
  return stringAt(value, path, { nonEmpty: true, maxLength: 256 });
}

export function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path, { nonEmpty: true, maxLength: 64 });
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) {
    fail(path, "expected an ISO-8601 timestamp");
  }
  return timestamp;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

export function integerAt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): number {
  if (!Number.isSafeInteger(value)) fail(path, "expected a safe integer");
  const integer = value as number;
  if (options.min !== undefined && integer < options.min) fail(path, `must be at least ${options.min}`);
  if (options.max !== undefined && integer > options.max) fail(path, `must be at most ${options.max}`);
  return integer;
}

export function numberAt(value: unknown, path: string, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    fail(path, "expected a finite number in the safe range");
  }
  if (options.min !== undefined && value < options.min) fail(path, `must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) fail(path, `must be at most ${options.max}`);
  return value;
}

export function enumAt<const T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `expected one of ${values.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  return value as T;
}

export function literalAt<const T extends string | number | boolean | null>(
  value: unknown,
  path: string,
  expected: T,
): T {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
  return expected;
}

export function nullableAt<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): T | null {
  return value === null ? null : parse(value, path);
}

export function arrayAt<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
  options: { minLength?: number; maxLength?: number } = {},
): T[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (options.minLength !== undefined && value.length < options.minLength) {
    fail(path, `must contain at least ${options.minLength} items`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    fail(path, `must contain at most ${options.maxLength} items`);
  }
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

export function jsonValueAt(
  value: unknown,
  path: string,
  depth = 0,
  budget = { remaining: 100_000 },
): JsonValue {
  if (depth > 64) fail(path, "JSON nesting exceeds 64 levels");
  budget.remaining -= 1;
  if (budget.remaining < 0) fail(path, "JSON value exceeds the node limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return stringAt(value, path);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "JSON numbers must be finite");
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) fail(path, "JSON number exceeds the safe range");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValueAt(item, `${path}[${index}]`, depth + 1, budget));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(path, "JSON object must be plain");
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      stringAt(key, `${path}.[key]`);
      result[key] = jsonValueAt(item, `${path}.${key}`, depth + 1, budget);
    }
    return result;
  }
  fail(path, "expected a JSON value");
}

function assertNoLoneSurrogates(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        fail(path, "contains an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(path, "contains an unpaired UTF-16 surrogate");
    }
  }
}
