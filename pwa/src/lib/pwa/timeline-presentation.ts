import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "./timeline-runtime";
import { partialMessageIdentity } from "./timeline-identity";

type Grouped = { session_id: string; leaf_id: string | null; group_id: string };
export type TimelineToolValue = Extract<TimelineEvent, { kind: "tool" }> | Extract<TimelinePartial, { kind: "tool" }>;
export type ToolEntry = { kind: "tool"; key: string; value: TimelineToolValue };
export type ThinkingEntry = { kind: "thinking"; key: string; groupId: string; text: string; streaming: boolean };
export type TextEntry = { kind: "text"; key: string; groupId: string; text: string; streaming: boolean; interrupted: boolean; timestamp?: number };
export type RecordEntry = { kind: "record"; key: string; item: TimelineViewItem };
export type PresentationEntry = ToolEntry | ThinkingEntry | TextEntry | RecordEntry;
export type PresentationSnapshot = { items: readonly TimelineViewItem[]; entries: PresentationEntry[] };

function timelineGroupKey(value: Grouped): string {
  return JSON.stringify([value.session_id, value.leaf_id, value.group_id]);
}

export function timelineToolKey(value: TimelineToolValue): string {
  return JSON.stringify([value.session_id, value.leaf_id, value.group_id, value.tool_call_id]);
}

function blockKey(groupKey: string, messageId: string, type: "text" | "thinking", index: number): string {
  return JSON.stringify([groupKey, messageId, type, index]);
}

// 普通提交会推进 leaf；空历史痕迹按会话与轮次定位，补齐更早消息也不改变 key。
function emptyThinkingKey(value: Grouped): string {
  return JSON.stringify(["thinking-trace", value.session_id, value.group_id]);
}

function assistantEntries(item: Exclude<TimelineViewItem, { kind: "pending" }>): PresentationEntry[] {
  const value = item.kind === "event" ? item.event : item.partial;
  if (value.kind !== "assistant" && value.kind !== "thinking") return [];
  const groupKey = timelineGroupKey(value);
  const streaming = item.kind === "partial";
  const identity = item.kind === "partial" ? partialMessageIdentity(item.partial) : null;
  const sourceId = "event_id" in value ? value.event_id : identity?.messageId ?? value.partial_id;
  const startIndex = identity?.contentIndex ?? 0;
  const blocks = value.blocks ?? [{ type: value.kind === "thinking" ? "thinking" as const : "text" as const, text: "delta" in value ? value.delta ?? "" : "" }];
  return blocks.flatMap((block, index): PresentationEntry[] => {
    if (block.type !== "thinking" && !block.text.trim()) return [];
    const key = !streaming && block.type === "thinking" && !block.text.trim()
      ? emptyThinkingKey(value) : blockKey(groupKey, sourceId, block.type, startIndex + index);
    if (block.type === "thinking") return [{ kind: "thinking", key, groupId: value.group_id, text: block.text, streaming }];
    return [{ kind: "text", key, groupId: value.group_id, text: block.text, streaming,
      interrupted: "event_id" in value && value.status === "interrupted",
      ...("timestamp" in value ? { timestamp: value.timestamp } : {}),
    }];
  });
}

function flatten(items: readonly TimelineViewItem[], emptyThinkingKeys = new Set<string>()): PresentationEntry[] {
  const entries = items.flatMap((item): PresentationEntry[] => {
    if (item.kind === "pending") return [{ kind: "record", key: `pending:${item.id}`, item }];
    const value = item.kind === "event" ? item.event : item.partial;
    if (value.kind === "tool") return [{ kind: "tool", key: timelineToolKey(value), value }];
    if (value.kind === "assistant" || value.kind === "thinking") return assistantEntries(item);
    return [{ kind: "record", key: item.kind === "event" ? item.event.event_id : item.partial.partial_id, item }];
  });
  return entries.filter(entry => {
    if (entry.kind !== "thinking" || entry.streaming || entry.text.trim()) return true;
    if (emptyThinkingKeys.has(entry.key)) return false;
    emptyThinkingKeys.add(entry.key);
    return true;
  });
}

/** 已出现的条目不因工具结果的完成时间改变位置；新历史和正文按其相邻已知条目插入。 */
function reconcileOrder(entries: PresentationEntry[], previous: readonly PresentationEntry[]): PresentationEntry[] {
  const current = new Map(entries.map(entry => [entry.key, entry]));
  const retained = previous.filter(entry => current.has(entry.key));
  const known = new Set(retained.map(entry => entry.key));
  if (known.size === 0) return entries;
  const additions = new Map<string | null, PresentationEntry[]>();
  const positions = new Map(retained.map((entry, index) => [entry.key, index]));
  let anchor: string | null = null;
  let furthestPosition = -1;
  for (const entry of entries) {
    const position = positions.get(entry.key);
    if (position !== undefined) {
      // 并行工具完成后源顺序可能不同；后续新消息须位于所有已观察前驱之后。
      if (position > furthestPosition) { anchor = entry.key; furthestPosition = position; }
      continue;
    }
    const bucket = additions.get(anchor) ?? [];
    bucket.push(entry);
    additions.set(anchor, bucket);
  }
  return [...(additions.get(null) ?? []), ...retained.flatMap(entry => [current.get(entry.key)!, ...(additions.get(entry.key) ?? [])])];
}

/** 条目所属的一轮（group_id）；待发送的用户消息不属于任何已知轮次。 */
export function entryGroupId(entry: PresentationEntry): string | undefined {
  if (entry.kind === "tool") return entry.value.group_id;
  if (entry.kind === "text" || entry.kind === "thinking") return entry.groupId;
  const item = entry.item;
  if (item.kind === "event") return item.event.group_id;
  if (item.kind === "partial") return item.partial.group_id;
  return undefined;
}

/** 是否为 Pi 的输出（正文、思考、工具或模型错误），用于判断一轮是否已有回复。 */
export function isPiOutputEntry(entry: PresentationEntry): boolean {
  if (entry.kind !== "record") return true;
  const item = entry.item;
  return item.kind === "partial" || (item.kind === "event" && item.event.kind !== "user");
}

/** 每个缺口之后第一条可见条目的 key；缺口处的事件本身可能不产生条目（如 run_end），标记顺延到下一条。 */
export function projectTimelineGaps(items: readonly TimelineViewItem[], gapBefore: ReadonlySet<string>): { keys: Set<string>; atEnd: boolean } {
  const keys = new Set<string>();
  const emptyThinkingKeys = new Set<string>();
  let pending = false;
  for (const item of items) {
    if (item.kind === "event" && gapBefore.has(item.event.event_id)) pending = true;
    // 缺口出现前也登记空痕迹；后续被合并掉的空块不能把缺口挂回旧位置。
    const first = flatten([item], emptyThinkingKeys)[0];
    if (!pending || !first) continue;
    keys.add(first.key);
    pending = false;
  }
  return { keys, atEnd: pending };
}

export function projectTimeline(items: readonly TimelineViewItem[], previous?: PresentationSnapshot): PresentationSnapshot {
  return { items, entries: reconcileOrder(flatten(items), previous?.entries ?? []) };
}
