import type { Observation, PublicError } from "@kokoro/protocol";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/model.js";
import { mapObservationFact, type ObservationFactResolver } from "../src/protocol/index.js";
import type { ObservationFact, PersonaFact } from "../src/store/index.js";

const now = Date.parse("2026-08-30T00:00:00.000Z");
const at = new Date(now).toISOString();

describe("Owner-visible observation errors", () => {
  const cases: ReadonlyArray<{
    name: string;
    runtimeCode: string;
    publicCode: PublicError["code"];
    fact: ObservationFact;
  }> = [
    {
      name: "aborted Provider attempt",
      runtimeCode: "aborted",
      publicCode: "internal_error",
      fact: observation("provider_attempt", {
        attemptId: "attempt-provider-aborted",
        turnId: "turn-provider-aborted",
        attempt: 1,
        providerId: "provider",
        modelId: "model",
        state: "aborted",
        retryAt: null,
        error: { code: "aborted" },
      }),
    },
    {
      name: "Provider authentication failure",
      runtimeCode: "provider_authentication_unavailable",
      publicCode: "internal_error",
      fact: observation("provider_attempt", {
        attemptId: "attempt-provider-auth",
        turnId: "turn-provider-auth",
        attempt: 1,
        providerId: "provider",
        modelId: "model",
        state: "failed",
        retryAt: null,
        error: { code: "provider_authentication_unavailable" },
      }),
    },
    {
      name: "revoked Tool permission",
      runtimeCode: "permission_revoked_before_dispatch",
      publicCode: "permission_denied",
      fact: observation("tool_dispatch", {
        toolCallId: "tool-call-denied",
        dispatchId: "dispatch-denied",
        intentId: "intent-denied",
        state: "blocked",
        checkedAt: now,
        externalEffect: "possible",
        authority: [
          {
            decisionId: "decision-denied",
            stage: "dispatch",
            allowed: false,
            revision: "authority-1",
            reason: "owner policy",
            checkedAt: at,
          },
        ],
        receipt: null,
        code: "permission_revoked_before_dispatch",
      }),
    },
    {
      name: "Tool failure",
      runtimeCode: "tool_arguments_invalid",
      publicCode: "internal_error",
      fact: observation("tool_outcome", {
        toolCallId: "tool-call-failed",
        dispatchId: "dispatch-failed",
        state: "failed",
        externalEffect: "none",
        result: { code: "tool_arguments_invalid" },
        code: "tool_arguments_invalid",
      }),
    },
    {
      name: "publication failure",
      runtimeCode: "publication_failed",
      publicCode: "internal_error",
      fact: observation("publication", {
        publicationId: "publication-failed",
        eventId: "event",
        checkpointId: "checkpoint",
        state: "failed",
        attempt: 1,
        retryAt: null,
        receipt: null,
        error: { code: "publication_failed" },
      }),
    },
    {
      name: "Memory conflict",
      runtimeCode: "conflict",
      publicCode: "internal_error",
      fact: observation("hippocampus", {
        jobId: "job-conflict",
        eventId: "event",
        checkpointId: "checkpoint",
        state: "conflict",
        attempt: 1,
        retryAt: null,
        error: { code: "conflict" },
      }),
    },
    {
      name: "force restore requeue",
      runtimeCode: "force_restore",
      publicCode: "internal_error",
      fact: observation("hippocampus", {
        jobId: "job-force-restore",
        eventId: "event",
        checkpointId: "checkpoint",
        state: "queued",
        attempt: 0,
        retryAt: null,
        error: { code: "force_restore" },
      }),
    },
  ];

  for (const item of cases) {
    it(`localizes ${item.name} while preserving stable codes`, () => {
      const english = errorFrom(item.fact, "en");
      const chinese = errorFrom(item.fact, "zh-CN");

      expect(english.code).toBe(item.publicCode);
      expect(chinese.code).toBe(item.publicCode);
      expect(english.message).not.toBe(chinese.message);
      expect(english.message).not.toBe(item.runtimeCode);
      expect(chinese.message).not.toBe(item.runtimeCode);
      if (item.runtimeCode.includes("_")) {
        expect(english.message).not.toContain(item.runtimeCode);
        expect(chinese.message).not.toContain(item.runtimeCode);
      }
      expect(english.details).toMatchObject({ runtimeCode: item.runtimeCode });
      expect(chinese.details).toMatchObject({ runtimeCode: item.runtimeCode });
    });
  }

  it("replaces a callback's supplied display message and preserves its raw code only in details", () => {
    const rawMessage = "RAW INTERNAL CALLBACK MESSAGE";
    const fact = observation("tool_callback", {
      toolCallId: "tool-call-callback",
      callbackId: "callback",
      outcome: {
        state: "failed",
        error: {
          code: "permission_denied",
          message: rawMessage,
          retryable: false,
          details: { runtimeCode: "permission_revoked_before_dispatch", source: "callback" },
        },
      },
    });

    const english = errorFrom(fact, "en");
    const chinese = errorFrom(fact, "zh-CN");
    expect(english.code).toBe(chinese.code);
    expect(english.message).not.toBe(chinese.message);
    expect(english.message).not.toContain(rawMessage);
    expect(chinese.message).not.toContain(rawMessage);
    expect(english.details).toEqual({
      runtimeCode: "permission_revoked_before_dispatch",
      source: "callback",
    });
  });

  it("uses a localized generic message for unknown Runtime codes", () => {
    const runtimeCode = "opaque_internal_failure_9204";
    const fact = observation("provider_attempt", {
      attemptId: "attempt-unknown",
      turnId: "turn-unknown",
      attempt: 1,
      providerId: "provider",
      modelId: "model",
      state: "failed",
      retryAt: null,
      error: { code: runtimeCode },
    });
    const english = errorFrom(fact, "en");
    const chinese = errorFrom(fact, "zh-CN");

    expect(english.code).toBe("internal_error");
    expect(chinese.code).toBe("internal_error");
    expect(english.message).not.toBe(chinese.message);
    expect(english.message).not.toContain(runtimeCode);
    expect(chinese.message).not.toContain(runtimeCode);
    expect(english.details).toEqual({ runtimeCode });
    expect(chinese.details).toEqual({ runtimeCode });
  });

  it("does not surface an untrusted diagnostic message", () => {
    const rawMessage = "RAW UNKNOWN INTERNAL TEXT";
    const fact = observation("diagnostic", {
      code: "opaque_diagnostic",
      severity: "error",
      message: rawMessage,
      details: { operation: "worker" },
    });
    const english = onlyObservation(fact, "en");
    const chinese = onlyObservation(fact, "zh-CN");
    if (english.kind !== "diagnostic" || chinese.kind !== "diagnostic") {
      throw new Error("Expected diagnostic observations.");
    }
    expect(english.message).not.toBe(chinese.message);
    expect(english.message).not.toContain(rawMessage);
    expect(chinese.message).not.toContain(rawMessage);
    expect(english.details).toEqual({ operation: "worker", runtimeCode: "opaque_diagnostic" });
  });
});

