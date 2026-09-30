import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { MAX_FRAME_BYTES, MAX_TEXT_CHARS, TimelineEventSchema, TimelinePartialSchema, type JsonValue, type TimelineEvent, type TimelinePartial } from "../protocol/v2/index.js";

export type ToolCallDetails = Readonly<{ tool: string; args: JsonValue }>;
type ToolContext<T> = Readonly<{ groupId: string; correlation: T }>;
export type ToolAssociation<T> = ToolContext<T> & ToolCallDetails;
type SessionEntry = ReturnType<SessionManager["getBranch"]>[number];
const MAX_TOOL_PREVIEW_CHARS = 64 * 1024;
const TRUNCATED_PREVIEW = "\n[Live preview truncated; full output follows in the final result.]";

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

function truncateText(text: string): string {
  let end = MAX_TEXT_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return text.slice(0, end);
}

/** 协议单个字符串上限为 MAX_TEXT_CHARS：超限图片改为 omitted 占位，其他字符串截断。 */
function boundJson(value: JsonValue, state: { truncated: boolean }): JsonValue {
  if (typeof value === "string") {
    if (value.length <= MAX_TEXT_CHARS) return value;
    state.truncated = true;
    return truncateText(value);
  }
  if (Array.isArray(value)) return value.map((item) => boundJson(item, state));
  if (value === null || typeof value !== "object") return value;
  const { type, data, mimeType, mime_type: snakeMime } = value as Record<string, JsonValue | undefined>;
  if (type === "image" && typeof data === "string" && data.length > MAX_TEXT_CHARS) {
    state.truncated = true;
    const mime = typeof mimeType === "string" ? mimeType : typeof snakeMime === "string" ? snakeMime : "application/octet-stream";
    return { type: "image", mime_type: mime, omitted: true, byte_length: Math.floor(data.length * 3 / 4) };
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, { value: boundJson(item, state), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function toolCalls(content: unknown): Array<{ id: string } & ToolCallDetails> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (call.type !== "toolCall" || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) return [];
    return [{ id: call.id, tool: call.name, args: jsonValue(call.arguments ?? {}) }];
  });
}

/** 按 branch 顺序关联，不能让后续同名 ID 的调用改写先前结果的参数。 */
export function recoverToolCalls(branch: readonly SessionEntry[]): Map<string, ToolCallDetails> {
  const calls = new Map<string, ToolCallDetails>();
  const results = new Map<string, ToolCallDetails>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const call of toolCalls(message.content)) calls.set(call.id, call);
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
  const state = { truncated: false };
  const fields = {
    ...base, group_id: groupId, kind: "tool", tool_call_id: message.toolCallId ?? base.event_id,
    tool: call?.tool ?? message.toolName ?? "unknown", args: boundJson(call?.args ?? jsonValue(message.args ?? {}), state),
  };
  if (!message.isError) {
    const result = boundJson(jsonValue(message.content), state);
    return TimelineEventSchema.parse({ ...fields, truncated: state.truncated, status: "complete", result });
  }
  const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.flatMap((part) => part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []).join(" ") : "";
  const error = boundJson((message.errorMessage ?? text).trim() || "tool failed", state);
  return TimelineEventSchema.parse({ ...fields, truncated: state.truncated, status: "error", error });
}

function toolResultTextBlocks(result: unknown): Array<{ type: "text"; text: string }> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const blocks: Array<{ type: "text"; text: string }> = [];
  let remaining = MAX_TOOL_PREVIEW_CHARS;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (block.text.length <= remaining) {
      blocks.push({ type: "text", text: block.text });
      remaining -= block.text.length;
      continue;
    }
    let end = remaining;
    const last = block.text.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
    blocks.push({ type: "text", text: block.text.slice(0, Math.max(0, end)) + TRUNCATED_PREVIEW });
    break;
  }
  // 空快照也必须覆盖上一份输出；图片留给正式结果，避免把 Base64 当正文发出。
  return blocks;
}

export function toolPartial<T>(
  toolCallId: string,
  association: ToolAssociation<T>,
  scope: { sessionId: string; leafId: string | null },
  result?: unknown,
): TimelinePartial | null {
  const blocks = result === undefined ? undefined : toolResultTextBlocks(result);
  if (result !== undefined && blocks === undefined) return null;
  const candidate = {
    protocol_version: 2, type: "timeline_partial",
    session_id: scope.sessionId, leaf_id: scope.leafId,
    group_id: association.groupId, partial_id: `tool:${toolCallId}`,
    kind: "tool", tool_call_id: toolCallId, tool: association.tool, args: association.args,
    status: result === undefined ? "running" : "delta",
    ...(blocks === undefined ? {} : { blocks }),
  };
  const bounded = (value: unknown): TimelinePartial | null => {
    const parsed = TimelinePartialSchema.safeParse(value);
    return parsed.success && Buffer.byteLength(JSON.stringify(parsed.data), "utf8") <= MAX_FRAME_BYTES ? parsed.data : null;
  };
  // partial 没有分片机制；超限参数仍由正式事件及其分片提供。
  const { args: _args, ...withoutArgs } = candidate;
  return bounded(candidate) ?? bounded(withoutArgs);
}

export class ToolLifecycleTracker<T> {
  private readonly associations = new Map<string, ToolAssociation<T>>();

  clear(): void { this.associations.clear(); }
  get(toolCallId: string): ToolAssociation<T> | undefined { return this.associations.get(toolCallId); }
  complete(toolCallId: string): void { this.associations.delete(toolCallId); }

  indexAssistantContent(content: unknown, context: ToolContext<T>): void {
    for (const call of toolCalls(content)) this.associations.set(call.id, { ...context, tool: call.tool, args: call.args });
  }

  start(toolCallId: string, toolName: string, args: unknown, fallback?: ToolContext<T>): ToolAssociation<T> | null {
    const existing = this.associations.get(toolCallId);
    const context = existing ?? fallback;
    const tool = toolName || existing?.tool;
    if (!toolCallId || !context || !tool) return null;
    const association = {
      groupId: context.groupId, correlation: context.correlation, tool,
      args: args === undefined ? existing?.args ?? {} : jsonValue(args),
    };
    this.associations.set(toolCallId, association);
    return association;
  }
}
