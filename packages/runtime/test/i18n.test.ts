import { describe, expect, it } from "vitest";
import {
  agentValidationText,
  BUILTIN_TOOL_NAMES,
  buildCloseoutPrompt,
  buildCompactionPrompt,
  buildHippocampusPrompt,
  buildPersonaPrompt,
  builtinToolText,
  CatalogValidationError,
  catalogParityIssues,
  createLocaleSelection,
  emptyDocumentsText,
  interpolateStrict,
  ownerText,
  type PromptLocale,
  renderBuiltinToolResult,
  SUPPORTED_PROMPT_LOCALES,
  SUPPORTED_UI_LOCALES,
  TemplateInterpolationError,
  templatePlaceholders,
  type UnsupportedLocaleError,
  validateBuiltInCatalogs,
  validateCatalogParity,
} from "../src/i18n/index.js";
import type { JsonValue } from "../src/model.js";
import { parseCloseoutDecision } from "../src/roles/index.js";
import {
  formatCloseoutCausalFacts,
  formatCloseoutEventEvidence,
  formatCompactionSessionHistory,
  formatDocuments,
  formatHippocampusEventEvidence,
  formatPersonaCausalFacts,
  formatPersonaStimulus,
  sessionMessages,
} from "../src/session/index.js";
import type { SessionEntryFact, ToolCallFact } from "../src/store/index.js";

describe("strict locale catalog", () => {
  it("ships complete en and zh-CN catalogs with recursive key and placeholder parity", () => {
    expect(SUPPORTED_UI_LOCALES).toEqual(["en", "zh-CN"]);
    expect(SUPPORTED_PROMPT_LOCALES).toEqual(["en", "zh-CN"]);
    expect(() => validateBuiltInCatalogs()).not.toThrow();
  });

  it("reports nested missing, extra, type, empty, and placeholder defects", () => {
    const reference = {
      prompt: {
        title: "Hello {name}",
        body: "Body",
        empty: "",
      },
    };
    const candidate = {
      prompt: {
        title: "你好 {person}",
        empty: "非空",
        extra: "unexpected",
      },
    };

    const issues = catalogParityIssues(reference, candidate);
    expect(issues.map(({ kind }) => kind)).toEqual([
      "missing-key",
      "extra-key",
      "empty-string",
      "placeholder-mismatch",
    ]);
    expect(() => validateCatalogParity(reference, candidate)).toThrow(CatalogValidationError);
    expect(() => validateCatalogParity({ value: "text" }, { value: { nested: "text" } })).toThrow(
      /type-mismatch/u,
    );
  });

  it("renders stable structured-output codes and empty document markers in the Prompt locale", () => {
    expect(() => parseCloseoutDecision('{"summary":"ok","memory":"none","extra":true}')).toThrow(
      expect.objectContaining({
        message: "exact_fields",
        code: "exact_fields",
        detail: { fields: ["memory", "summary"] },
      }),
    );
    expect(agentValidationText("en", "exact_fields", { fields: ["memory", "summary"] })).toBe(
      "Return exactly these fields: memory, summary.",
    );
    const chinese = agentValidationText("zh-CN", "exact_fields", {
      fields: ["memory", "summary"],
    });
    expect(chinese).toBe("只返回这些字段：memory, summary。");
    expect(chinese).not.toMatch(/Expected|Return exactly/u);
    expect(formatDocuments([], emptyDocumentsText("en"))).toBe("(no Markdown documents)");
    expect(formatDocuments([], emptyDocumentsText("zh-CN"))).toBe("（没有 Markdown 文档）");
  });
});

