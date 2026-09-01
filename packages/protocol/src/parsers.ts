import type {
  AuthorityDecisionSnapshot,
  AuthoritySnapshot,
  CapabilitySnapshot,
  CheckpointRef,
  Command,
  CommandResult,
  LifecyclePhase,
  LocaleCapability,
  Observation,
  ObservationKind,
  ObservationRecord,
  OperationAcceptedResult,
  OperationCommandType,
  OwnerDocument,
  PersonaSnapshot,
  ProviderCapability,
  PublicError,
  QueueItemSnapshot,
  RetryTarget,
  StimulusInput,
  ToolCallbackOutcome,
  ToolCapability,
  WaitingFact,
} from "./types.js";
import {
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  idAt,
  integerAt,
  jsonValueAt,
  literalAt,
  nullableAt,
  numberAt,
  objectAt,
  stringAt,
  timestampAt,
} from "./validation.js";

const LIFECYCLE_PHASES = [
  "draft",
  "initialized",
  "running",
  "pausing",
  "paused",
  "stopping",
  "stopped",
  "forcing",
  "failed",
] as const;

const PROVIDER_UNAVAILABLE_REASON_CODES = ["authentication_required"] as const;

export const COMMAND_TYPES = [
  "create",
  "init",
  "start",
  "pause",
  "resume",
  "stop",
  "force",
  "stimulus",
  "callback",
  "owner_documents",
  "put_owner_document",
  "history",
  "branch",
  "clone",
  "restore",
  "delete",
  "locales",
  "set_locales",
  "retry",
  "capabilities",
  "observations",
  "snapshot",
] as const;

export const OBSERVATION_KINDS = [
  "model_input",
  "internal_cognition",
  "provider_attempt",
  "usage",
  "tool_proposal",
  "tool_dispatch",
  "tool_outcome",
  "tool_callback",
  "event_committed",
  "publication",
  "hippocampus",
  "lifecycle",
  "queue",
  "diagnostic",
] as const;

const ERROR_CODES = [
  "invalid_request",
  "unsupported_version",
  "not_found",
  "revision_conflict",
  "invalid_state",
  "permission_denied",
  "working_tree_conflict",
  "outcome_unknown",
  "rate_limited",
  "unavailable",
  "internal_error",
] as const;

export function parseCheckpointRef(value: unknown, path: string): CheckpointRef {
  const record = objectAt(value, path, ["checkpointId", "commitId", "summary", "createdAt"]);
  return {
    checkpointId: idAt(record.checkpointId, `${path}.checkpointId`),
    commitId: idAt(record.commitId, `${path}.commitId`),
    summary: stringAt(record.summary, `${path}.summary`),
    createdAt: timestampAt(record.createdAt, `${path}.createdAt`),
  };
}

const MAX_OWNER_DOCUMENT_CONTENT_LENGTH = 8 * 1024 * 1024;

function ownerDocumentPathAt(value: unknown, path: string): string {
  const candidate = stringAt(value, path, { nonEmpty: true, maxLength: 1_024 });
  if (candidate.includes("\\")) fail(path, "must use forward slashes");
  const segments = candidate.split("/");
  if (
    segments.length < 3 ||
    segments[0] !== "workspace" ||
    (segments[1] !== "persona" && segments[1] !== "memory") ||
    !segments.at(-1)?.toLowerCase().endsWith(".md")
  ) {
    fail(path, "must be a Markdown path below workspace/persona or workspace/memory");
  }
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      [...segment].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f || '<>:"|?*'.includes(character);
      }) ||
      /[ .]$/u.test(segment) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment)
    ) {
      fail(path, "contains a non-portable path segment");
    }
  }
  return candidate;
}

function sha256At(value: unknown, path: string): string {
  const digest = stringAt(value, path, { nonEmpty: true, maxLength: 64 });
  if (!/^[0-9a-f]{64}$/u.test(digest)) fail(path, "expected a lowercase SHA-256 digest");
  return digest;
}

function parseOwnerDocument(value: unknown, path: string): OwnerDocument {
  const record = objectAt(value, path, ["path", "content", "sha256", "mtimeMs"]);
  return {
    path: ownerDocumentPathAt(record.path, `${path}.path`),
    content: stringAt(record.content, `${path}.content`, {
      maxLength: MAX_OWNER_DOCUMENT_CONTENT_LENGTH,
    }),
    sha256: sha256At(record.sha256, `${path}.sha256`),
    mtimeMs: numberAt(record.mtimeMs, `${path}.mtimeMs`),
  };
}

function parseWaitingFact(value: unknown, path: string): WaitingFact {
  const discriminator = objectAt(
    value,
    path,
    ["kind"],
    ["toolCallId", "attemptId", "retryAt", "publicationId", "jobId", "reason"],
  );
  const kind = stringAt(discriminator.kind, `${path}.kind`);
  switch (kind) {
    case "tool_callback": {
      const record = objectAt(value, path, ["kind", "toolCallId"]);
      return { kind, toolCallId: idAt(record.toolCallId, `${path}.toolCallId`) };
    }
    case "provider_retry": {
      const record = objectAt(value, path, ["kind", "attemptId", "retryAt"]);
      return {
        kind,
        attemptId: idAt(record.attemptId, `${path}.attemptId`),
        retryAt: timestampAt(record.retryAt, `${path}.retryAt`),
      };
    }
    case "publication_retry": {
      const record = objectAt(value, path, ["kind", "publicationId", "retryAt"]);
      return {
        kind,
        publicationId: idAt(record.publicationId, `${path}.publicationId`),
        retryAt: timestampAt(record.retryAt, `${path}.retryAt`),
      };
    }
    case "hippocampus_retry": {
      const record = objectAt(value, path, ["kind", "jobId", "retryAt"]);
      return {
        kind,
        jobId: idAt(record.jobId, `${path}.jobId`),
        retryAt: timestampAt(record.retryAt, `${path}.retryAt`),
      };
    }
    case "owner_action": {
      const record = objectAt(value, path, ["kind", "reason"]);
      return { kind, reason: stringAt(record.reason, `${path}.reason`, { nonEmpty: true }) };
    }
    default:
      return fail(`${path}.kind`, "unknown waiting fact kind");
  }
}

