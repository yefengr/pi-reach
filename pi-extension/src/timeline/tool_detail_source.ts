import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { boundedJsonByteLength, MAX_TOOL_DETAILS_BYTES, toolDetailsContentSchema, type ToolDetailsContent,
  type ToolRef } from "@pi-reach/protocol/session";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";
import { assistantCallEntries, nativeToolCalls } from "./tool_lifecycle.js";

export type DetailResult = { content: ToolDetailsContent } | { code: "not_found" | "unavailable" | "too_large"; terminal: boolean };

/** 只读当前真实原生分支；不查文件、不执行工具、不缓存最终结果。 */
export function sessionToolDetails(manager: SessionManager, ref: ToolRef): DetailResult {
  const branch = manager.getBranch();
  const ids = assistantCallEntries(branch);
  let found = false;
  let args: unknown;
  let tool = "";
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      const call = nativeToolCalls(message.content).find((item) => item.id === ref.tool_call_id);
      if (found && call) return { code: "unavailable", terminal: true };
      if (ids.get(entry.id) !== ref.call_entry_id || !call) continue;
      found = true;
      args = call.args;
      tool = call.tool;
    } else if (found && message.role === "toolResult" && message.toolCallId === ref.tool_call_id) {
      if (args === undefined || message.content === undefined) return { code: "unavailable", terminal: true };
      const content = { tool_ref: ref, tool, source: "session", status: message.isError ? "error" : "complete",
        args: tool === PUBLISHED_FILE_TOOL_NAME ? {} : args, result: message.content, limited: false };
      if (boundedJsonByteLength(content, MAX_TOOL_DETAILS_BYTES) === null) return { code: "too_large", terminal: true };
      const parsed = toolDetailsContentSchema.safeParse(content);
      return parsed.success ? { content: parsed.data } : { code: "unavailable", terminal: true };
    }
  }
  return { code: found ? "unavailable" : "not_found", terminal: false };
}
