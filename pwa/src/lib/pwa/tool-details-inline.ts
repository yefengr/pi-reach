import type { TimelineEvent, TimelinePartial } from "@pi-reach/protocol/session";
import { matchesFormalMessage as legacyMatchesFormalMessage } from "./timeline-identity";

type Tool = Extract<TimelineEvent | TimelinePartial, { kind: "tool" }>;
export function isToolSummary(value: unknown): value is Extract<Tool, { representation: "summary" }> {
  return typeof value === "object" && value !== null && "representation" in value && value.representation === "summary";
}
function* inlineChildren(value: object): Generator<unknown> {
  if (Array.isArray(value)) { yield* value; return; }
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield (value as Record<string, unknown>)[key];
  }
}
/** 逐项扫描旧 JSON，只保留当前祖先；不能把节点多误判为缺失并擦除原件。 */
export function hasCompleteToolInline(event: TimelineEvent): boolean {
  if (event.kind !== "tool" || isToolSummary(event) || event.truncated) return false;
  const frames: Array<{ iterator: Iterator<unknown>; value?: object }> = [
    { iterator: [event.args, "result" in event ? event.result : undefined].values() },
  ];
  const ancestors = new Set<object>();
  while (frames.length) {
    const frame = frames[frames.length - 1];
    const next = frame.iterator.next();
    if (next.done) {
      frames.pop();
      if (frame.value) ancestors.delete(frame.value);
      continue;
    }
    const item = next.value;
    if (!item || typeof item !== "object") continue;
    if (("omitted" in item && item.omitted === true) || ancestors.has(item)) return false;
    ancestors.add(item);
    frames.push({ iterator: inlineChildren(item), value: item });
  }
  return true;
}
export function preserveToolInline(previous: TimelineEvent | undefined, next: TimelineEvent): TimelineEvent {
  if (!previous || previous.kind !== "tool" || next.kind !== "tool" || !isToolSummary(next) || !hasCompleteToolInline(previous)
    || previous.event_id !== next.event_id || previous.session_id !== next.session_id || previous.group_id !== next.group_id
    || previous.tool_call_id !== next.tool_call_id || previous.tool !== next.tool || previous.status !== next.status) return next;
  return { ...previous, leaf_id: next.leaf_id, event_seq: next.event_seq };
}
export function matchesToolFormalMessage(partial: TimelinePartial, event: TimelineEvent): boolean {
  if (isToolSummary(partial) && isToolSummary(event)
    && partial.tool_ref.call_entry_id !== event.tool_ref.call_entry_id) return false;
  return legacyMatchesFormalMessage(partial, event);
}