describe("role-specific semantic projections", () => {
  const source = {
    kind: "continuation",
    payload: { text: "保留这段原始刺激" },
    stimulusId: "stimulus-control-id",
    sourceEventId: "event-control-id",
    sourceToolCallId: "internal-call-id",
    originAction: { name: "send_message", effect: "external", status: "awaiting_callback" },
  } as const;
  const entries: SessionEntryFact[] = [
    {
      id: "session-entry-control-id",
      sessionId: "session-control-id",
      eventId: "event-control-id",
      sequence: 41,
      kind: "user",
      payload: { content: JSON.stringify(source), dynamicPersonaInstruction: true },
      createdAt: 1,
    },
    {
      id: "assistant-entry-control-id",
      sessionId: "session-control-id",
      eventId: "event-control-id",
      sequence: 42,
      kind: "assistant",
      payload: {
        content: "需要发送确认。",
        reasoning: "对外动作仍待回调。",
        toolCalls: [
          {
            id: "provider-call-id",
            name: "send_message",
            arguments: { recipient: "owner", text: "已处理" },
          },
        ],
      },
      createdAt: 2,
    },
    {
      id: "tool-entry-control-id",
      sessionId: "session-control-id",
      eventId: "event-control-id",
      sequence: 43,
      kind: "tool",
      payload: {
        toolCallId: "provider-call-id",
        toolName: "send_message",
        rawResult: { accepted: true, state: "unknown" },
        content: "远端已接受，最终状态未知。",
      },
      createdAt: 3,
    },
  ];
  const toolCalls: ToolCallFact[] = [
    {
      id: "internal-call-id",
      eventId: "event-control-id",
      turnId: "turn-control-id",
      sequence: 7,
      providerCallId: "provider-call-id",
      name: "send_message",
      arguments: { recipient: "owner", text: "已处理" },
      effect: "external",
      status: "awaiting_callback",
      authorizationRevision: "authorization-control-id",
      dispatchResult: { accepted: true },
      result: null,
      proposedAt: 1,
      intentAt: 2,
      dispatchAt: 3,
      outcomeAt: null,
    },
  ];
  const frozen = JSON.parse(
    JSON.stringify({
      version: 1,
      eventId: "event-control-id",
      personaId: "persona-control-id",
      sequence: 9,
      source,
      sessionEntries: entries,
      toolCalls,
    }),
  ) as JsonValue;

  it("removes durable control identifiers while retaining source, action, and outcome semantics", () => {
    const projections = [
      formatPersonaStimulus(source),
      formatPersonaCausalFacts(toolCalls),
      formatCloseoutCausalFacts(toolCalls),
      formatCloseoutEventEvidence(frozen),
      formatHippocampusEventEvidence(frozen),
      formatCompactionSessionHistory(entries),
      JSON.stringify(sessionMessages(entries)),
    ];
    for (const projection of projections) {
      expect(projection).not.toMatch(
        /stimulus-control-id|event-control-id|internal-call-id|provider-call-id|session-control-id|turn-control-id|authorization-control-id/u,
      );
    }
    expect(projections.join("\n")).toContain("send_message");
    expect(projections.join("\n")).toContain("awaiting_callback");
    expect(projections.join("\n")).toContain("已处理");
    expect(projections.join("\n")).toContain('"state": "unknown"');
    expect(formatCompactionSessionHistory(entries)).not.toContain("远端已接受，最终状态未知。");
    expect(JSON.stringify(sessionMessages(entries))).not.toContain("远端已接受，最终状态未知。");
    expect(JSON.stringify(sessionMessages(entries))).toContain('"toolCallId":"action-1"');
    expect(sessionMessages(entries).find((message) => message.role === "tool")?.content).toContain(
      '"accepted":true',
    );
    expect(
      JSON.stringify(
        sessionMessages(entries, {
          eventId: "event-control-id",
          instruction: "instruction",
          promptLocale: "zh-CN",
        }),
      ),
    ).toContain("消息行动结果（Tool 权威报告）");
  });
});

describe("strict interpolation", () => {
  it("requires exactly the catalog variables", () => {
    expect(templatePlaceholders("{second} {first} {second}")).toEqual(["first", "second"]);
    expect(interpolateStrict("Hello {name}, count {count}.", { name: "Kokoro", count: 2 })).toBe(
      "Hello Kokoro, count 2.",
    );

    expect(() => interpolateStrict("Hello {name}.", {})).toThrow(TemplateInterpolationError);
    expect(() => interpolateStrict("Hello.", { name: "extra" })).toThrow(TemplateInterpolationError);
    expect(() => interpolateStrict("{one} {two}", { one: "1" })).toThrow(/missing variables: two/u);
  });

  it("preserves raw content byte-for-byte, including placeholder-looking source text", () => {
    const raw = "第一行\r\n{not_a_catalog_variable}\n<owner>{still_raw}</owner> 😀";
    const rendered = interpolateStrict("BEGIN\n{content}\nEND", { content: raw });
    expect(rendered).toBe(`BEGIN\n${raw}\nEND`);
    expect(rendered.slice("BEGIN\n".length, -"\nEND".length)).toBe(raw);
  });

  it("rejects invalid runtime values instead of stringifying them silently", () => {
    const invalid = { value: undefined } as unknown as Readonly<Record<string, string>>;
    expect(() => interpolateStrict("{value}", invalid)).toThrow(/invalid variables: value/u);
  });
});

