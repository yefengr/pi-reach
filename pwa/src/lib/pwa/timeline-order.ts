import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";

/** 本地保存的正式记录的显示顺序：有序号的按序号在前，无序号的排在其后；同序或都无序号时按时间与 ID。存储读取与只读历史投影共用。 */
export function compareSavedTimelineEvents(a: TimelineEvent, b: TimelineEvent): number {
  const leftSequence = a.event_seq;
  const rightSequence = b.event_seq;
  if (leftSequence !== undefined && rightSequence === undefined) return -1;
  if (leftSequence === undefined && rightSequence !== undefined) return 1;
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return a.timestamp - b.timestamp || a.event_id.localeCompare(b.event_id);
}
