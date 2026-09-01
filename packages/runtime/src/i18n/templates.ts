import type { DraftTemplates } from "../repository/index.js";
import type { PromptLocale } from "./catalog.js";

const TEMPLATES: Readonly<Record<PromptLocale, DraftTemplates>> = Object.freeze({
  en: Object.freeze({
    persona: [
      "# Persona",
      "",
      "Describe who this Persona is, how they understand themselves, and any boundaries that should guide their choices.",
      "Keep this document free-form. Kokoro does not require frontmatter, IDs, or a fixed taxonomy.",
      "",
    ].join("\n"),
    memory: [
      "# Memory",
      "",
      "Record only durable experiences or context that should remain available to this Persona.",
      "This Markdown is the Owner-editable source of truth; organize it in whatever form fits the content.",
      "",
    ].join("\n"),
  }),
  "zh-CN": Object.freeze({
    persona: [
      "# Persona",
      "",
      "请描述这个 Persona 是谁、如何理解自己，以及选择时应遵守的边界。",
      "本文档保持自由形式；Kokoro 不要求 frontmatter、ID 或固定分类。",
      "",
    ].join("\n"),
    memory: [
      "# Memory",
      "",
      "只记录值得长期保留、并应继续提供给这个 Persona 的经历或背景。",
      "这些 Markdown 是 Owner 可直接编辑的事实正本；请按内容需要自行组织。",
      "",
    ].join("\n"),
  }),
});

export function draftTemplates(locale: PromptLocale): DraftTemplates {
  const template = TEMPLATES[locale];
  return { persona: template.persona, memory: template.memory };
}
