import type { PublicErrorCode } from "@kokoro/protocol";
import type { StructuredOutputErrorDetail } from "../model.js";
import {
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  type OwnerTextKey,
  type PromptLocale,
  RUNTIME_CATALOGS,
  type RuntimeCatalog,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type UiLocale,
} from "./catalog.js";
import {
  CatalogValidationError,
  type CatalogValidationIssue,
  type CatalogValidationIssueKind,
  catalogParityIssues,
  interpolateStrict,
  TemplateInterpolationError,
  type TemplateValue,
  templatePlaceholders,
  validateCatalogParity,
} from "./strict.js";

export const SUPPORTED_UI_LOCALES: readonly UiLocale[] = Object.freeze([...SUPPORTED_LOCALES]);
export const SUPPORTED_PROMPT_LOCALES: readonly PromptLocale[] = Object.freeze([...SUPPORTED_LOCALES]);

export interface LocaleSelection {
  readonly uiLocale: UiLocale;
  readonly promptLocale: PromptLocale;
}

export interface RenderedPrompt {
  readonly system: string;
  readonly instruction: string;
}

export interface PersonaPromptInput {
  readonly personaDocuments: string;
  readonly memoryDocuments: string;
  readonly stimulus: string;
  readonly causalFacts: string;
}

export interface CloseoutPromptInput {
  readonly eventEvidence: string;
  readonly causalFacts: string;
  readonly validationError: string;
}

export interface HippocampusPromptInput {
  readonly eventEvidence: string;
  readonly currentMemory: string;
  readonly validationError: string;
}

export interface CompactionPromptInput {
  readonly sessionHistory: string;
  readonly causalFacts: string;
  readonly validationError: string;
}

export interface BuiltinToolText {
  readonly label: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, string>>;
  readonly result: string;
}

export class UnsupportedLocaleError extends Error {
  readonly locale: string;
  readonly surface: "ui" | "prompt";

  constructor(locale: string, surface: "ui" | "prompt") {
    super(`Unsupported ${surface} locale: ${locale}`);
    this.name = "UnsupportedLocaleError";
    this.locale = locale;
    this.surface = surface;
  }
}

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

export function createLocaleSelection(input: {
  readonly uiLocale: string;
  readonly promptLocale: string;
}): LocaleSelection {
  if (!isSupportedLocale(input.uiLocale)) throw new UnsupportedLocaleError(input.uiLocale, "ui");
  if (!isSupportedLocale(input.promptLocale)) {
    throw new UnsupportedLocaleError(input.promptLocale, "prompt");
  }
  return Object.freeze({ uiLocale: input.uiLocale, promptLocale: input.promptLocale });
}

export function buildPersonaPrompt(locale: PromptLocale, input: PersonaPromptInput): RenderedPrompt {
  return renderPrompt(promptCatalog(locale).prompts.persona, {
    personaDocuments: input.personaDocuments,
    memoryDocuments: input.memoryDocuments,
    stimulus: input.stimulus,
    causalFacts: input.causalFacts,
  });
}

export function buildCloseoutPrompt(locale: PromptLocale, input: CloseoutPromptInput): RenderedPrompt {
  return renderPrompt(promptCatalog(locale).prompts.closeout, {
    eventEvidence: input.eventEvidence,
    causalFacts: input.causalFacts,
    validationError: input.validationError,
  });
}

export function buildHippocampusPrompt(locale: PromptLocale, input: HippocampusPromptInput): RenderedPrompt {
  return renderPrompt(promptCatalog(locale).prompts.hippocampus, {
    eventEvidence: input.eventEvidence,
    currentMemory: input.currentMemory,
    validationError: input.validationError,
  });
}

export function buildCompactionPrompt(locale: PromptLocale, input: CompactionPromptInput): RenderedPrompt {
  return renderPrompt(promptCatalog(locale).prompts.compaction, {
    sessionHistory: input.sessionHistory,
    causalFacts: input.causalFacts,
    validationError: input.validationError,
  });
}

export function builtinToolText(locale: PromptLocale, tool: BuiltinToolName): BuiltinToolText {
  const text = promptCatalog(locale).tools[tool];
  if (text === undefined) throw new Error(`Unknown built-in Tool: ${tool}`);
  return Object.freeze({
    label: text.label,
    description: text.description,
    properties: Object.freeze({ ...text.properties }),
    result: text.result,
  });
}

