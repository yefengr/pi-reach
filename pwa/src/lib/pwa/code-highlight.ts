import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, rust, css, xml, markdown, yaml })) hljs.registerLanguage(name, language);

const MAX_HIGHLIGHT_CHARACTERS = 32_000;
const MAX_HIGHLIGHT_LINES = 2_000;
/** 代码围栏语言别名，只高亮已注册的语言。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  py: "python", rs: "rust", html: "xml", svg: "xml", md: "markdown", yml: "yaml",
};

export function languageForFence(fence: string | undefined): string | undefined {
  const name = fence?.trim().toLowerCase();
  if (!name) return undefined;
  const language = LANGUAGE_ALIASES[name] ?? name;
  return hljs.getLanguage(language) ? language : undefined;
}

/**
 * 返回 highlight.js 对已转义文本生成的标记；超过上限或无法识别时返回 undefined，调用方按纯文本显示。
 * 只接受 highlight() 的输出作为 HTML，原文不得直接注入。
 */
export function highlightCode(text: string, language: string | undefined): string | undefined {
  if (!language || text.length > MAX_HIGHLIGHT_CHARACTERS || text.split("\n", MAX_HIGHLIGHT_LINES + 1).length > MAX_HIGHLIGHT_LINES) return undefined;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}