export function parseQueueItem(value: unknown, path: string): QueueItemSnapshot {
  const record = objectAt(value, path, ["workItemId", "source", "state", "acceptedAt", "stimulusKind"]);
  return {
    workItemId: idAt(record.workItemId, `${path}.workItemId`),
    source: enumAt(record.source, `${path}.source`, ["stimulus", "continuation"] as const),
    state: enumAt(record.state, `${path}.state`, ["pending", "frozen_by_pause", "active"] as const),
    acceptedAt: timestampAt(record.acceptedAt, `${path}.acceptedAt`),
    stimulusKind: nullableAt(record.stimulusKind, `${path}.stimulusKind`, (item, itemPath) =>
      enumAt(item, itemPath, ["user_message", "system_event", "scheduled", "external_change"] as const),
    ),
  };
}

function parsePersonaSnapshot(value: unknown, path: string): PersonaSnapshot {
  const record = objectAt(value, path, [
    "personaId",
    "displayName",
    "uiLocale",
    "promptLocale",
    "phase",
    "runId",
    "activeEventId",
    "waiting",
    "queue",
    "latestCheckpoint",
    "currentCheckpointId",
    "selectedStartCheckpointId",
    "workingTree",
    "publication",
    "hippocampus",
    "updatedAt",
  ]);
  const workingTree = objectAt(record.workingTree, `${path}.workingTree`, ["state", "digest"]);
  const publication = objectAt(record.publication, `${path}.publication`, [
    "pending",
    "delivering",
    "retryWaiting",
    "failed",
  ]);
  const hippocampus = objectAt(record.hippocampus, `${path}.hippocampus`, [
    "queued",
    "running",
    "retryWaiting",
    "failed",
    "conflicted",
  ]);
  return {
    personaId: idAt(record.personaId, `${path}.personaId`),
    displayName: stringAt(record.displayName, `${path}.displayName`, { nonEmpty: true, maxLength: 512 }),
    uiLocale: stringAt(record.uiLocale, `${path}.uiLocale`, { nonEmpty: true, maxLength: 64 }),
    promptLocale: stringAt(record.promptLocale, `${path}.promptLocale`, { nonEmpty: true, maxLength: 64 }),
    phase: enumAt(record.phase, `${path}.phase`, LIFECYCLE_PHASES),
    runId: nullableAt(record.runId, `${path}.runId`, idAt),
    activeEventId: nullableAt(record.activeEventId, `${path}.activeEventId`, idAt),
    waiting: nullableAt(record.waiting, `${path}.waiting`, parseWaitingFact),
    queue: arrayAt(record.queue, `${path}.queue`, parseQueueItem, { maxLength: 100_000 }),
    latestCheckpoint: nullableAt(record.latestCheckpoint, `${path}.latestCheckpoint`, parseCheckpointRef),
    currentCheckpointId: nullableAt(record.currentCheckpointId, `${path}.currentCheckpointId`, idAt),
    selectedStartCheckpointId: nullableAt(
      record.selectedStartCheckpointId,
      `${path}.selectedStartCheckpointId`,
      idAt,
    ),
    workingTree: {
      state: enumAt(workingTree.state, `${path}.workingTree.state`, ["clean", "dirty", "unknown"] as const),
      digest: nullableAt(workingTree.digest, `${path}.workingTree.digest`, idAt),
    },
    publication: {
      pending: integerAt(publication.pending, `${path}.publication.pending`, { min: 0 }),
      delivering: integerAt(publication.delivering, `${path}.publication.delivering`, { min: 0 }),
      retryWaiting: integerAt(publication.retryWaiting, `${path}.publication.retryWaiting`, { min: 0 }),
      failed: integerAt(publication.failed, `${path}.publication.failed`, { min: 0 }),
    },
    hippocampus: {
      queued: integerAt(hippocampus.queued, `${path}.hippocampus.queued`, { min: 0 }),
      running: booleanAt(hippocampus.running, `${path}.hippocampus.running`),
      retryWaiting: integerAt(hippocampus.retryWaiting, `${path}.hippocampus.retryWaiting`, { min: 0 }),
      failed: integerAt(hippocampus.failed, `${path}.hippocampus.failed`, { min: 0 }),
      conflicted: integerAt(hippocampus.conflicted, `${path}.hippocampus.conflicted`, { min: 0 }),
    },
    updatedAt: timestampAt(record.updatedAt, `${path}.updatedAt`),
  };
}

function parseAuthorityDecision(value: unknown, path: string): AuthorityDecisionSnapshot {
  const record = objectAt(value, path, ["decisionId", "stage", "allowed", "revision", "reason", "checkedAt"]);
  return {
    decisionId: idAt(record.decisionId, `${path}.decisionId`),
    stage: enumAt(record.stage, `${path}.stage`, ["proposal", "dispatch"] as const),
    allowed: booleanAt(record.allowed, `${path}.allowed`),
    revision: idAt(record.revision, `${path}.revision`),
    reason: nullableAt(record.reason, `${path}.reason`, stringAt),
    checkedAt: timestampAt(record.checkedAt, `${path}.checkedAt`),
  };
}