export function renderBuiltinToolResult(locale: PromptLocale, tool: BuiltinToolName, result: string): string {
  return interpolateStrict(builtinToolText(locale, tool).result, { result });
}

export function emptyDocumentsText(locale: PromptLocale): string {
  return promptCatalog(locale).agentText.emptyDocuments;
}

export function agentValidationText(
  locale: PromptLocale,
  code: string,
  detail: StructuredOutputErrorDetail = {},
): string {
  if (code === "") return "";
  const validation = promptCatalog(locale).agentText.validation;
  if (code === "invalid_json") return validation.invalidJson;
  if (code === "object_required") return validation.objectRequired;
  if (code === "exact_fields") {
    return interpolateStrict(validation.exactFields, { fields: (detail.fields ?? []).join(", ") });
  }
  if (code === "non_empty_string") {
    return interpolateStrict(validation.nonEmptyString, { field: detail.field ?? "value" });
  }
  if (code === "invalid_enum") {
    return interpolateStrict(validation.invalidEnum, {
      field: detail.field ?? "value",
      values: (detail.values ?? []).join(" | "),
    });
  }
  if (
    code === "closeout_response_contract_invalid" ||
    code === "compaction_response_contract_invalid" ||
    code === "proposal_response_contract_invalid"
  ) {
    return validation.responseContract;
  }
  return interpolateStrict(validation.generic, { code });
}

export function ownerText(
  locale: UiLocale,
  key: OwnerTextKey,
  values: Readonly<Record<string, TemplateValue>> = {},
): string {
  const catalog = uiCatalog(locale);
  const template = readOwnerTemplate(catalog, key);
  return interpolateStrict(template, values);
}

/** Render an Owner-facing error without exposing a Runtime machine code as prose. */
export function ownerObservationErrorText(
  locale: UiLocale,
  publicCode: PublicErrorCode,
  runtimeCode: string,
): string {
  return uiCatalog(locale).owner.observationError[observationErrorKey(publicCode, runtimeCode)];
}

/** Render a diagnostic code for the Owner; the machine code remains in the diagnostic fields. */
export function ownerObservationDiagnosticText(locale: UiLocale, code: string): string {
  const diagnostics = uiCatalog(locale).owner.observationDiagnostic;
  if (code === "queue_not_restored") return diagnostics.queueNotRestored;
  if (code === "checkpoint_recovery_conflict") return diagnostics.checkpointRecoveryConflict;
  if (code === "repository_operation_recovery_conflict") {
    return diagnostics.repositoryOperationRecoveryConflict;
  }
  if (code === "external_outcome_unknown") return diagnostics.externalOutcomeUnknown;
  if (code === "invalid_internal_fact") return diagnostics.invalidInternalFact;
  if (code === "internal_observation" || code === "queue_item_not_public") {
    return diagnostics.internalObservation;
  }
  return diagnostics.runtimeFailure;
}

export function validateBuiltInCatalogs(): void {
  validateCatalogParity(RUNTIME_CATALOGS.en, RUNTIME_CATALOGS["zh-CN"]);
}

function renderPrompt(
  template: Readonly<{ system: string; instruction: string }>,
  values: Readonly<Record<string, TemplateValue>>,
): RenderedPrompt {
  return Object.freeze({
    system: interpolateStrict(template.system, {}),
    instruction: interpolateStrict(template.instruction, values),
  });
}

function promptCatalog(locale: PromptLocale): RuntimeCatalog {
  if (!isSupportedLocale(locale)) throw new UnsupportedLocaleError(String(locale), "prompt");
  return RUNTIME_CATALOGS[locale];
}

function uiCatalog(locale: UiLocale): RuntimeCatalog {
  if (!isSupportedLocale(locale)) throw new UnsupportedLocaleError(String(locale), "ui");
  return RUNTIME_CATALOGS[locale];
}

function readOwnerTemplate(catalog: RuntimeCatalog, key: OwnerTextKey): string {
  const [section, item, unexpected] = key.split(".");
  if (section === undefined || item === undefined || unexpected !== undefined) {
    throw new Error(`Invalid Owner text key: ${key}`);
  }
  const group = (catalog.owner as Readonly<Record<string, unknown>>)[section];
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    throw new Error(`Invalid Owner text key: ${key}`);
  }
  const template = (group as Readonly<Record<string, unknown>>)[item];
  if (typeof template !== "string") throw new Error(`Invalid Owner text key: ${key}`);
  return template;
}

