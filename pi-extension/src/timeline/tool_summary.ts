import { isAbsolute, relative, sep } from "node:path";
import { boundedJsonByteLength, MAX_TOOL_SUMMARY_BYTES, type ToolSummary } from "@pi-reach/protocol/session";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";

/**
 * 摘要只用于展示：会话工作目录内的绝对路径改为相对路径，避免同一前缀在每一行重复；
 * 工作目录外与原本就是相对的路径保持原样，完整参数仍由按需详情提供。
 */
export function summaryPath(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  if (inside === "") return ".";
  return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? path : inside;
}

/** 只读取已知摘要字段；绝不遍历参数正文或未知工具的参数树。 */
export function toolSummary(tool: string, args: unknown, cwd?: string): ToolSummary {
  const action = tool === "read" ? "read" : tool === "write" ? "write" : tool === "edit" ? "edit"
    : tool === "bash" ? "execute" : tool === "grep" || tool === "find" ? "search" : "other";
  const summary: ToolSummary = { action };
  if (tool === PUBLISHED_FILE_TOOL_NAME || action === "other" || !args || typeof args !== "object") return summary;
  const record = args as Record<string, unknown>;
  const text = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    let end = Math.min(512, value.length);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF) end -= 1;
    return value.slice(0, end);
  };
  const field = action === "execute" ? "command" : "path";
  const raw = record[field];
  const value = text(field === "path" && typeof raw === "string" ? summaryPath(raw, cwd) : raw);
  if (value !== undefined) summary[field] = value;
  const query = action === "search" ? text(record.pattern ?? record.query) : undefined;
  if (query !== undefined) summary.query = query;
  for (const field of ["offset", "limit"] as const) {
    const value = record[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) summary[field] = value;
  }
  for (const key of ["query", "path", "command"] as const) {
    while (summary[key] && boundedJsonByteLength(summary, MAX_TOOL_SUMMARY_BYTES) === null) summary[key] = summary[key]!.slice(0, Math.floor(summary[key]!.length / 2));
  }
  return summary;
}
