import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";

/** 保留可见正式投影；新分支完整同步并持久化前不得替换它。 */
export type TimelineReplacementBranch = { previousEvents: readonly TimelineEvent[] };

export function createTimelineReplacement(events: Iterable<TimelineEvent>): TimelineReplacementBranch {
  return { previousEvents: [...events] };
}
