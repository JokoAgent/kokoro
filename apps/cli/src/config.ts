import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertCredentialFree, type ModelRef, type OpenAiCompatibleProviderOptions } from "@kokoro/runtime";

const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 103;
const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107;

export interface CliConfig {
  stateDirectory: string;
  personaDirectory: string;
  socketPath: string;
  defaultModel?: ModelRef;
  providers: OpenAiCompatibleProviderOptions[];
}

export async function loadConfig(file: string): Promise<CliConfig> {
  const absolute = path.resolve(file);
  const base = path.dirname(absolute);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  } catch (error) {
    throw new CliConfigError(
      "The configuration file could not be read as JSON.",
      "无法读取配置文件，或其内容不是有效 JSON。",
      { cause: error },
    );
  }
  const value = object(raw, "config");
  exactKeys(value, ["stateDirectory", "personaDirectory", "socketPath", "defaultModel", "providers"]);
  const stateDirectory = resolveFrom(base, string(value["stateDirectory"], "stateDirectory"));
  const personaDirectory = resolveFrom(base, string(value["personaDirectory"], "personaDirectory"));
  const socketPath = socket(value["socketPath"], base);
  assertNonSecretConfigValue(stateDirectory, "stateDirectory");
  assertNonSecretConfigValue(personaDirectory, "personaDirectory");
  assertNonSecretConfigValue(socketPath, "socketPath");
  const providersValue = value["providers"];
  if (!Array.isArray(providersValue)) {
    throw new CliConfigError("providers must be an array.", "providers 必须是数组。");
  }
  const providers = providersValue.map((provider, index) => parseProvider(provider, index));
  const defaultModel = value["defaultModel"] === undefined ? undefined : parseModel(value["defaultModel"]);
  return {
    stateDirectory,
    personaDirectory,
    socketPath,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    providers,
  };
}

export class CliConfigError extends Error {
  readonly zhCN: string;

  constructor(message: string, zhCN: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliConfigError";
    this.zhCN = zhCN;
  }
}

function parseProvider(value: unknown, index: number): OpenAiCompatibleProviderOptions {
  const provider = object(value, `providers[${index}]`);
  exactKeys(provider, ["type", "id", "baseUrl", "apiKeyEnv", "models", "headers"]);
  if (provider["type"] !== "openai-compatible") {
    throw new CliConfigError(
      `providers[${index}].type must be openai-compatible.`,
      `providers[${index}].type 必须是 openai-compatible。`,
    );
  }
  const apiKeyEnvironment = string(provider["apiKeyEnv"], `providers[${index}].apiKeyEnv`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnvironment)) {
    throw new CliConfigError(
      `providers[${index}].apiKeyEnv is not an environment variable name.`,
      `providers[${index}].apiKeyEnv 不是有效的环境变量名。`,
    );
  }
  const modelsValue = provider["models"];
  if (!Array.isArray(modelsValue) || modelsValue.length === 0) {
    throw new CliConfigError(
      `providers[${index}].models must be a non-empty array.`,
      `providers[${index}].models 必须是非空数组。`,
    );
  }
  const headers =
    provider["headers"] === undefined
      ? undefined
      : stringRecord(provider["headers"], `providers[${index}].headers`);
  const baseUrl = providerUrl(string(provider["baseUrl"], `providers[${index}].baseUrl`), index);
  if (headers) validateHeaders(headers, index);
  return {
    id: string(provider["id"], `providers[${index}].id`),
    baseUrl,
    apiKey: () => {
      const credential = process.env[apiKeyEnvironment];
      if (!credential) {
        throw new CliConfigError(
          `Provider credential environment variable is not set: ${apiKeyEnvironment}`,
          `未设置 Provider 凭据环境变量：${apiKeyEnvironment}`,
        );
      }
      return credential;
    },
    models: modelsValue.map((model, modelIndex) => parseProviderModel(model, index, modelIndex)),
    ...(headers === undefined ? {} : { headers }),
  };
}

function providerUrl(value: string, index: number): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new CliConfigError(
      `providers[${index}].baseUrl must be an absolute URL.`,
      `providers[${index}].baseUrl 必须是绝对 URL。`,
      { cause: error },
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new CliConfigError(
      `providers[${index}].baseUrl must be credential-free HTTP(S) without query or fragment data.`,
      `providers[${index}].baseUrl 必须是不含凭据、查询参数或片段的 HTTP(S) URL。`,
    );
  }
  return value;
}

