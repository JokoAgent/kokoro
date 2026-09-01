import type { JsonValue, ModelTool } from "../model.js";
import { NO_CREDENTIAL_GUARDS } from "../security.js";
import type { RuntimeTool, ToolExecutionContext, ToolExecutionResult, ToolTextResolver } from "./types.js";
import { requireOnlyKeys, requireString, ToolInputError } from "./types.js";

abstract class BuiltinTool implements RuntimeTool {
  readonly credentialGuards = NO_CREDENTIAL_GUARDS;
  abstract readonly name: string;
  abstract readonly effect: RuntimeTool["effect"];
  protected readonly text: ToolTextResolver;

  constructor(text: ToolTextResolver) {
    this.text = text;
  }

  abstract describe(locale: string): ModelTool;
  abstract validate(arguments_: Record<string, JsonValue>): void;
  abstract execute(
    arguments_: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export class ContinueExperienceTool extends BuiltinTool {
  readonly name = "continue_experience";
  readonly effect = "none" as const;

  describe(locale: string): ModelTool {
    const text = this.text(locale, this.name);
    return {
      name: this.name,
      label: text.label,
      description: text.description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { focus: { type: "string", description: text.properties["focus"] ?? "" } },
      },
    };
  }

  validate(arguments_: Record<string, JsonValue>): void {
    requireOnlyKeys(arguments_, ["focus"]);
    if (arguments_["focus"] !== undefined && typeof arguments_["focus"] !== "string") {
      throw new ToolInputError("focus must be a string when supplied.");
    }
  }

  async execute(arguments_: Record<string, JsonValue>): Promise<ToolExecutionResult> {
    const focus =
      typeof arguments_["focus"] === "string" && arguments_["focus"].trim() !== ""
        ? arguments_["focus"]
        : null;
    return {
      content: "continuation_recorded",
      details: { recorded: true },
      continuation: { focus },
    };
  }
}

export class SendMessageTool extends BuiltinTool {
  readonly name = "send_message";
  readonly effect = "external" as const;

  describe(locale: string): ModelTool {
    const text = this.text(locale, this.name);
    return {
      name: this.name,
      label: text.label,
      description: text.description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["recipient", "text"],
        properties: {
          recipient: { type: "string", minLength: 1, description: text.properties["recipient"] ?? "" },
          text: { type: "string", minLength: 1, description: text.properties["text"] ?? "" },
        },
      },
    };
  }

  validate(arguments_: Record<string, JsonValue>): void {
    requireOnlyKeys(arguments_, ["recipient", "text"]);
    requireString(arguments_["recipient"], "recipient");
    requireString(arguments_["text"], "text");
  }

  async execute(
    arguments_: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!context.messageDelivery) throw new ToolInputError("Message delivery is not available.");
    const result = await context.messageDelivery.deliver({
      recipient: requireString(arguments_["recipient"], "recipient"),
      text: requireString(arguments_["text"], "text"),
      idempotencyKey: context.toolCallId,
      signal: context.signal,
    });
    return { content: "message_delivered", details: result.receipt };
  }
}

export class ListFilesTool extends BuiltinTool {
  readonly name = "list_files";
  readonly effect = "none" as const;

  describe(locale: string): ModelTool {
    const text = this.text(locale, this.name);
    return {
      name: this.name,
      label: text.label,
      description: text.description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", description: text.properties["path"] ?? "" } },
      },
    };
  }

  validate(arguments_: Record<string, JsonValue>): void {
    requireOnlyKeys(arguments_, ["path"]);
    if (arguments_["path"] !== undefined) requireString(arguments_["path"], "path");
  }

  async execute(
    arguments_: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const files = await context.repository.listFiles(
      typeof arguments_["path"] === "string" ? arguments_["path"] : ".",
    );
    return { content: files.join("\n"), details: { count: files.length } };
  }
}

export class ReadFileTool extends BuiltinTool {
  readonly name = "read_file";
  readonly effect = "none" as const;

  describe(locale: string): ModelTool {
    const text = this.text(locale, this.name);
    return {
      name: this.name,
      label: text.label,
      description: text.description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string", minLength: 1, description: text.properties["path"] ?? "" } },
      },
    };
  }

  validate(arguments_: Record<string, JsonValue>): void {
    requireOnlyKeys(arguments_, ["path"]);
    requireString(arguments_["path"], "path");
  }

  async execute(
    arguments_: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const document = await context.repository.readText(requireString(arguments_["path"], "path"));
    return {
      content: document.content,
      details: { path: document.path, sha256: document.sha256, mtimeMs: document.mtimeMs },
    };
  }
}

export class WriteFileTool extends BuiltinTool {
  readonly name = "write_file";
  readonly effect = "repository" as const;

  describe(locale: string): ModelTool {
    const text = this.text(locale, this.name);
    return {
      name: this.name,
      label: text.label,
      description: text.description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "expectedSha256"],
        properties: {
          path: { type: "string", minLength: 1, description: text.properties["path"] ?? "" },
          content: { type: "string", description: text.properties["content"] ?? "" },
          expectedSha256: {
            anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
            description: text.properties["expectedSha256"] ?? "",
          },
        },
      },
    };
  }

  validate(arguments_: Record<string, JsonValue>): void {
    requireOnlyKeys(arguments_, ["path", "content", "expectedSha256"]);
    requireString(arguments_["path"], "path");
    requireString(arguments_["content"], "content", { allowEmpty: true });
    const expected = arguments_["expectedSha256"];
    if (expected !== null && (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected))) {
      throw new ToolInputError("expectedSha256 must be a SHA-256 string or null.");
    }
  }

  async execute(
    arguments_: Record<string, JsonValue>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const expected = arguments_["expectedSha256"];
    const document = await context.repository.writeText(
      requireString(arguments_["path"], "path"),
      requireString(arguments_["content"], "content", { allowEmpty: true }),
      typeof expected === "string" ? expected : null,
    );
    return {
      content: "file_written",
      details: { path: document.path, sha256: document.sha256, mtimeMs: document.mtimeMs },
    };
  }
}

export function createBuiltinTools(text: ToolTextResolver): RuntimeTool[] {
  return [
    new ContinueExperienceTool(text),
    new SendMessageTool(text),
    new ListFilesTool(text),
    new ReadFileTool(text),
    new WriteFileTool(text),
  ];
}
