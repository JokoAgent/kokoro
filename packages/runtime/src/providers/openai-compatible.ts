import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  ModelCallContext,
  ModelCapability,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "../model.js";
import { assertCredentialFree, type CredentialGuard, createExactCredentialGuard } from "../security.js";

export interface OpenAiCompatibleProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string | (() => string | Promise<string>);
  models: ReadonlyArray<{
    id: string;
    displayName?: string;
    contextWindow: number;
    maxOutputTokens: number;
    reasoning?: boolean;
  }>;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly credentialGuards: readonly CredentialGuard[];
  readonly #options: OpenAiCompatibleProviderOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.id = options.id;
    this.credentialGuards = Object.freeze([
      createExactCredentialGuard(async () =>
        typeof options.apiKey === "function" ? await options.apiKey() : options.apiKey,
      ),
    ]);
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    const baseUrl = new URL(options.baseUrl);
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new Error("Provider baseUrl must be credential-free HTTP or HTTPS.");
    }
    if (baseUrl.search || baseUrl.hash)
      throw new Error("Provider baseUrl cannot contain query or fragment data.");
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (/(?:authorization|cookie|api[-_]?key|token|secret|password)/iu.test(name)) {
        throw new Error(`Provider header ${name} must come from a controlled authentication provider.`);
      }
      assertCredentialFree(value, `Provider header ${name}`);
    }
  }

  async listModels(): Promise<readonly ModelCapability[]> {
    let authenticated = false;
    let credential: string | undefined;
    try {
      credential =
        typeof this.#options.apiKey === "function" ? await this.#options.apiKey() : this.#options.apiKey;
      authenticated = credential.trim() !== "";
    } catch {
      authenticated = false;
    }
    const capabilities = this.#options.models.map((model) => ({
      provider: this.id,
      model: model.id,
      displayName: model.displayName ?? model.id,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning ?? false,
      authenticated,
    }));
    if (credential && containsExactCredential(capabilities, credential)) {
      throw new ProviderHttpError(500, "provider_credential_in_capabilities");
    }
    return capabilities;
  }

  async complete(request: ModelRequest, context: ModelCallContext): Promise<ModelResponse> {
    context.signal.throwIfAborted();
    await context.emit({ type: "request_started" });
    const model = this.#options.models.find((candidate) => candidate.id === request.model.model);
    if (!model) throw new ProviderHttpError(400, "model_unavailable");
    const apiKey =
      typeof this.#options.apiKey === "function" ? await this.#options.apiKey() : this.#options.apiKey;
    if (apiKey.trim() === "") throw new ProviderHttpError(401, "provider_authentication_unavailable");
    context.signal.throwIfAborted();
    const body = {
      model: request.model.model,
      messages: this.toMessages(request),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
      tool_choice: request.tools.length > 0 ? "auto" : undefined,
      max_tokens: Math.min(request.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
      stream: false,
    };
    if (containsExactCredential(body, apiKey)) {
      throw new ProviderHttpError(400, "provider_credential_in_request_body");
    }
    const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...this.#options.headers,
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    if (!response.ok) throw new ProviderHttpError(response.status, `provider_http_${response.status}`);
    const wire = (await response.json()) as unknown;
    if (containsExactCredential(wire, apiKey)) {
      throw new ProviderHttpError(502, "provider_credential_in_response");
    }
    const result = this.fromResponse(wire);
    if (result.reasoning) await context.emit({ type: "reasoning_delta", delta: result.reasoning });
    if (result.text) await context.emit({ type: "text_delta", delta: result.text });
    for (const call of result.toolCalls) {
      await context.emit({
        type: "tool_call_delta",
        toolCallId: call.id,
        toolName: call.name,
        delta: JSON.stringify(call.arguments),
      });
    }
    await context.emit({ type: "response_completed", response: result });
    return result;
  }

  classifyError(error: unknown): "transient" | "permanent" | "unknown_outcome" {
    if (error instanceof ProviderHttpError) {
      return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
        ? "transient"
        : "permanent";
    }
    if (error instanceof Error && error.name === "AbortError") return "permanent";
    return "transient";
  }

  private toMessages(request: ModelRequest): OpenAiMessage[] {
    const messages: OpenAiMessage[] = [{ role: "system", content: request.system }];
    for (const message of request.messages) messages.push(toOpenAiMessage(message));
    return messages;
  }

  private fromResponse(value: unknown): ModelResponse {
    if (!isRecord(value) || !Array.isArray(value["choices"]) || value["choices"].length === 0) {
      throw new ProviderHttpError(502, "provider_response_invalid");
    }
    const choice = value["choices"][0];
    if (!isRecord(choice) || !isRecord(choice["message"])) {
      throw new ProviderHttpError(502, "provider_response_invalid");
    }
    const message = choice["message"];
    const text = typeof message["content"] === "string" ? message["content"] : "";
    const reasoning =
      typeof message["reasoning_content"] === "string" ? message["reasoning_content"] : undefined;
    const toolCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"].map(parseToolCall) : [];
    const finishReason = choice["finish_reason"];
    const usage = isRecord(value["usage"])
      ? compactUsage(
          finiteInteger(value["usage"]["prompt_tokens"]),
          finiteInteger(value["usage"]["completion_tokens"]),
          isRecord(value["usage"]["completion_tokens_details"])
            ? finiteInteger(value["usage"]["completion_tokens_details"]["reasoning_tokens"])
            : undefined,
        )
      : undefined;
    return {
      id: typeof value["id"] === "string" ? value["id"] : randomUUID(),
      text,
      ...(reasoning === undefined ? {} : { reasoning }),
      toolCalls,
      stopReason: finishReason === "length" ? "length" : toolCalls.length > 0 ? "tool" : "stop",
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ProviderHttpError";
    this.status = status;
    this.code = code;
  }
}

function toOpenAiMessage(message: ModelMessage): OpenAiMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    };
  }
  if (message.role === "user") return { role: "user", content: message.content };
  return {
    role: "assistant",
    content: message.content,
    ...(message.reasoning === undefined ? {} : { reasoning_content: message.reasoning }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }),
  };
}

function parseToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value) || !isRecord(value["function"])) {
    throw new ProviderHttpError(502, "provider_tool_call_invalid");
  }
  const id = typeof value["id"] === "string" && value["id"] !== "" ? value["id"] : randomUUID();
  const name = value["function"]["name"];
  const source = value["function"]["arguments"];
  if (typeof name !== "string" || typeof source !== "string") {
    throw new ProviderHttpError(502, "provider_tool_call_invalid");
  }
  let args: unknown;
  try {
    args = JSON.parse(source);
  } catch {
    throw new ProviderHttpError(502, "provider_tool_arguments_invalid");
  }
  if (!isRecord(args) || !Object.values(args).every(isJsonValue)) {
    throw new ProviderHttpError(502, "provider_tool_arguments_invalid");
  }
  return { id, name, arguments: args as Record<string, JsonValue> };
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function compactUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  reasoningTokens: number | undefined,
): NonNullable<ModelResponse["usage"]> {
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function containsExactCredential(value: unknown, credential: string): boolean {
  if (typeof value === "string") return value.includes(credential);
  if (Array.isArray(value)) return value.some((entry) => containsExactCredential(entry, credential));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) => key.includes(credential) || containsExactCredential(entry, credential),
  );
}
