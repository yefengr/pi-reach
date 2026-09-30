import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";

export type RunCompletion = Readonly<{
  /** 一轮结束的时间，仅来自 run_end。 */
  timestamp: number;
  /** run_end 明确报告的结束状态。 */
  status: "complete" | "interrupted" | "error";
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

/** 只以 run_end 判断一轮结束；没有其他正式事件的孤立结束标记不生成 completion。 */
export function runCompletions(events: readonly TimelineEvent[]): ReadonlyMap<string, RunCompletion> {
  const groups = new Set<string>();
  const ended = new Map<string, RunCompletion>();
  for (const event of inTimelineOrder(events)) {
    if (!grouped(event)) continue;
    if (event.kind === "run_end") {
      ended.set(event.group_id, { timestamp: event.timestamp, status: event.status });
      continue;
    }
    groups.add(event.group_id);
  }
  const completions = new Map<string, RunCompletion>();
  for (const groupId of groups) {
    const explicit = ended.get(groupId);
    if (explicit) completions.set(groupId, explicit);
  }
  return completions;
}