describe("independent UI and Prompt locales", () => {
  it("does not let either locale silently change or fall back to the other", () => {
    const selection = createLocaleSelection({ uiLocale: "zh-CN", promptLocale: "en" });
    expect(ownerText(selection.uiLocale, "lifecycle.running")).toBe("Persona 正在持续运行。");

    const prompt = buildPersonaPrompt(selection.promptLocale, personaInput());
    expect(prompt.system).toContain("private cognition");
    expect(prompt.system).not.toContain("普通 assistant 文本是私有认知");
  });

  it("fails closed for an unsupported locale on the correct surface", () => {
    expect(() => createLocaleSelection({ uiLocale: "fr", promptLocale: "en" })).toThrow(
      expect.objectContaining<Partial<UnsupportedLocaleError>>({ surface: "ui", locale: "fr" }),
    );
    expect(() => createLocaleSelection({ uiLocale: "en", promptLocale: "zh" })).toThrow(
      expect.objectContaining<Partial<UnsupportedLocaleError>>({ surface: "prompt", locale: "zh" }),
    );
  });
});

describe.each<PromptLocale>(["en", "zh-CN"])("%s agent prompts", (locale) => {
  it("keeps Persona cognition private and requires explicit continuation", () => {
    const input = personaInput();
    const prompt = buildPersonaPrompt(locale, input);

    expect(prompt.system).toContain("continue_experience");
    expect(prompt.system).toMatch(
      locale === "en" ? /assistant text is private cognition/u : /assistant 文本是私有认知/u,
    );
    expect(prompt.system).toMatch(
      locale === "en" ? /Tool.*actual outcome|Tool result/u : /Tool.*真实|Tool 结果/u,
    );
    expect(prompt.system).toMatch(locale === "en" ? /Use English/u : /使用简体中文/u);
    expect(prompt.system).not.toContain("high-school girl");
    expect(prompt.system).not.toContain("高中女生");
    expectVerbatimBlocks(prompt.instruction, Object.values(input));
  });

  it("makes closeout read only over one frozen Event and uses the stable output schema", () => {
    const input = {
      eventEvidence: "event原文 {event_placeholder}\nassistant≠message",
      causalFacts: "tool-1: dispatched; external outcome=unknown",
      validationError: "memory had an invalid value {raw}",
    };
    const prompt = buildCloseoutPrompt(locale, input);

    expect(prompt.system).toContain('{"summary":"...","memory":"none"}');
    expect(prompt.system).toContain('"maintain"');
    expect(prompt.system).toMatch(locale === "en" ? /frozen Event|read-only/u : /冻结|只读/u);
    expect(prompt.system).toMatch(locale === "en" ? /Do not.*modify Memory/u : /不要.*修改 Memory/u);
    expectVerbatimBlocks(prompt.instruction, Object.values(input));
  });

  it("limits Hippocampus to an atomic Memory proposal without effect Tools", () => {
    const input = {
      eventEvidence: "checkpointed event原文 {source}",
      currentMemory: "workspace/memory/2026-08-30/a.md\n原文 {memory}",
      validationError: "no previous validation error {raw}",
    };
    const prompt = buildHippocampusPrompt(locale, input);

    expect(prompt.system).toContain("workspace/memory/**/*.md");
    expect(prompt.system).toContain("workspace/memory/YYYY-MM-DD/*.md");
    expect(prompt.system).toMatch(locale === "en" ? /no external-effect Tool/u : /没有外部效果 Tool/u);
    expect(prompt.system).toContain("create");
    expect(prompt.system).toContain("replace");
    expect(prompt.system).toContain("move");
    expect(prompt.system).toContain("delete");
    expect(prompt.instruction).toContain('{"operations":[]}');
    expect(prompt.system).not.toContain("send_message");
    expectVerbatimBlocks(prompt.instruction, Object.values(input));
  });

  it("keeps compaction derived and unable to change facts or outward-message status", () => {
    const input = {
      sessionHistory: "assistant(private): {thought}\ntool(call): proposed only",
      causalFacts: "message delivery=unknown",
      validationError: "no previous validation error {raw}",
    };
    const prompt = buildCompactionPrompt(locale, input);

    expect(prompt.system).toContain('{"summary":"..."}');
    expect(prompt.system).toMatch(
      locale === "en" ? /Do not introduce, remove, or change facts/u : /不要引入、删除或改变事实/u,
    );
    expect(prompt.system).toMatch(locale === "en" ? /outward message/u : /对外消息/u);
    expect(prompt.system).toMatch(locale === "en" ? /unknown Tool causality/u : /未知 Tool 因果/u);
    expectVerbatimBlocks(prompt.instruction, Object.values(input));
  });
});