function validateHeaders(headers: Readonly<Record<string, string>>, index: number): void {
  for (const [name, value] of Object.entries(headers)) {
    if (/(?:authorization|cookie|api[-_]?key|token|secret|password)/iu.test(name)) {
      throw new CliConfigError(
        `providers[${index}].headers.${name} cannot carry authentication material; use apiKeyEnv.`,
        `providers[${index}].headers.${name} 不能携带认证材料；请使用 apiKeyEnv。`,
      );
    }
    try {
      assertCredentialFree(value, `providers[${index}].headers.${name}`);
    } catch (error) {
      throw new CliConfigError(
        `providers[${index}].headers.${name} contains credential-like material.`,
        `providers[${index}].headers.${name} 含有疑似凭据的内容。`,
        { cause: error },
      );
    }
  }
}

function parseProviderModel(value: unknown, providerIndex: number, modelIndex: number) {
  const prefix = `providers[${providerIndex}].models[${modelIndex}]`;
  const model = object(value, prefix);
  exactKeys(model, ["id", "displayName", "contextWindow", "maxOutputTokens", "reasoning"]);
  const displayName =
    model["displayName"] === undefined ? undefined : string(model["displayName"], `${prefix}.displayName`);
  const reasoning =
    model["reasoning"] === undefined ? undefined : boolean(model["reasoning"], `${prefix}.reasoning`);
  return {
    id: string(model["id"], `${prefix}.id`),
    ...(displayName === undefined ? {} : { displayName }),
    contextWindow: positiveInteger(model["contextWindow"], `${prefix}.contextWindow`),
    maxOutputTokens: positiveInteger(model["maxOutputTokens"], `${prefix}.maxOutputTokens`),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function parseModel(value: unknown): ModelRef {
  const model = object(value, "defaultModel");
  exactKeys(model, ["provider", "model"]);
  return {
    provider: string(model["provider"], "defaultModel.provider"),
    model: string(model["model"], "defaultModel.model"),
  };
}

function socket(value: unknown, base: string): string {
  const selected = string(value, "socketPath");
  if (process.platform === "win32") {
    if (!selected.startsWith("\\\\.\\pipe\\")) {
      throw new CliConfigError(
        "Windows socketPath must be a \\\\.\\pipe\\ named pipe path.",
        "Windows socketPath 必须是 \\\\.\\pipe\\ 命名管道路径。",
      );
    }
    return selected;
  }
  const resolved = resolveFrom(base, selected);
  assertUnixSocketPathLength(resolved, process.platform);
  return resolved;
}

export function assertUnixSocketPathLength(socketPath: string, platform: NodeJS.Platform): void {
  const maximum =
    platform === "linux" ? LINUX_UNIX_SOCKET_PATH_MAX_BYTES : DARWIN_UNIX_SOCKET_PATH_MAX_BYTES;
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes <= maximum) return;
  throw new CliConfigError(
    `Unix socketPath uses ${bytes} UTF-8 bytes; ${platform} supports at most ${maximum}.`,
    `Unix socketPath 使用了 ${bytes} 个 UTF-8 字节；${platform} 最多支持 ${maximum} 个。`,
  );
}

function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

function assertNonSecretConfigValue(value: string, name: string): void {
  try {
    assertCredentialFree(value, `CLI ${name}`);
  } catch (error) {
    throw new CliConfigError(`${name} contains credential-like material.`, `${name} 含有疑似凭据的内容。`, {
      cause: error,
    });
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliConfigError(`${name} must be an object.`, `${name} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new CliConfigError(`Unknown config field: ${unknown}`, `未知配置字段：${unknown}`);
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new CliConfigError(`${name} must be a non-empty string.`, `${name} 必须是非空字符串。`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new CliConfigError(`${name} must be boolean.`, `${name} 必须是布尔值。`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new CliConfigError(`${name} must be a positive integer.`, `${name} 必须是正整数。`);
  return value as number;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = object(value, name);
  if (!Object.values(record).every((entry) => typeof entry === "string")) {
    throw new CliConfigError(`${name} values must be strings.`, `${name} 的所有值都必须是字符串。`);
  }
  return record as Record<string, string>;
}