export function parseAuthoritySnapshot(value: unknown, path: string): AuthoritySnapshot {
  const record = objectAt(value, path, ["revision", "capturedAt", "personas"]);
  const snapshot = {
    revision: integerAt(record.revision, `${path}.revision`, { min: 0 }),
    capturedAt: timestampAt(record.capturedAt, `${path}.capturedAt`),
    personas: arrayAt(record.personas, `${path}.personas`, parsePersonaSnapshot, { maxLength: 100_000 }),
  };
  assertUnique(snapshot.personas, (persona) => persona.personaId, `${path}.personas`, "personaId");
  for (const [index, persona] of snapshot.personas.entries()) {
    assertUnique(persona.queue, (item) => item.workItemId, `${path}.personas[${index}].queue`, "workItemId");
  }
  return snapshot;
}

export function parseLocaleCapability(value: unknown, path: string): LocaleCapability {
  const record = objectAt(value, path, ["locale", "label", "ui", "prompt"]);
  return {
    locale: stringAt(record.locale, `${path}.locale`, { nonEmpty: true, maxLength: 64 }),
    label: stringAt(record.label, `${path}.label`, { nonEmpty: true, maxLength: 256 }),
    ui: booleanAt(record.ui, `${path}.ui`),
    prompt: booleanAt(record.prompt, `${path}.prompt`),
  };
}

function parseProviderCapability(value: unknown, path: string): ProviderCapability {
  const record = objectAt(value, path, ["providerId", "label", "available", "unavailableReason", "models"]);
  return {
    providerId: idAt(record.providerId, `${path}.providerId`),
    label: stringAt(record.label, `${path}.label`, { nonEmpty: true, maxLength: 256 }),
    available: booleanAt(record.available, `${path}.available`),
    unavailableReason: nullableAt(record.unavailableReason, `${path}.unavailableReason`, (entry, entryPath) =>
      enumAt(entry, entryPath, PROVIDER_UNAVAILABLE_REASON_CODES),
    ),
    models: arrayAt(
      record.models,
      `${path}.models`,
      (item, itemPath) => {
        const model = objectAt(item, itemPath, ["modelId", "label", "contextWindow"]);
        return {
          modelId: idAt(model.modelId, `${itemPath}.modelId`),
          label: stringAt(model.label, `${itemPath}.label`, { nonEmpty: true, maxLength: 256 }),
          contextWindow: nullableAt(model.contextWindow, `${itemPath}.contextWindow`, (entry, entryPath) =>
            integerAt(entry, entryPath, { min: 1 }),
          ),
        };
      },
      { maxLength: 10_000 },
    ),
  };
}

function parseToolCapability(value: unknown, path: string): ToolCapability {
  const record = objectAt(value, path, [
    "toolName",
    "description",
    "available",
    "externalEffect",
    "authorizationRequiredAtDispatch",
  ]);
  return {
    toolName: idAt(record.toolName, `${path}.toolName`),
    description: stringAt(record.description, `${path}.description`),
    available: booleanAt(record.available, `${path}.available`),
    externalEffect: enumAt(record.externalEffect, `${path}.externalEffect`, ["none", "possible"] as const),
    authorizationRequiredAtDispatch: booleanAt(
      record.authorizationRequiredAtDispatch,
      `${path}.authorizationRequiredAtDispatch`,
    ),
  };
}

export function parseCapabilitySnapshot(value: unknown, path: string): CapabilitySnapshot {
  const record = objectAt(value, path, [
    "protocol",
    "serverVersion",
    "maxFrameBytes",
    "commands",
    "availableCommands",
    "observationKinds",
    "locales",
    "providers",
    "tools",
    "features",
  ]);
  const features = objectAt(record.features, `${path}.features`, [
    "continuation",
    "publication",
    "hippocampus",
  ]);
  const capabilities = {
    protocol: literalAt(record.protocol, `${path}.protocol`, "kokoro/1"),
    serverVersion: stringAt(record.serverVersion, `${path}.serverVersion`, {
      nonEmpty: true,
      maxLength: 128,
    }),
    maxFrameBytes: integerAt(record.maxFrameBytes, `${path}.maxFrameBytes`, {
      min: 1,
      max: 16 * 1024 * 1024,
    }),
    commands: arrayAt(record.commands, `${path}.commands`, (item, itemPath) =>
      enumAt(item, itemPath, COMMAND_TYPES),
    ),
    availableCommands: arrayAt(record.availableCommands, `${path}.availableCommands`, (item, itemPath) =>
      enumAt(item, itemPath, COMMAND_TYPES),
    ),
    observationKinds: arrayAt(record.observationKinds, `${path}.observationKinds`, (item, itemPath) =>
      enumAt(item, itemPath, OBSERVATION_KINDS),
    ),
    locales: arrayAt(record.locales, `${path}.locales`, parseLocaleCapability, { maxLength: 1_000 }),
    providers: arrayAt(record.providers, `${path}.providers`, parseProviderCapability, { maxLength: 10_000 }),
    tools: arrayAt(record.tools, `${path}.tools`, parseToolCapability, { maxLength: 100_000 }),
    features: {
      continuation: booleanAt(features.continuation, `${path}.features.continuation`),
      publication: booleanAt(features.publication, `${path}.features.publication`),
      hippocampus: booleanAt(features.hippocampus, `${path}.features.hippocampus`),
    },
  };
  assertUnique(capabilities.commands, (command) => command, `${path}.commands`, "command");
  assertUnique(capabilities.availableCommands, (command) => command, `${path}.availableCommands`, "command");
  const supportedCommands = new Set(capabilities.commands);
  for (const [index, command] of capabilities.availableCommands.entries()) {
    if (!supportedCommands.has(command)) {
      fail(`${path}.availableCommands[${index}]`, "command is not present in the supported command set");
    }
  }
  assertUnique(capabilities.observationKinds, (kind) => kind, `${path}.observationKinds`, "kind");
  assertUnique(capabilities.locales, (locale) => locale.locale, `${path}.locales`, "locale");
  assertUnique(capabilities.providers, (provider) => provider.providerId, `${path}.providers`, "providerId");
  assertUnique(capabilities.tools, (tool) => tool.toolName, `${path}.tools`, "toolName");
  return capabilities;
}

