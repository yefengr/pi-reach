import type { TimelineEvent, TimelinePartial } from "../pi-reach/protocol-v2/schema";

/** Extension 的 partial_id 由源事件 ID、内容类型和内容索引组成；未知格式不猜测归属。 */
export function partialMessageIdentity(partial: TimelinePartial): { messageId: string; contentIndex: number } | null {
  if (partial.kind === "tool") return null;
  const match = /^(.*):(assistant|thinking):(\d+)$/.exec(partial.partial_id);
  if (!match || match[2] !== partial.kind || !match[1]) return null;
  const contentIndex = Number(match[3]);
  return Number.isSafeInteger(contentIndex) ? { messageId: match[1], contentIndex } : null;
}

export function matchesFormalMessage(partial: TimelinePartial, event: TimelineEvent): boolean {
  if (partial.session_id !== event.session_id || partial.group_id !== event.group_id) return false;
  if (partial.kind === "tool") return event.kind === "tool" && partial.tool_call_id === event.tool_call_id;
  return (event.kind === "assistant" || event.kind === "provider_error") && partialMessageIdentity(partial)?.messageId === event.event_id;
}
