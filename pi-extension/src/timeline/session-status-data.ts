import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SESSION_STATUS_BRANCH_CHARS, SESSION_STATUS_KEY_CHARS, SESSION_STATUS_LABEL_CHARS,
  SESSION_STATUS_TEXT_CHARS, SESSION_STATUS_MAX_EXTENSIONS,
  type SessionStatus, type SessionStatusExtension,
} from "@pi-reach/protocol/session";

export type StatusContext = Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "cwd">;
export type StatusSnapshot = { sessionId: string; leafId: string | null; status: SessionStatus };

export function readStatusBranch(cwd: string): string | null {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000 }).trim();
    return branch ? (branch === "HEAD" ? "detached" : branch.slice(0, SESSION_STATUS_BRANCH_CHARS)) : null;
  } catch { return null; }
}

export function readSessionStatus(ctx: StatusContext, settings: ReturnType<ExtensionAPI["getSettings"]>,
  extensions: SessionStatusExtension[], branch = readStatusBranch(ctx.cwd)): StatusSnapshot {
  const usage: SessionStatus["usage"] = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0,
    cache_hit_rate_session: null, cache_hit_rate_latest: null };
  let latest: number | null = null;
  for (const entry of ctx.sessionManager.getEntries()) {
    const value = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage
      : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? entry.message.usage : undefined;
    if (!value) continue;
    usage.input += value.input;
    usage.output += value.output;
    usage.cache_read += value.cacheRead;
    usage.cache_write += value.cacheWrite;
    usage.cost += value.cost.total;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const prompt = value.input + value.cacheRead + value.cacheWrite;
      latest = prompt > 0 ? value.cacheRead / prompt * 100 : null;
    }
  }
  if (usage.cache_read > 0 || usage.cache_write > 0) {
    const prompt = usage.input + usage.cache_read + usage.cache_write;
    usage.cache_hit_rate_session = prompt > 0 ? usage.cache_read / prompt * 100 : null;
    usage.cache_hit_rate_latest = latest;
  }
  const context = ctx.getContextUsage();
  const ratio = context?.tokens === null || !context ? null : context.tokens / context.contextWindow * 100;
  return { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? null,
    status: { context: context && context.contextWindow > 0 ? { tokens: context.tokens, window: context.contextWindow,
      auto_compact: settings.compaction?.enabled ?? true,
      level: ratio === null ? null : ratio > 90 ? "full" : ratio > 70 ? "high" : "normal" } : null,
    usage, branch, extensions } };
}

function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\r\n\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/\s+/g, " ").trim();
}
const reserved: Record<string, readonly string[]> = {
  context: ["上下文", "窗口", "自动压缩", "context", "window", "auto compact", "auto compaction"],
  usage: ["输入", "输出", "缓存读取", "缓存写入", "缓存命中率", "最近缓存命中率", "费用", "input", "output", "cache read", "cache write", "cache hit rate", "latest cache hit rate", "cost"],
  session: ["分支", "会话名", "电脑名", "工作目录", "branch", "session", "computer", "working directory"],
};

export class SessionStatusExtensions {
  private readonly entries = new Map<string, SessionStatusExtension>();
  clear(): void { this.entries.clear(); }
  snapshot(): SessionStatusExtension[] {
    return [...this.entries.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, SESSION_STATUS_MAX_EXTENSIONS);
  }
  update(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const item = payload as Record<string, unknown>;
    if (item.version !== 1 || typeof item.key !== "string" || !item.key.length || item.key.length > SESSION_STATUS_KEY_CHARS
      || typeof item.label !== "string" || (item.text !== undefined && typeof item.text !== "string")) return false;
    const label = clean(item.label).slice(0, SESSION_STATUS_LABEL_CHARS);
    if (!label) return false;
    const text = typeof item.text === "string" ? clean(item.text).slice(0, SESSION_STATUS_TEXT_CHARS) : "";
    if (!text) return this.entries.delete(item.key);
    const section = item.section === "context" || item.section === "usage" || item.section === "session" ? item.section : undefined;
    if (section && reserved[section]!.includes(label.toLowerCase())) return this.entries.delete(item.key);
    const next: SessionStatusExtension = { key: item.key, label, text,
      ...(item.tone === "warning" || item.tone === "error" ? { tone: item.tone } : {}), ...(section ? { section } : {}) };
    if (JSON.stringify(this.entries.get(item.key)) === JSON.stringify(next)) return false;
    this.entries.set(item.key, next);
    return true;
  }
}