export function parsePublicError(value: unknown, path: string): PublicError {
  const record = objectAt(value, path, ["code", "message", "retryable", "details"]);
  return {
    code: enumAt(record.code, `${path}.code`, ERROR_CODES),
    message: stringAt(record.message, `${path}.message`),
    retryable: booleanAt(record.retryable, `${path}.retryable`),
    details: jsonValueAt(record.details, `${path}.details`),
  };
}

function parseStimulus(value: unknown, path: string): StimulusInput {
  const record = objectAt(value, path, ["kind", "content", "occurredAt", "source"]);
  return {
    kind: enumAt(record.kind, `${path}.kind`, [
      "user_message",
      "system_event",
      "scheduled",
      "external_change",
    ] as const),
    content: jsonValueAt(record.content, `${path}.content`),
    occurredAt: nullableAt(record.occurredAt, `${path}.occurredAt`, timestampAt),
    source: nullableAt(record.source, `${path}.source`, stringAt),
  };
}

export function parseToolCallbackOutcome(value: unknown, path: string): ToolCallbackOutcome {
  const discriminator = objectAt(value, path, ["state"], ["result", "error", "reason"]);
  const state = stringAt(discriminator.state, `${path}.state`);
  switch (state) {
    case "succeeded": {
      const record = objectAt(value, path, ["state", "result"]);
      return { state, result: jsonValueAt(record.result, `${path}.result`) };
    }
    case "failed": {
      const record = objectAt(value, path, ["state", "error"]);
      return { state, error: parsePublicError(record.error, `${path}.error`) };
    }
    case "unknown": {
      const record = objectAt(value, path, ["state", "reason"]);
      return { state, reason: stringAt(record.reason, `${path}.reason`, { nonEmpty: true }) };
    }
    default:
      return fail(`${path}.state`, "unknown callback outcome state");
  }
}

function parseRetryTarget(value: unknown, path: string): RetryTarget {
  const record = objectAt(value, path, ["kind", "jobId"]);
  literalAt(record.kind, `${path}.kind`, "hippocampus");
  return { kind: "hippocampus", jobId: idAt(record.jobId, `${path}.jobId`) };
}

