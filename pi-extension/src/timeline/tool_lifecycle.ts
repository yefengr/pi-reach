import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolRef, ToolSummary } from "@pi-reach/protocol/session";
import { MarkerSchemaV2, type JsonValue, type TimelineEvent, type TimelinePartial } from "../protocol/v2/index.js";
import { toolSummary } from "./tool_summary.js";

export type ToolCallDetails = Readonly<{ tool: string; summary: ToolSummary; toolRef: ToolRef }>;
type ToolContext<T> = Readonly<{ groupId: string; correlation: T; callEntryId: string }>;
export type ToolAssociation<T> = ToolContext<T> & ToolCallDetails;
type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];

/** 非工具系统事件沿用原有 JSON 投影；工具路径不调用此函数。 */
export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, { value: jsonValue(item), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  return null;
}

export function nativeToolCalls(content: unknown): Array<{ id: string; tool: string; args: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (call.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) return [];
    return [{ id: call.id, tool: call.name, args: call.arguments }];
  });
}

/** 与 runtime marker 扫描一致：透明 custom 可跨过，其他 entry 是硬边界。 */
export function assistantCallEntries(branch: readonly SessionEntry[]): Map<string, string> {
  const ids = new Map<string, string>();
  let markerId: string | undefined;
  for (const entry of branch) {
    if (entry.type === "custom") {
      if (entry.customType === "pi-reach:timeline-v2") {
        const marker = MarkerSchemaV2.safeParse(entry.data);
        markerId = marker.success && marker.data.kind === "assistant" ? entry.id : undefined;
      }
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") ids.set(entry.id, markerId ?? entry.id);
    markerId = undefined;
  }
  return ids;
}

/** 只复制小摘要与稳定引用，不保留完整参数或结果。 */
export function recoverToolCalls(branch: readonly SessionEntry[], cwd?: string): Map<string, ToolCallDetails> {
  const ids = assistantCallEntries(branch);
  const calls = new Map<string, ToolCallDetails>();
  const results = new Map<string, ToolCallDetails>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const call of nativeToolCalls(message.content)) calls.set(call.id, {
        tool: call.tool, summary: toolSummary(call.tool, call.args, cwd), toolRef: { call_entry_id: ids.get(entry.id)!, tool_call_id: call.id },
      });
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call) results.set(entry.id, call);
      calls.delete(message.toolCallId);
    }
  }
  return results;
}

export function toolTimelineEvent(
  base: Pick<TimelineEvent, "event_id" | "session_id" | "leaf_id" | "timestamp">,
  groupId: string,
  message: { toolCallId?: string; toolName?: string; args?: unknown; content?: unknown; isError?: boolean; errorMessage?: string },
  call?: ToolCallDetails,
): TimelineEvent {
  const tool = call?.tool ?? message.toolName ?? "unknown";
  const id = message.toolCallId ?? base.event_id;
  return { ...base, group_id: groupId, kind: "tool", tool_call_id: id, tool,
    representation: "summary", summary: call?.summary ?? toolSummary(tool, undefined),
    tool_ref: call?.toolRef ?? { call_entry_id: base.event_id, tool_call_id: id }, status: message.isError ? "error" : "complete" };
}

export function toolPartial<T>(
  toolCallId: string, association: ToolAssociation<T>, scope: { sessionId: string; leafId: string | null },
  result?: unknown, preparing = false,
): TimelinePartial {
  return { protocol_version: 2, type: "timeline_partial", session_id: scope.sessionId, leaf_id: scope.leafId,
    group_id: association.groupId, partial_id: `tool:${association.toolRef.call_entry_id}:${toolCallId}`,
    kind: "tool", tool_call_id: toolCallId, tool: association.tool, representation: "summary",
    summary: association.summary, tool_ref: association.toolRef,
    status: preparing ? "preparing" : result === undefined ? "running" : "delta" };
}

export class ToolLifecycleTracker<T> {
  private readonly associations = new Map<string, ToolAssociation<T>>();
  /** 当前会话的工作目录，用于把摘要路径显示为相对路径。 */
  constructor(private readonly cwd: () => string | undefined = () => undefined) {}
  clear(): void { this.associations.clear(); }
  get(toolCallId: string): ToolAssociation<T> | undefined { return this.associations.get(toolCallId); }
  find(ref: ToolRef): ToolAssociation<T> | undefined {
    const call = this.get(ref.tool_call_id);
    return call?.toolRef.call_entry_id === ref.call_entry_id ? call : undefined;
  }
  complete(toolCallId: string, ref?: ToolRef): void {
    if (!ref || this.find(ref)) this.associations.delete(toolCallId);
  }
  indexAssistantContent(content: unknown, context: ToolContext<T>): void {
    for (const call of nativeToolCalls(content)) this.associations.set(call.id, { ...context, tool: call.tool,
      summary: toolSummary(call.tool, call.args, this.cwd()), toolRef: { call_entry_id: context.callEntryId, tool_call_id: call.id } });
  }
  start(toolCallId: string, toolName: string, args: unknown, fallback?: ToolContext<T>): ToolAssociation<T> | null {
    const existing = this.associations.get(toolCallId);
    const context = existing ?? fallback;
    const tool = toolName || existing?.tool;
    if (!toolCallId || !context || !tool) return null;
    const association = { ...context, tool, summary: args === undefined && existing ? existing.summary : toolSummary(tool, args, this.cwd()),
      toolRef: { call_entry_id: context.callEntryId, tool_call_id: toolCallId } };
    this.associations.set(toolCallId, association);
    return association;
  }
}
