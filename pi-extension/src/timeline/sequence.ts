import { TimelineEventSchema, type TimelineEvent } from "../protocol/v2/index.js";

export type TimelineProjection = Readonly<{
  branchPosition: number;
  event: TimelineEvent;
}>;

/** Sequence only persisted formal targets; marker and recovery pass order are not ordinal inputs. */
export function sequenceTimelineProjections(projections: readonly TimelineProjection[]): TimelineEvent[] {
  const ordered = [...projections].sort((left, right) => left.branchPosition - right.branchPosition);
  const positions = new Set<number>();
  const eventIds = new Set<string>();
  return ordered.map((projection, index) => {
    if (positions.has(projection.branchPosition) || eventIds.has(projection.event.event_id)) {
      throw new Error("timeline projection contains a duplicate formal target");
    }
    positions.add(projection.branchPosition);
    eventIds.add(projection.event.event_id);
    return TimelineEventSchema.parse({ ...projection.event, event_seq: index + 1 });
  });
}