export function parseCommand(value: unknown, path: string): Command {
  const discriminator = objectAt(
    value,
    path,
    ["type"],
    [
      "templateId",
      "personaId",
      "displayName",
      "uiLocale",
      "promptLocale",
      "expectedWorkingTreeDigest",
      "from",
      "model",
      "idempotencyKey",
      "stimulus",
      "toolCallId",
      "callbackId",
      "outcome",
      "path",
      "content",
      "expectedSha256",
      "beforeCheckpointId",
      "limit",
      "checkpointId",
      "branchName",
      "newPersonaId",
      "workingTreePolicy",
      "confirmationPersonaId",
      "uiLocale",
      "promptLocale",
      "target",
      "afterCursor",
      "kinds",
    ],
  );
  const type = enumAt(discriminator.type, `${path}.type`, COMMAND_TYPES);
  switch (type) {
    case "create": {
      const record = objectAt(value, path, [
        "type",
        "templateId",
        "personaId",
        "displayName",
        "uiLocale",
        "promptLocale",
      ]);
      return {
        type,
        templateId: idAt(record.templateId, `${path}.templateId`),
        personaId: nullableAt(record.personaId, `${path}.personaId`, idAt),
        displayName: stringAt(record.displayName, `${path}.displayName`, { nonEmpty: true, maxLength: 512 }),
        uiLocale: stringAt(record.uiLocale, `${path}.uiLocale`, { nonEmpty: true, maxLength: 64 }),
        promptLocale: stringAt(record.promptLocale, `${path}.promptLocale`, {
          nonEmpty: true,
          maxLength: 64,
        }),
      };
    }
    case "init": {
      const record = objectAt(value, path, ["type", "personaId", "expectedWorkingTreeDigest"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        expectedWorkingTreeDigest: nullableAt(
          record.expectedWorkingTreeDigest,
          `${path}.expectedWorkingTreeDigest`,
          idAt,
        ),
      };
    }
    case "start": {
      const record = objectAt(value, path, ["type", "personaId", "from", "model", "promptLocale"]);
      const fromDiscriminator = objectAt(record.from, `${path}.from`, ["kind"], ["checkpointId"]);
      const fromKind = enumAt(fromDiscriminator.kind, `${path}.from.kind`, [
        "current_working_tree",
        "checkpoint",
      ] as const);
      const from =
        fromKind === "current_working_tree"
          ? { kind: "current_working_tree" as const }
          : (() => {
              const checkpoint = objectAt(record.from, `${path}.from`, ["kind", "checkpointId"]);
              return {
                kind: fromKind as "checkpoint",
                checkpointId: idAt(checkpoint.checkpointId, `${path}.from.checkpointId`),
              };
            })();
      const model = nullableAt(record.model, `${path}.model`, (item, itemPath) => {
        const selection = objectAt(item, itemPath, ["providerId", "modelId"]);
        return {
          providerId: idAt(selection.providerId, `${itemPath}.providerId`),
          modelId: idAt(selection.modelId, `${itemPath}.modelId`),
        };
      });
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        from,
        model,
        promptLocale: nullableAt(record.promptLocale, `${path}.promptLocale`, stringAt),
      };
    }
    case "pause":
    case "resume":
    case "stop":
    case "force": {
      const record = objectAt(value, path, ["type", "personaId"]);
      return { type, personaId: idAt(record.personaId, `${path}.personaId`) };
    }
    case "stimulus": {
      const record = objectAt(value, path, ["type", "personaId", "idempotencyKey", "stimulus"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        idempotencyKey: idAt(record.idempotencyKey, `${path}.idempotencyKey`),
        stimulus: parseStimulus(record.stimulus, `${path}.stimulus`),
      };
    }
    case "callback": {
      const record = objectAt(value, path, ["type", "personaId", "toolCallId", "callbackId", "outcome"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        toolCallId: idAt(record.toolCallId, `${path}.toolCallId`),
        callbackId: idAt(record.callbackId, `${path}.callbackId`),
        outcome: parseToolCallbackOutcome(record.outcome, `${path}.outcome`),
      };
    }
    case "owner_documents": {
      const record = objectAt(value, path, ["type", "personaId", "path"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        path: nullableAt(record.path, `${path}.path`, ownerDocumentPathAt),
      };
    }
    case "put_owner_document": {
      const record = objectAt(value, path, ["type", "personaId", "path", "content", "expectedSha256"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        path: ownerDocumentPathAt(record.path, `${path}.path`),
        content: stringAt(record.content, `${path}.content`, {
          maxLength: MAX_OWNER_DOCUMENT_CONTENT_LENGTH,
        }),
        expectedSha256: nullableAt(record.expectedSha256, `${path}.expectedSha256`, sha256At),
      };
    }
    case "history": {
      const record = objectAt(value, path, ["type", "personaId", "beforeCheckpointId", "limit"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        beforeCheckpointId: nullableAt(record.beforeCheckpointId, `${path}.beforeCheckpointId`, idAt),
        limit: integerAt(record.limit, `${path}.limit`, { min: 1, max: 1_000 }),
      };
    }
    case "branch": {
      const record = objectAt(value, path, ["type", "personaId", "checkpointId", "branchName"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        checkpointId: idAt(record.checkpointId, `${path}.checkpointId`),
        branchName: idAt(record.branchName, `${path}.branchName`),
      };
    }
    case "clone": {
      const record = objectAt(value, path, [
        "type",
        "personaId",
        "checkpointId",
        "newPersonaId",
        "displayName",
      ]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        checkpointId: idAt(record.checkpointId, `${path}.checkpointId`),
        newPersonaId: nullableAt(record.newPersonaId, `${path}.newPersonaId`, idAt),
        displayName: stringAt(record.displayName, `${path}.displayName`, { nonEmpty: true, maxLength: 512 }),
      };
    }
    case "restore": {
      const record = objectAt(value, path, ["type", "personaId", "checkpointId", "workingTreePolicy"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        checkpointId: idAt(record.checkpointId, `${path}.checkpointId`),
        workingTreePolicy: enumAt(record.workingTreePolicy, `${path}.workingTreePolicy`, [
          "require_clean",
          "discard_changes",
        ] as const),
      };
    }
    case "delete": {
      const record = objectAt(value, path, [
        "type",
        "personaId",
        "confirmationPersonaId",
        "workingTreePolicy",
      ]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        confirmationPersonaId: idAt(record.confirmationPersonaId, `${path}.confirmationPersonaId`),
        workingTreePolicy: enumAt(record.workingTreePolicy, `${path}.workingTreePolicy`, [
          "require_clean",
          "discard_changes",
        ] as const),
      };
    }
    case "locales":
    case "snapshot": {
      objectAt(value, path, ["type"]);
      return { type };
    }
    case "set_locales": {
      const record = objectAt(value, path, ["type", "personaId", "uiLocale", "promptLocale"]);
      const uiLocale = nullableAt(record.uiLocale, `${path}.uiLocale`, stringAt);
      const promptLocale = nullableAt(record.promptLocale, `${path}.promptLocale`, stringAt);
      if (uiLocale === null && promptLocale === null) {
        return fail(path, "set_locales requires at least one locale");
      }
      return { type, personaId: idAt(record.personaId, `${path}.personaId`), uiLocale, promptLocale };
    }
    case "retry": {
      const record = objectAt(value, path, ["type", "personaId", "target"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        target: parseRetryTarget(record.target, `${path}.target`),
      };
    }
    case "capabilities": {
      const record = objectAt(value, path, ["type", "personaId"]);
      return { type, personaId: nullableAt(record.personaId, `${path}.personaId`, idAt) };
    }
    case "observations": {
      const record = objectAt(value, path, ["type", "personaId", "afterCursor", "limit", "kinds"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        afterCursor: nullableAt(record.afterCursor, `${path}.afterCursor`, idAt),
        limit: integerAt(record.limit, `${path}.limit`, { min: 1, max: 10_000 }),
        kinds: nullableAt(record.kinds, `${path}.kinds`, (item, itemPath) =>
          arrayAt(item, itemPath, (kind, kindPath) => enumAt(kind, kindPath, OBSERVATION_KINDS), {
            maxLength: OBSERVATION_KINDS.length,
          }),
        ),
      };
    }
  }
}

function parseOperationAcceptedResult<TType extends OperationCommandType>(
  value: unknown,
  path: string,
  expectedType: TType,
): OperationAcceptedResult<TType> {
  const record = objectAt(value, path, ["type", "operationId", "acceptedAt"]);
  literalAt(record.type, `${path}.type`, expectedType);
  return {
    type: expectedType,
    operationId: idAt(record.operationId, `${path}.operationId`),
    acceptedAt: timestampAt(record.acceptedAt, `${path}.acceptedAt`),
  };
}

export function parseCommandResult(value: unknown, path: string): CommandResult {
  const discriminator = objectAt(
    value,
    path,
    ["type"],
    [
      "personaId",
      "operationId",
      "acceptedAt",
      "stimulusId",
      "workItemId",
      "callbackId",
      "toolCallId",
      "recordedAt",
      "documents",
      "document",
      "checkpoints",
      "nextBeforeCheckpointId",
      "branchName",
      "checkpoint",
      "locales",
      "capabilities",
      "observations",
      "nextCursor",
    ],
  );
  const type = enumAt(discriminator.type, `${path}.type`, COMMAND_TYPES);
  switch (type) {
    case "create": {
      const record = objectAt(value, path, ["type", "personaId", "operationId", "acceptedAt"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        operationId: idAt(record.operationId, `${path}.operationId`),
        acceptedAt: timestampAt(record.acceptedAt, `${path}.acceptedAt`),
      };
    }
    case "init":
    case "start":
    case "pause":
    case "resume":
    case "stop":
    case "force":
    case "restore":
    case "delete":
    case "set_locales":
    case "retry":
      return parseOperationAcceptedResult(value, path, type);
    case "stimulus": {
      const record = objectAt(value, path, ["type", "stimulusId", "workItemId", "acceptedAt"]);
      return {
        type,
        stimulusId: idAt(record.stimulusId, `${path}.stimulusId`),
        workItemId: idAt(record.workItemId, `${path}.workItemId`),
        acceptedAt: timestampAt(record.acceptedAt, `${path}.acceptedAt`),
      };
    }
    case "callback": {
      const record = objectAt(value, path, ["type", "callbackId", "toolCallId", "recordedAt"]);
      return {
        type,
        callbackId: idAt(record.callbackId, `${path}.callbackId`),
        toolCallId: idAt(record.toolCallId, `${path}.toolCallId`),
        recordedAt: timestampAt(record.recordedAt, `${path}.recordedAt`),
      };
    }
    case "owner_documents": {
      const record = objectAt(value, path, ["type", "documents"]);
      const documents = arrayAt(record.documents, `${path}.documents`, parseOwnerDocument, {
        maxLength: 100_000,
      });
      assertUnique(documents, (document) => document.path, `${path}.documents`, "path");
      return { type, documents };
    }
    case "put_owner_document": {
      const record = objectAt(value, path, ["type", "document"]);
      return { type, document: parseOwnerDocument(record.document, `${path}.document`) };
    }
    case "history": {
      const record = objectAt(value, path, ["type", "checkpoints", "nextBeforeCheckpointId"]);
      return {
        type,
        checkpoints: arrayAt(record.checkpoints, `${path}.checkpoints`, parseCheckpointRef, {
          maxLength: 1_000,
        }),
        nextBeforeCheckpointId: nullableAt(
          record.nextBeforeCheckpointId,
          `${path}.nextBeforeCheckpointId`,
          idAt,
        ),
      };
    }
    case "branch": {
      const record = objectAt(value, path, ["type", "branchName", "checkpoint"]);
      return {
        type,
        branchName: idAt(record.branchName, `${path}.branchName`),
        checkpoint: parseCheckpointRef(record.checkpoint, `${path}.checkpoint`),
      };
    }
    case "clone": {
      const record = objectAt(value, path, ["type", "personaId", "checkpoint"]);
      return {
        type,
        personaId: idAt(record.personaId, `${path}.personaId`),
        checkpoint: parseCheckpointRef(record.checkpoint, `${path}.checkpoint`),
      };
    }
    case "locales": {
      const record = objectAt(value, path, ["type", "locales"]);
      return {
        type,
        locales: arrayAt(record.locales, `${path}.locales`, parseLocaleCapability, { maxLength: 1_000 }),
      };
    }
    case "capabilities": {
      const record = objectAt(value, path, ["type", "capabilities"]);
      return { type, capabilities: parseCapabilitySnapshot(record.capabilities, `${path}.capabilities`) };
    }
    case "observations": {
      const record = objectAt(value, path, ["type", "observations", "nextCursor"]);
      return {
        type,
        observations: arrayAt(record.observations, `${path}.observations`, parseObservationRecord, {
          maxLength: 10_000,
        }),
        nextCursor: nullableAt(record.nextCursor, `${path}.nextCursor`, idAt),
      };
    }
    case "snapshot":
      objectAt(value, path, ["type"]);
      return { type };
  }
}

export function parseObservationRecord(value: unknown, path: string): ObservationRecord {
  const record = objectAt(value, path, [
    "observationId",
    "cursor",
    "personaId",
    "runId",
    "eventId",
    "occurredAt",
    "correlationId",
    "observation",
  ]);
  const parsed = {
    observationId: idAt(record.observationId, `${path}.observationId`),
    cursor: idAt(record.cursor, `${path}.cursor`),
    personaId: idAt(record.personaId, `${path}.personaId`),
    runId: nullableAt(record.runId, `${path}.runId`, idAt),
    eventId: nullableAt(record.eventId, `${path}.eventId`, idAt),
    occurredAt: timestampAt(record.occurredAt, `${path}.occurredAt`),
    correlationId: idAt(record.correlationId, `${path}.correlationId`),
    observation: parseObservation(record.observation, `${path}.observation`),
  };
  if (
    (parsed.observation.kind === "event_committed" ||
      parsed.observation.kind === "publication" ||
      parsed.observation.kind === "hippocampus") &&
    parsed.eventId !== parsed.observation.eventId
  ) {
    fail(`${path}.eventId`, `must equal ${path}.observation.eventId`);
  }
  return parsed;
}

function parseObservation(value: unknown, path: string): Observation {
  const discriminator = objectAt(
    value,
    path,
    ["kind"],
    [
      "role",
      "attemptId",
      "turnId",
      "content",
      "redacted",
      "channel",
      "sequence",
      "attemptState",
      "externalMessage",
      "providerId",
      "modelId",
      "state",
      "retryAt",
      "error",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "toolCallId",
      "toolName",
      "arguments",
      "proposedAt",
      "dispatchId",
      "intentId",
      "checkedAt",
      "externalEffect",
      "authority",
      "denial",
      "result",
      "callbackId",
      "outcome",
      "eventId",
      "sourceWorkItemIds",
      "summary",
      "needsMemory",
      "checkpoint",
      "committedAt",
      "publicationId",
      "checkpointId",
      "attempt",
      "receipt",
      "jobId",
      "phase",
      "runId",
      "reason",
      "workItem",
      "action",
      "severity",
      "code",
      "message",
      "details",
    ],
  );
  const kind = enumAt(discriminator.kind, `${path}.kind`, OBSERVATION_KINDS);
  switch (kind) {
    case "model_input": {
      const record = objectAt(value, path, ["kind", "role", "attemptId", "content", "redacted"]);
      return {
        kind,
        role: enumAt(record.role, `${path}.role`, [
          "persona",
          "closeout",
          "hippocampus",
          "compaction",
        ] as const),
        attemptId: idAt(record.attemptId, `${path}.attemptId`),
        content: stringAt(record.content, `${path}.content`),
        redacted: booleanAt(record.redacted, `${path}.redacted`),
      };
    }
    case "internal_cognition": {
      const record = objectAt(value, path, [
        "kind",
        "attemptId",
        "channel",
        "sequence",
        "content",
        "attemptState",
        "externalMessage",
      ]);
      return {
        kind,
        attemptId: idAt(record.attemptId, `${path}.attemptId`),
        channel: enumAt(record.channel, `${path}.channel`, ["reasoning", "assistant"] as const),
        sequence: integerAt(record.sequence, `${path}.sequence`, { min: 0 }),
        content: stringAt(record.content, `${path}.content`),
        attemptState: enumAt(record.attemptState, `${path}.attemptState`, [
          "streaming",
          "completed",
          "failed",
          "aborted",
        ] as const),
        externalMessage: literalAt(record.externalMessage, `${path}.externalMessage`, false),
      };
    }
    case "provider_attempt": {
      const record = objectAt(value, path, [
        "kind",
        "attemptId",
        "turnId",
        "attempt",
        "providerId",
        "modelId",
        "state",
        "retryAt",
        "error",
      ]);
      const state = enumAt(record.state, `${path}.state`, [
        "started",
        "completed",
        "retry_wait",
        "failed",
        "aborted",
      ] as const);
      const retryAt = nullableAt(record.retryAt, `${path}.retryAt`, timestampAt);
      const error = nullableAt(record.error, `${path}.error`, parsePublicError);
      if (state === "retry_wait") {
        if (retryAt === null) fail(`${path}.retryAt`, "retry_wait requires an eligibility timestamp");
        if (error === null) fail(`${path}.error`, "retry_wait requires the failed attempt's error");
      } else if (retryAt !== null) {
        fail(`${path}.retryAt`, "only retry_wait can carry an eligibility timestamp");
      }
      if ((state === "failed" || state === "aborted") && error === null) {
        fail(`${path}.error`, `${state} requires an error fact`);
      }
      if ((state === "started" || state === "completed") && error !== null) {
        fail(`${path}.error`, `${state} cannot carry an error fact`);
      }
      return {
        kind,
        attemptId: idAt(record.attemptId, `${path}.attemptId`),
        turnId: idAt(record.turnId, `${path}.turnId`),
        attempt: integerAt(record.attempt, `${path}.attempt`, { min: 1 }),
        providerId: idAt(record.providerId, `${path}.providerId`),
        modelId: idAt(record.modelId, `${path}.modelId`),
        state,
        retryAt,
        error,
      };
    }
    case "usage": {
      const record = objectAt(value, path, [
        "kind",
        "attemptId",
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
      ]);
      return {
        kind,
        attemptId: idAt(record.attemptId, `${path}.attemptId`),
        inputTokens: integerAt(record.inputTokens, `${path}.inputTokens`, { min: 0 }),
        outputTokens: integerAt(record.outputTokens, `${path}.outputTokens`, { min: 0 }),
        cachedInputTokens: integerAt(record.cachedInputTokens, `${path}.cachedInputTokens`, { min: 0 }),
      };
    }
    case "tool_proposal": {
      const record = objectAt(value, path, [
        "kind",
        "attemptId",
        "toolCallId",
        "toolName",
        "arguments",
        "proposedAt",
      ]);
      return {
        kind,
        attemptId: idAt(record.attemptId, `${path}.attemptId`),
        toolCallId: idAt(record.toolCallId, `${path}.toolCallId`),
        toolName: idAt(record.toolName, `${path}.toolName`),
        arguments: jsonValueAt(record.arguments, `${path}.arguments`),
        proposedAt: timestampAt(record.proposedAt, `${path}.proposedAt`),
      };
    }
    case "tool_dispatch": {
      const record = objectAt(value, path, [
        "kind",
        "toolCallId",
        "dispatchId",
        "intentId",
        "state",
        "checkedAt",
        "externalEffect",
        "authority",
        "receipt",
        "denial",
      ]);
      const state = enumAt(record.state, `${path}.state`, ["blocked", "dispatched"] as const);
      const denial = nullableAt(record.denial, `${path}.denial`, parsePublicError);
      if (state === "blocked" && denial === null)
        fail(`${path}.denial`, "a blocked dispatch requires a denial fact");
      if (state === "dispatched" && denial !== null)
        fail(`${path}.denial`, "a dispatched ToolCall cannot also be denied");
      return {
        kind,
        toolCallId: idAt(record.toolCallId, `${path}.toolCallId`),
        dispatchId: idAt(record.dispatchId, `${path}.dispatchId`),
        intentId: idAt(record.intentId, `${path}.intentId`),
        state,
        checkedAt: timestampAt(record.checkedAt, `${path}.checkedAt`),
        externalEffect: enumAt(record.externalEffect, `${path}.externalEffect`, [
          "none",
          "possible",
        ] as const),
        authority: arrayAt(record.authority, `${path}.authority`, parseAuthorityDecision, {
          minLength: 1,
          maxLength: 2,
        }),
        receipt: jsonValueAt(record.receipt, `${path}.receipt`),
        denial,
      };
    }
    case "tool_outcome": {
      const record = objectAt(value, path, [
        "kind",
        "toolCallId",
        "dispatchId",
        "state",
        "externalEffect",
        "result",
        "error",
      ]);
      const state = enumAt(record.state, `${path}.state`, ["succeeded", "failed", "unknown"] as const);
      const externalEffect = enumAt(record.externalEffect, `${path}.externalEffect`, [
        "none",
        "confirmed",
        "unknown",
      ] as const);
      const result = jsonValueAt(record.result, `${path}.result`);
      const error = nullableAt(record.error, `${path}.error`, parsePublicError);
      if (state === "succeeded" && error !== null)
        fail(`${path}.error`, "a successful ToolCall cannot have an error");
      if (state === "failed" && error === null)
        fail(`${path}.error`, "a failed ToolCall requires an error fact");
      if (state === "unknown") {
        if (externalEffect !== "unknown")
          fail(`${path}.externalEffect`, "unknown outcome requires unknown external effect");
        if (result !== null) fail(`${path}.result`, "unknown outcome cannot claim a result");
        if (error?.code !== "outcome_unknown")
          fail(`${path}.error`, "unknown outcome requires outcome_unknown error");
      }
      return {
        kind,
        toolCallId: idAt(record.toolCallId, `${path}.toolCallId`),
        dispatchId: idAt(record.dispatchId, `${path}.dispatchId`),
        state,
        externalEffect,
        result,
        error,
      };
    }
    case "tool_callback": {
      const record = objectAt(value, path, ["kind", "toolCallId", "callbackId", "outcome"]);
      return {
        kind,
        toolCallId: idAt(record.toolCallId, `${path}.toolCallId`),
        callbackId: idAt(record.callbackId, `${path}.callbackId`),
        outcome: parseToolCallbackOutcome(record.outcome, `${path}.outcome`),
      };
    }
    case "event_committed": {
      const record = objectAt(value, path, [
        "kind",
        "eventId",
        "sourceWorkItemIds",
        "summary",
        "needsMemory",
        "checkpoint",
        "committedAt",
      ]);
      return {
        kind,
        eventId: idAt(record.eventId, `${path}.eventId`),
        sourceWorkItemIds: arrayAt(record.sourceWorkItemIds, `${path}.sourceWorkItemIds`, idAt, {
          minLength: 1,
          maxLength: 100_000,
        }),
        summary: stringAt(record.summary, `${path}.summary`),
        needsMemory: booleanAt(record.needsMemory, `${path}.needsMemory`),
        checkpoint: parseCheckpointRef(record.checkpoint, `${path}.checkpoint`),
        committedAt: timestampAt(record.committedAt, `${path}.committedAt`),
      };
    }
    case "publication": {
      const record = objectAt(value, path, [
        "kind",
        "publicationId",
        "eventId",
        "checkpointId",
        "state",
        "attempt",
        "retryAt",
        "receipt",
        "error",
      ]);
      return {
        kind,
        publicationId: idAt(record.publicationId, `${path}.publicationId`),
        eventId: idAt(record.eventId, `${path}.eventId`),
        checkpointId: idAt(record.checkpointId, `${path}.checkpointId`),
        state: enumAt(record.state, `${path}.state`, [
          "pending",
          "delivering",
          "delivered",
          "retry_wait",
          "failed",
        ] as const),
        attempt: integerAt(record.attempt, `${path}.attempt`, { min: 0 }),
        retryAt: nullableAt(record.retryAt, `${path}.retryAt`, timestampAt),
        receipt: jsonValueAt(record.receipt, `${path}.receipt`),
        error: nullableAt(record.error, `${path}.error`, parsePublicError),
      };
    }
    case "hippocampus": {
      const record = objectAt(value, path, [
        "kind",
        "jobId",
        "eventId",
        "checkpointId",
        "state",
        "attempt",
        "retryAt",
        "error",
      ]);
      return {
        kind,
        jobId: idAt(record.jobId, `${path}.jobId`),
        eventId: idAt(record.eventId, `${path}.eventId`),
        checkpointId: idAt(record.checkpointId, `${path}.checkpointId`),
        state: enumAt(record.state, `${path}.state`, [
          "queued",
          "running",
          "applied",
          "retry_wait",
          "failed",
          "conflict",
        ] as const),
        attempt: integerAt(record.attempt, `${path}.attempt`, { min: 0 }),
        retryAt: nullableAt(record.retryAt, `${path}.retryAt`, timestampAt),
        error: nullableAt(record.error, `${path}.error`, parsePublicError),
      };
    }
    case "lifecycle": {
      const record = objectAt(value, path, ["kind", "phase", "runId", "reason"]);
      return {
        kind,
        phase: enumAt(record.phase, `${path}.phase`, LIFECYCLE_PHASES) as LifecyclePhase,
        runId: nullableAt(record.runId, `${path}.runId`, idAt),
        reason: nullableAt(record.reason, `${path}.reason`, stringAt),
      };
    }
    case "queue": {
      const record = objectAt(value, path, ["kind", "workItem", "action"]);
      return {
        kind,
        workItem: parseQueueItem(record.workItem, `${path}.workItem`),
        action: enumAt(record.action, `${path}.action`, [
          "accepted",
          "activated",
          "frozen",
          "completed",
          "discarded",
        ] as const),
      };
    }
    case "diagnostic": {
      const record = objectAt(value, path, ["kind", "severity", "code", "message", "details"]);
      return {
        kind,
        severity: enumAt(record.severity, `${path}.severity`, ["info", "warning", "error"] as const),
        code: idAt(record.code, `${path}.code`),
        message: stringAt(record.message, `${path}.message`),
        details: jsonValueAt(record.details, `${path}.details`),
      };
    }
  }
}

export function observationKindAt(value: unknown, path: string): ObservationKind {
  return enumAt(value, path, OBSERVATION_KINDS);
}

function assertUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  path: string,
  keyName: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const key = keyOf(value);
    if (seen.has(key)) fail(`${path}[${index}]`, `duplicates ${keyName} ${JSON.stringify(key)}`);
    seen.add(key);
  }
}