function observation(kind: string, payload: JsonValue): ObservationFact {
  return {
    sequence: 1,
    personaId: "persona",
    runId: "run",
    eventId: "event",
    kind,
    payload,
    createdAt: now,
  };
}

function errorFrom(fact: ObservationFact, locale: "en" | "zh-CN"): PublicError {
  const mapped = onlyObservation(fact, locale);
  if (mapped.kind === "provider_attempt") return requireError(mapped.error);
  if (mapped.kind === "tool_dispatch") return requireError(mapped.denial);
  if (mapped.kind === "tool_outcome") return requireError(mapped.error);
  if (mapped.kind === "tool_callback" && mapped.outcome.state === "failed") {
    return mapped.outcome.error;
  }
  if (mapped.kind === "publication" || mapped.kind === "hippocampus") {
    return requireError(mapped.error);
  }
  throw new Error(`Observation ${mapped.kind} does not expose a PublicError.`);
}

function requireError(error: PublicError | null): PublicError {
  if (error === null) throw new Error("Expected a PublicError.");
  return error;
}

function onlyObservation(fact: ObservationFact, locale: "en" | "zh-CN"): Observation {
  const records = mapObservationFact(fact, resolver(locale));
  if (records.length !== 1 || records[0] === undefined) {
    throw new Error("Expected exactly one public observation.");
  }
  return records[0].observation;
}

function resolver(locale: "en" | "zh-CN"): ObservationFactResolver {
  return {
    getPersona: () => persona(locale),
    requireQueueItem: missing,
    requireEvent: missing,
    requireHippocampusJob: missing,
    requireToolCall: missing,
  };
}

function persona(locale: "en" | "zh-CN"): PersonaFact {
  return {
    id: "persona",
    displayName: "Persona",
    repositoryPath: "C:/persona",
    lifecycle: "running",
    uiLocale: locale,
    promptLocale: "en",
    initialized: true,
    currentCheckpoint: "checkpoint",
    selectedCheckpoint: null,
    revision: 1,
    createdAt: now,
  };
}

function missing(): never {
  throw new Error("Fixture fact is intentionally unavailable.");
}
