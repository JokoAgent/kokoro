import type { JsonValue, ModelTool } from "../model.js";
import type { RepositoryDocument } from "../repository/index.js";
import {
  assertCredentialBoundary,
  type CredentialBoundary,
  type CredentialGuard,
  NO_CREDENTIAL_GUARDS,
} from "../security.js";

export type ToolEffect = "none" | "repository" | "external";

export interface ToolAuthorizationRequest {
  personaId: string;
  runId: string;
  eventId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, JsonValue>;
  effect: ToolEffect;
}

export interface AuthorizationDecision {
  allow: boolean;
  revision: string;
  reason?: string;
}

export interface AuthorizationPolicy extends CredentialBoundary {
  authorize(request: ToolAuthorizationRequest): Promise<AuthorizationDecision> | AuthorizationDecision;
}

export class AllowAllAuthorizationPolicy implements AuthorizationPolicy {
  readonly credentialGuards = NO_CREDENTIAL_GUARDS;

  authorize(): AuthorizationDecision {
    return { allow: true, revision: "allow-all-v1" };
  }
}

export interface MessageDeliveryResult {
  receipt: JsonValue;
}

export interface MessageDelivery extends CredentialBoundary {
  deliver(input: {
    recipient: string;
    text: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<MessageDeliveryResult>;
}

export interface ToolExecutionContext {
  personaId: string;
  runId: string;
  eventId: string;
  toolCallId: string;
  /**
   * The deliberately narrow repository capability granted to a Tool. It does
   * not reveal the Persona repository root, Git operations, checkpoint
   * controls, or Memory-maintenance APIs.
   */
  repository: Readonly<ToolRepositoryAccess>;
  signal: AbortSignal;
  messageDelivery?: MessageDelivery;
}

export interface ToolRepositoryAccess {
  listFiles(relativeDirectory?: string): Promise<string[]>;
  readText(relativePath: string): Promise<RepositoryDocument>;
  writeText(
    relativePath: string,
    content: string,
    expectedSha256: string | null,
  ): Promise<RepositoryDocument>;
}

export interface ToolExecutionResult {
  content: string;
  details?: JsonValue;
  continuation?: { focus: string | null };
  callbackPending?: boolean;
}

export interface RuntimeTool extends CredentialBoundary {
  readonly name: string;
  readonly effect: ToolEffect;
  describe(locale: string): ModelTool;
  validate(arguments_: Record<string, JsonValue>): void;
  execute(arguments_: Record<string, JsonValue>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolText {
  label: string;
  description: string;
  properties: Record<string, string>;
  results: Record<string, string>;
}

export type ToolTextResolver = (locale: string, name: string) => ToolText;

export class ToolRegistry implements CredentialBoundary {
  readonly #tools = new Map<string, RuntimeTool>();

  constructor(tools: readonly RuntimeTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RuntimeTool): void {
    assertCredentialBoundary(tool, "RuntimeTool");
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name)) throw new Error("Invalid Tool name.");
    if (this.#tools.has(tool.name)) throw new Error("Tool is already registered.");
    this.#tools.set(tool.name, tool);
  }

  get credentialGuards(): readonly CredentialGuard[] {
    return [...this.#tools.values()].flatMap((tool) => [...tool.credentialGuards]);
  }

  get(name: string): RuntimeTool | undefined {
    return this.#tools.get(name);
  }

  list(): RuntimeTool[] {
    return [...this.#tools.values()];
  }
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function requireOnlyKeys(value: Record<string, JsonValue>, allowed: readonly string[]): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new ToolInputError(`Unknown tool argument: ${extras[0]}`);
}

export function requireString(
  value: JsonValue | undefined,
  name: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string" || (!options.allowEmpty && value.trim() === "")) {
    throw new ToolInputError(`${name} must be a${options.allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
}
