import type { JsonValue } from "../model.js";
import { parseStrictJsonObject, StructuredOutputError } from "../model.js";

export interface CloseoutDecision {
  summary: string;
  memory: "none" | "maintain";
}

export interface CompactionDecision {
  summary: string;
}

export function parseCloseoutDecision(text: string): CloseoutDecision {
  const value = parseStrictJsonObject(text);
  assertExactKeys(value, ["summary", "memory"]);
  const summary = nonEmptyString(value["summary"], "summary");
  const memory = value["memory"];
  if (memory !== "none" && memory !== "maintain") {
    throw new StructuredOutputError("invalid_enum", {
      field: "memory",
      values: ["none", "maintain"],
    });
  }
  return { summary, memory };
}

export function parseCompactionDecision(text: string): CompactionDecision {
  const value = parseStrictJsonObject(text);
  assertExactKeys(value, ["summary"]);
  return { summary: nonEmptyString(value["summary"], "summary") };
}

function assertExactKeys(value: Record<string, JsonValue>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new StructuredOutputError("exact_fields", { fields: wanted });
  }
}

function nonEmptyString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StructuredOutputError("non_empty_string", { field: name });
  }
  return value;
}

export function errorCode(error: unknown): string {
  if (error instanceof StructuredOutputError) return "structured_output_invalid";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "operation_failed";
}
