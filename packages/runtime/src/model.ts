import {
  assertCredentialBoundary,
  type CredentialBoundary,
  type CredentialGuard,
  captureCredentialSnapshot,
} from "./security.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ModelRef {
  provider: string;
  model: string;
}

export interface ModelCapability extends ModelRef {
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  authenticated: boolean;
}

export type ModelRole = "persona" | "closeout" | "hippocampus" | "compaction";

export interface ModelTool {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
}

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  isError?: boolean;
}

export interface ModelRequest {
  id: string;
  role: ModelRole;
  model: ModelRef;
  promptLocale: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxOutputTokens?: number;
  continuation: boolean;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface ModelResponse {
  id?: string;
  text: string;
  reasoning?: string;
  toolCalls: ModelToolCall[];
  stopReason: "stop" | "tool" | "length";
  usage?: ModelUsage;
}

export type ModelStreamEvent =
  | { type: "request_started" }
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_delta"; toolCallId: string; toolName: string; delta: string }
  | { type: "response_completed"; response: ModelResponse };

export interface ModelCallContext {
  signal: AbortSignal;
  emit(event: ModelStreamEvent): Promise<void> | void;
}

export interface ModelProvider extends CredentialBoundary {
  readonly id: string;
  listModels(): Promise<readonly ModelCapability[]> | readonly ModelCapability[];
  complete(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse>;
  classifyError?(error: unknown): "transient" | "permanent" | "unknown_outcome";
}

export class ProviderRegistry implements CredentialBoundary {
  readonly #providers = new Map<string, ModelProvider>();

  constructor(providers: readonly ModelProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ModelProvider): void {
    assertCredentialBoundary(provider, "ModelProvider");
    if (provider.id.trim() === "") throw new Error("Provider id must not be empty.");
    if (this.#providers.has(provider.id)) throw new Error("Provider is already registered.");
    this.#providers.set(provider.id, provider);
  }

  get credentialGuards(): readonly CredentialGuard[] {
    return [...this.#providers.values()].flatMap((provider) => [...provider.credentialGuards]);
  }

  get(id: string): ModelProvider | undefined {
    return this.#providers.get(id);
  }

  require(ref: ModelRef): ModelProvider {
    const provider = this.#providers.get(ref.provider);
    if (!provider) throw new ModelConfigurationError("provider_unavailable", ref);
    return provider;
  }

  async capabilities(): Promise<ModelCapability[]> {
    const result: ModelCapability[] = [];
    for (const provider of this.#providers.values()) {
      const before = await captureCredentialSnapshot(provider, "ModelProvider capability boundary");
      const capabilities = await provider.listModels();
      before.assertCredentialFree(JSON.stringify(capabilities), "Provider capabilities");
      (await captureCredentialSnapshot(provider, "ModelProvider capability boundary")).assertCredentialFree(
        JSON.stringify(capabilities),
        "Provider capabilities",
      );
      result.push(...capabilities);
    }
    return result;
  }
}

export class ModelConfigurationError extends Error {
  readonly code: "provider_unavailable" | "model_unavailable";
  readonly model: ModelRef;

  constructor(code: ModelConfigurationError["code"], model: ModelRef) {
    super(`${code}: ${model.provider}/${model.model}`);
    this.name = "ModelConfigurationError";
    this.code = code;
    this.model = model;
  }
}

export function parseStrictJsonObject(text: string): Record<string, JsonValue> {
  const trimmed = text.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new StructuredOutputError("invalid_json", {}, { cause: error });
  }
  if (!isJsonObject(value)) throw new StructuredOutputError("object_required");
  return value;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJsonValue);
}

export type StructuredOutputErrorCode =
  | "invalid_json"
  | "object_required"
  | "exact_fields"
  | "non_empty_string"
  | "invalid_enum"
  | "stored_manifest_invalid";

export interface StructuredOutputErrorDetail {
  readonly field?: string;
  readonly fields?: readonly string[];
  readonly values?: readonly string[];
  readonly location?: string;
}

export class StructuredOutputError extends Error {
  readonly code: StructuredOutputErrorCode;
  readonly detail: Readonly<StructuredOutputErrorDetail>;

  constructor(
    code: StructuredOutputErrorCode,
    detail: StructuredOutputErrorDetail = {},
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "StructuredOutputError";
    this.code = code;
    this.detail = Object.freeze({
      ...detail,
      ...(detail.fields === undefined ? {} : { fields: Object.freeze([...detail.fields]) }),
      ...(detail.values === undefined ? {} : { values: Object.freeze([...detail.values]) }),
    });
  }
}
