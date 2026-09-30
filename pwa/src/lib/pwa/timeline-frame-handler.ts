import type { ServerFrame } from "../pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "../pi-reach/protocol-v2/schema";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import { TimelineEventFragmentAssembler } from "./timeline-transfer";
import { mergeTimelineEvents, TimelineStoreConflictError } from "./timeline-store";
import { currentTimelinePersistenceEpoch, enqueueTimelinePersistence } from "./timeline-persistence";
import { safeProtocolFeedbackMessage, type FeedbackSource } from "./feedback-messages";

export function sameTimelineScope(current: TimelineScope | null, expected: TimelineScope): boolean {
  return current !== null
    && current.deviceId === expected.deviceId
    && current.endpointId === expected.endpointId
    && current.sessionId === expected.sessionId;
}

function persistFormalEvent(
  runtime: TimelineRuntime,
  scope: TimelineScope,
  event: TimelineEvent,
  state: Pick<TimelineFrameState, "isCurrent" | "setError" | "setLastSyncedAt" | "onHistoryChanged">,
): void {
  const epoch = currentTimelinePersistenceEpoch(runtime);
  const write = enqueueTimelinePersistence(runtime, epoch, () => mergeTimelineEvents(scope, [event]));
  void write
    .then((persisted) => {
      if (persisted && state.isCurrent?.()) {
        state.setLastSyncedAt(Date.now());
        state.onHistoryChanged?.();
      }
    })
    .catch((writeError) => {
      if (state.isCurrent?.()) {
        state.setError(writeError instanceof TimelineStoreConflictError ? "Local timeline changed unexpectedly." : "Could not update local history.", "local-history");
      }
    });
}

type TimelineFrameState = {
  runtime: TimelineRuntime;
  fragmentAssemblerRef: { current: TimelineEventFragmentAssembler | null };
  applyTimelineChange: (change: ReturnType<TimelineRuntime["receive"]>, reset?: boolean) => void;
  receiveRealtimeOutput: (groupId: string) => void;
  setError: (message: string, source: FeedbackSource) => void;
  setLastSyncedAt: (timestamp: number) => void;
  onHistoryChanged?: () => void;
  isCurrent?: () => boolean;
};

/** scope 门禁必须先于缓存、分片组装和未读计数等副作用。 */
export function receiveTimelineFrame(frame: ServerFrame, state: TimelineFrameState): void {
  const { runtime, fragmentAssemblerRef, applyTimelineChange, receiveRealtimeOutput, setError, setLastSyncedAt, onHistoryChanged, isCurrent = () => true } = state;
  if (!runtime.acceptsTimelineFrame(frame)) return;
  const commit = (event: TimelineEvent) => {
    if (event.event_seq === undefined) { setError("The Pi extension must be updated to load numbered events.", "protocol"); return; }
    const change = runtime.commit(event);
    const committed = change.committed[0];
    if (!committed) return;
    const scope = runtime.currentScope;
    if (!scope || scope.sessionId !== committed.session_id) return;
    if (change.newLiveEvent && (committed.kind === "assistant" || committed.kind === "tool" || committed.kind === "provider_error")) receiveRealtimeOutput(committed.group_id);
    applyTimelineChange(change);
    if (runtime.replacing) return;
    persistFormalEvent(runtime, scope, committed, { isCurrent, setError, setLastSyncedAt, onHistoryChanged });
  };
  if (frame.type === "timeline_event_fragment") {
    const scope = runtime.currentScope;
    if (!scope || scope.sessionId !== frame.session_id) return;
    const fragmentScope = { session_id: frame.session_id, leaf_id: frame.leaf_id };
    if (!fragmentAssemblerRef.current?.matchesScope(fragmentScope)) {
      fragmentAssemblerRef.current?.reset();
      fragmentAssemblerRef.current = new TimelineEventFragmentAssembler(fragmentScope);
    }
    const result = fragmentAssemblerRef.current.accept(frame);
    if (result.status === "complete") commit(result.event);
    return;
  }
  if (frame.type === "timeline_event") { commit(frame.event); return; }
  if (frame.type === "session_history_chunk") return;
  if (frame.type === "protocol_error") setError(safeProtocolFeedbackMessage(frame.code), "protocol");
  if (frame.type === "timeline_partial") receiveRealtimeOutput(frame.group_id);
  applyTimelineChange(runtime.receive(frame));
}
