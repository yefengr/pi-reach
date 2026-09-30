import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";

export type RunCompletion = Readonly<{
  /** 一轮结束的时间：优先取 run_end，缺少时取该轮最后一个事件。 */
  timestamp: number;
  /** 来自 run_end；按降级规则推断的结束没有状态。 */
  status?: "complete" | "interrupted" | "error";
}>;

type Grouped = TimelineEvent & { group_id: string };

function grouped(event: TimelineEvent): event is Grouped {
  return typeof event.group_id === "string";
}

function inTimelineOrder(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => (left.event.event_seq ?? 0) - (right.event.event_seq ?? 0) || left.index - right.index)
    .map(({ event }) => event);
}

/**
 * 按 group_id 判断每一轮是否已结束。
 * 有 run_end 时以它为准；旧 Extension 与旧历史没有 run_end 时：出现后续一轮即视为前一轮已结束，
 * 最后一轮只在 Pi 不处于运行状态（`running=false`，历史阅读恒为 false）时以最后一个事件的时间结束。
 */
export function runCompletions(events: readonly TimelineEvent[], running: boolean, laterGroupIds: readonly string[] = []): ReadonlyMap<string, RunCompletion> {
  const order: string[] = [];
  const lastTimestamp = new Map<string, number>();
  const ended = new Map<string, RunCompletion>();
  for (const event of inTimelineOrder(events)) {
    if (!grouped(event)) continue;
    if (event.kind === "run_end") {
      ended.set(event.group_id, { timestamp: event.timestamp, status: event.status });
      continue;
    }
    if (!lastTimestamp.has(event.group_id)) order.push(event.group_id);
    lastTimestamp.set(event.group_id, event.timestamp);
  }
  // 仍在流式输出、尚无正式事件的轮次（partial）也说明其之前的轮次已经结束。
  for (const groupId of laterGroupIds) {
    if (!lastTimestamp.has(groupId) && !order.includes(groupId)) order.push(groupId);
  }
  const completions = new Map<string, RunCompletion>();
  order.forEach((groupId, index) => {
    if (!lastTimestamp.has(groupId)) return;
    const explicit = ended.get(groupId);
    if (explicit) completions.set(groupId, explicit);
    else if (index < order.length - 1 || !running) completions.set(groupId, { timestamp: lastTimestamp.get(groupId)! });
  });
  return completions;
}