function observationErrorKey(
  publicCode: PublicErrorCode,
  runtimeCode: string,
): keyof RuntimeCatalog["owner"]["observationError"] {
  if (runtimeCode === "aborted") return "aborted";
  if (
    runtimeCode === "authentication_required" ||
    runtimeCode === "authentication_failed" ||
    runtimeCode === "invalid_api_key" ||
    runtimeCode === "provider_authentication_unavailable" ||
    runtimeCode === "unauthorized" ||
    /^provider_http_(401|403)$/u.test(runtimeCode)
  ) {
    return "authenticationRequired";
  }
  if (runtimeCode === "callback_channel_unavailable") return "callbackUnavailable";
  if (runtimeCode === "checkpoint_required" || runtimeCode === "invalid_checkpoint") {
    return "checkpointRequired";
  }
  if (runtimeCode === "context_too_large") return "contextTooLarge";
  if (
    runtimeCode === "credential_detected" ||
    runtimeCode === "credentials" ||
    runtimeCode.startsWith("provider_credential_")
  ) {
    return "credentialRejected";
  }
  if (runtimeCode === "force_restore") return "forceRestore";
  if (runtimeCode === "hippocampus_failed") return "hippocampusFailed";
  if (runtimeCode === "conflict" || runtimeCode === "memory_conflict") return "memoryConflict";
  if (runtimeCode === "invalid_path" || runtimeCode === "invalid_schema") {
    return "memoryProposalInvalid";
  }
  if (runtimeCode === "model_failed") return "modelFailed";
  if (runtimeCode === "external_outcome_unknown" || runtimeCode === "outcome_unknown") {
    return "outcomeUnknown";
  }
  if (runtimeCode === "permission_denied" || runtimeCode === "permission_revoked_before_dispatch") {
    return "permissionDenied";
  }
  if (runtimeCode === "provider_response_invalid" || runtimeCode.startsWith("provider_tool_")) {
    return "providerResponseInvalid";
  }
  if (runtimeCode.startsWith("provider_http_")) {
    return runtimeCode === "provider_http_429" ? "rateLimited" : "providerFailed";
  }
  if (runtimeCode === "provider_failed") return "providerFailed";
  if (runtimeCode === "publication_failed" || runtimeCode === "delivery_failed") {
    return "publicationFailed";
  }
  if (runtimeCode === "rate_limited") return "rateLimited";
  if (
    runtimeCode === "closeout_response_contract_invalid" ||
    runtimeCode === "compaction_response_contract_invalid" ||
    runtimeCode === "proposal_response_contract_invalid" ||
    runtimeCode === "response_truncated" ||
    runtimeCode === "structured_output_failed" ||
    runtimeCode === "structured_output_invalid"
  ) {
    return "responseContractInvalid";
  }
  if (runtimeCode === "source_event_invalid") return "sourceEventInvalid";
  if (runtimeCode === "tool_arguments_invalid") return "toolArgumentsInvalid";
  if (runtimeCode === "tool_failed") return "toolFailed";
  if (runtimeCode === "tool_unavailable") return "toolUnavailable";
  if (runtimeCode === "persona_turn_limit") return "turnLimit";
  if (
    runtimeCode === "model_unavailable" ||
    runtimeCode === "provider_unavailable" ||
    runtimeCode === "unavailable"
  ) {
    return "unavailable";
  }

  if (publicCode === "invalid_request") return "invalidRequest";
  if (publicCode === "unsupported_version") return "unsupportedVersion";
  if (publicCode === "not_found") return "notFound";
  if (publicCode === "revision_conflict") return "revisionConflict";
  if (publicCode === "invalid_state") return "invalidState";
  if (publicCode === "permission_denied") return "permissionDenied";
  if (publicCode === "working_tree_conflict") return "workingTreeConflict";
  if (publicCode === "outcome_unknown") return "outcomeUnknown";
  if (publicCode === "rate_limited") return "rateLimited";
  if (publicCode === "unavailable") return "unavailable";
  return "internalFailure";
}

export {
  BUILTIN_TOOL_NAMES,
  CatalogValidationError,
  TemplateInterpolationError,
  catalogParityIssues,
  interpolateStrict,
  templatePlaceholders,
  validateCatalogParity,
};
export type {
  BuiltinToolName,
  CatalogValidationIssue,
  CatalogValidationIssueKind,
  OwnerTextKey,
  PromptLocale,
  SupportedLocale,
  TemplateValue,
  UiLocale,
};
export { draftTemplates } from "./templates.js";