describe("localized built-in Tool text", () => {
  it("covers every stable built-in Tool identifier in both Prompt locales", () => {
    expect(BUILTIN_TOOL_NAMES).toEqual([
      "continue_experience",
      "send_message",
      "list_files",
      "read_file",
      "write_file",
    ]);

    for (const tool of BUILTIN_TOOL_NAMES) {
      const english = builtinToolText("en", tool);
      const chinese = builtinToolText("zh-CN", tool);
      expect(english.label.length).toBeGreaterThan(0);
      expect(english.description.length).toBeGreaterThan(0);
      expect(chinese.label.length).toBeGreaterThan(0);
      expect(chinese.description.length).toBeGreaterThan(0);
      expect(english.label).not.toBe(chinese.label);
      expect(templatePlaceholders(english.result)).toEqual(["result"]);
      expect(templatePlaceholders(chinese.result)).toEqual(["result"]);
    }
  });

  it("preserves authoritative Tool results verbatim in either Prompt locale", () => {
    const rawResult = "未知\r\n{result_from_service}\n<binary-ish>\u0000</binary-ish>";
    for (const locale of SUPPORTED_PROMPT_LOCALES) {
      for (const tool of BUILTIN_TOOL_NAMES) {
        const rendered = renderBuiltinToolResult(locale, tool, rawResult);
        expect(rendered.endsWith(rawResult)).toBe(true);
        expect(rendered.slice(-rawResult.length)).toBe(rawResult);
      }
    }
  });
});

describe("Owner-visible runtime text", () => {
  it("covers lifecycle, errors, recovery, and diagnostics without changing raw facts", () => {
    const raw = "tool=send_message; result={unknown}\n原因：连接中断";

    for (const locale of SUPPORTED_UI_LOCALES) {
      expect(ownerText(locale, "lifecycle.stopping", { reason: raw })).toContain(raw);
      expect(ownerText(locale, "error.toolFailed", { tool: "send_message", reason: raw })).toContain(raw);
      expect(ownerText(locale, "recovery.unknownEffectHeld", { tool: raw })).toContain(raw);
      expect(ownerText(locale, "diagnostic.currentWork", { work: raw })).toContain(raw);
    }
  });

  it("applies strict interpolation to Owner text too", () => {
    expect(() => ownerText("en", "diagnostic.state")).toThrow(/missing variables: state/u);
    expect(() => ownerText("en", "lifecycle.running", { state: "extra" })).toThrow(
      /unexpected variables: state/u,
    );
  });
});

function personaInput(): {
  personaDocuments: string;
  memoryDocuments: string;
  stimulus: string;
  causalFacts: string;
} {
  return {
    personaDocuments: "# Persona原文\n名字是 {literal_name}\r\n保持 <tag> 不变",
    memoryDocuments: "# Memory原文\n某事仍不确定：{unknown}",
    stimulus: "用户原文：不要改写 {quoted_text} 😀",
    causalFacts: "send_message proposed=true; dispatched=false; result={none}",
  };
}

function expectVerbatimBlocks(rendered: string, rawBlocks: readonly string[]): void {
  for (const raw of rawBlocks) {
    expect(rendered).toContain(raw);
    expect(rendered.split(raw)).toHaveLength(2);
  }
}
