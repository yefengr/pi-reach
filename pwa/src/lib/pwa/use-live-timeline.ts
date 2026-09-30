import { useCallback, useEffect, useRef, useState } from "react";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { TimelineEventFragmentAssembler } from "@/lib/pwa/timeline-transfer";
import { TimelineHistoryLoader } from "@/lib/pwa/timeline-history-loader";
import { TimelineRuntime, type TimelineScope, type TimelineRuntimeChange, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { StreamDisplayBuffer } from "@/lib/pwa/stream-display-buffer";
import { loadTimeline, mergeTimelineEvents, replaceTimelineEvents } from "@/lib/pwa/timeline-store";
import { beginTimelinePersistenceEpoch, enqueueTimelinePersistence } from "@/lib/pwa/timeline-persistence";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { ClientFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";

const STREAM_DISPLAY_TICK_MS = 16;
const RECONNECT_TRANSITION_MS = 160;

export type TimelineReconnectPhase = "fade-out" | "hidden" | "fade-in" | null;

type MutableRef<T> = { current: T };
type CatchupRange = { start: number; end: number };
type FailedCatchup = { generation: number; range?: CatchupRange };

type StartLiveOptions = {
  scope: TimelineScope;
  headSeq: number;
  send: (request: ClientFrame) => boolean;
  onHistoryChanged: () => void;
};

type UseLiveTimelineOptions = {
  channelRef: MutableRef<PeerChannel | null>;
  enabled: boolean;
  reportHistoryFailure: (message: string) => void;
};

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function sameFormalEvents(left: readonly TimelineEvent[], right: readonly TimelineEvent[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((event) => [event.event_id, event]));
  return left.every((event) => JSON.stringify(event) === JSON.stringify(rightById.get(event.event_id)));
}

/** Owns the live timeline display independently from the Relay endpoint registry. */
export function useLiveTimeline({ channelRef, enabled, reportHistoryFailure }: UseLiveTimelineOptions) {
  const [items, setItems] = useState<TimelineViewItem[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>();
  const [hasEarlierState, setHasEarlierState] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [reconnectPhase, setReconnectPhase] = useState<TimelineReconnectPhase>(null);
  const [catchupFailed, setCatchupFailed] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);

  const runtimeRef = useRef(new TimelineRuntime());
  const historyLoaderRef = useRef<TimelineHistoryLoader | null>(null);
  const fragmentAssemblerRef = useRef<TimelineEventFragmentAssembler | null>(null);
  const streamBufferRef = useRef(new StreamDisplayBuffer());
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef<TimelineViewItem[]>([]);
  const contextGenerationRef = useRef(0);
  const replacementGateRef = useRef(false);
  const deferredChangeRef = useRef<TimelineRuntimeChange | null>(null);
  const failedCatchupRef = useRef<FailedCatchup | null>(null);
  const onHistoryChangedRef = useRef<(() => void) | null>(null);
  const forceAuthoritativeReplacementRef = useRef(false);
  const replacementRequiresReplaceRef = useRef(false);
  const persistenceEpochRef = useRef(0);
  const catchingUpRef = useRef(false);
  const viewport = useTimelineViewport(items, enabled);
  const { receiveRealtimeOutput, prepareHistoryPrepend, reset: resetOutputFollowing } = viewport;

  const updateItems = useCallback((next: TimelineViewItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const scheduleStreamDisplay = useCallback(() => {
    if (streamTimerRef.current || !streamBufferRef.current.hasPending()) return;
    const tick = () => {
      streamTimerRef.current = setTimeout(() => {
        streamTimerRef.current = null;
        if (replacementGateRef.current) return;
        const change = streamBufferRef.current.advance();
        if (change.shouldRender) {
          updateItems(change.items);
          const groups = new Set(change.items.flatMap((item) => item.kind === "partial" ? [item.partial.group_id] : []));
          for (const groupId of groups) receiveRealtimeOutput(groupId);
        }
        if (change.hasPending) tick();
      }, STREAM_DISPLAY_TICK_MS);
    };
    tick();
  }, [receiveRealtimeOutput, updateItems]);

  const renderChange = useCallback((change: TimelineRuntimeChange, resetDisplay: boolean) => {
    if (resetDisplay && streamTimerRef.current) clearTimeout(streamTimerRef.current);
    if (resetDisplay) streamTimerRef.current = null;
    const displayChange = resetDisplay
      ? streamBufferRef.current.reset(change.items)
      : streamBufferRef.current.ingest(change.items);
    if (displayChange.shouldRender) updateItems(displayChange.items);
    if (displayChange.hasPending) scheduleStreamDisplay();
  }, [scheduleStreamDisplay, updateItems]);

  const applyTimelineChange = useCallback((change: TimelineRuntimeChange, resetDisplay = false) => {
    if (change.pendingCapacityExceeded) reportHistoryFailure("Too many queued messages or attachments. Existing messages were kept. Reconnect after the queue gets smaller.");
    for (const frame of change.observed) channelRef.current?.send(frame);
    const displayChange = change.observed.length === 0 ? change : { ...change, observed: [] };
    if (replacementGateRef.current) {
      deferredChangeRef.current = displayChange;
      return;
    }
    renderChange(displayChange, resetDisplay);
  }, [channelRef, renderChange, reportHistoryFailure]);

  const clearTransitionTimer = useCallback(() => {
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = null;
  }, []);

  const disposeLoader = useCallback(() => {
    historyLoaderRef.current?.dispose();
    historyLoaderRef.current = null;
    setLoadingEarlier(false);
  }, []);

  const finishReplacement = useCallback(async (generation: number): Promise<boolean> => {
    if (generation !== contextGenerationRef.current || !runtimeRef.current.replacing) return false;
    while (generation === contextGenerationRef.current && runtimeRef.current.replacing) {
      const scope = runtimeRef.current.currentScope;
      if (!scope) return false;
      const stagedEvents = runtimeRef.current.formalEvents();
      const epoch = persistenceEpochRef.current;
      try {
        const persisted = await enqueueTimelinePersistence(runtimeRef.current, epoch, () => replacementRequiresReplaceRef.current
          ? replaceTimelineEvents(scope, stagedEvents)
          : mergeTimelineEvents(scope, stagedEvents));
        if (!persisted) return false;
      } catch {
        if (generation === contextGenerationRef.current) reportHistoryFailure("Could not update local history.");
        return false;
      }
      if (generation !== contextGenerationRef.current || !runtimeRef.current.replacing) return false;
      if (!sameFormalEvents(stagedEvents, runtimeRef.current.formalEvents())) continue;

      replacementGateRef.current = false;
      const change = runtimeRef.current.commitReplacement();
      for (const frame of change.observed) channelRef.current?.send(frame);
      deferredChangeRef.current = null;
      resetOutputFollowing();
      renderChange(change, true);
      setLastSyncedAt(Date.now());
      onHistoryChangedRef.current?.();
      if (reducedMotion()) {
        setReconnectPhase(null);
        return true;
      }
      transitionTimerRef.current = setTimeout(() => {
        if (generation !== contextGenerationRef.current) return;
        setReconnectPhase("fade-in");
        transitionTimerRef.current = setTimeout(() => {
          if (generation === contextGenerationRef.current) setReconnectPhase(null);
          transitionTimerRef.current = null;
        }, RECONNECT_TRANSITION_MS);
      }, 0);
      return true;
    }
    return false;
  }, [channelRef, renderChange, reportHistoryFailure, resetOutputFollowing]);

  const startLive = useCallback(({ scope, headSeq, send, onHistoryChanged }: StartLiveOptions) => {
    const generation = ++contextGenerationRef.current;
    clearTransitionTimer();
    disposeLoader();
    replacementGateRef.current = false;
    deferredChangeRef.current = null;
    failedCatchupRef.current = null;
    onHistoryChangedRef.current = onHistoryChanged;
    catchingUpRef.current = false;
    setCatchupFailed(false);
    setCatchingUp(false);
    setReconnectPhase(null);

    const hadExistingProjection = runtimeRef.current.currentScope !== null || runtimeRef.current.formalEvents().length > 0;
    const forceAuthoritativeReplacement = forceAuthoritativeReplacementRef.current;
    forceAuthoritativeReplacementRef.current = false;
    replacementRequiresReplaceRef.current = forceAuthoritativeReplacement || hadExistingProjection;
    persistenceEpochRef.current = beginTimelinePersistenceEpoch(runtimeRef.current);
    const prepared = runtimeRef.current.prepareLive(scope, headSeq);
    fragmentAssemblerRef.current = new TimelineEventFragmentAssembler({ session_id: scope.sessionId, leaf_id: scope.leafId });

    const loader = new TimelineHistoryLoader({
      scope,
      headSeq,
      ...(prepared.plan.earliestSeq === null ? {} : { boundary: prepared.plan.earliestSeq }),
      send,
      // Branch replacement must persist one complete staged projection before exposing it.
      load: prepared.plan.mode === "replace" && replacementRequiresReplaceRef.current ? async () => [] : loadTimeline,
      persist: async (target, events) => {
        if (generation !== contextGenerationRef.current || runtimeRef.current.replacing) return;
        const persisted = await enqueueTimelinePersistence(runtimeRef.current, persistenceEpochRef.current, () => mergeTimelineEvents(target, events));
        if (!persisted) return;
      },
      onPage: (events) => {
        if (generation !== contextGenerationRef.current) return;
        const change = runtimeRef.current.prependHistory(events);
        const replacing = runtimeRef.current.replacing;
        applyTimelineChange(change);
        if (replacing) return;
        setLastSyncedAt(Date.now());
        onHistoryChanged();
      },
      onState: (state) => {
        if (generation !== contextGenerationRef.current) return;
        setHasEarlierState(state.hasEarlier);
        setLoadingEarlier(state.loading);
      },
      onError: (message) => {
        if (generation === contextGenerationRef.current) reportHistoryFailure(message);
      },
    });
    historyLoaderRef.current = loader;

    const range = prepared.plan.startSeq === null
      ? null
      : { start: prepared.plan.startSeq, end: prepared.plan.endSeq };
    const hasCatchupWork = range !== null || prepared.plan.mode === "replace";
    catchingUpRef.current = hasCatchupWork;
    setCatchingUp(hasCatchupWork);

    const loadPreparedRange = async () => {
      const succeeded = range === null || await loader.loadRange(range.start, range.end);
      if (generation !== contextGenerationRef.current) return;
      if (!succeeded) {
        catchingUpRef.current = false;
        setCatchingUp(false);
        if (range) {
          failedCatchupRef.current = { generation, range };
          setCatchupFailed(true);
        }
        return;
      }
      if (prepared.plan.mode === "replace") {
        const committed = await finishReplacement(generation);
        if (generation !== contextGenerationRef.current) return;
        catchingUpRef.current = false;
        setCatchingUp(false);
        if (!committed) {
          failedCatchupRef.current = { generation };
          setCatchupFailed(true);
        }
        return;
      }
      catchingUpRef.current = false;
      setCatchingUp(false);
    };

    if (prepared.plan.mode === "append") {
      applyTimelineChange(prepared.change);
      void loadPreparedRange();
      return prepared.plan;
    }

    replacementGateRef.current = true;
    deferredChangeRef.current = null;
    renderChange(prepared.change, true);
    if (streamTimerRef.current) clearTimeout(streamTimerRef.current);
    streamTimerRef.current = null;

    // 暂存期间保持旧投影可见；失败时保留暂存门禁，重试成功后再提交。
    void loadPreparedRange();
    return prepared.plan;
  }, [applyTimelineChange, clearTransitionTimer, disposeLoader, finishReplacement, renderChange, reportHistoryFailure]);

  const retryCatchup = useCallback(async (): Promise<boolean> => {
    const failed = failedCatchupRef.current;
    const loader = historyLoaderRef.current;
    if (catchingUpRef.current || !failed || !loader || failed.generation !== contextGenerationRef.current) return false;
    catchingUpRef.current = true;
    setCatchingUp(true);

    let succeeded = failed.range
      ? await loader.loadRange(failed.range.start, failed.range.end)
      : true;
    if (failed.generation !== contextGenerationRef.current) return false;
    if (succeeded && replacementGateRef.current) succeeded = await finishReplacement(failed.generation);
    if (failed.generation !== contextGenerationRef.current) return false;

    catchingUpRef.current = false;
    setCatchingUp(false);
    if (succeeded) {
      failedCatchupRef.current = null;
      setCatchupFailed(false);
    } else {
      failedCatchupRef.current = failed;
      setCatchupFailed(true);
    }
    return succeeded;
  }, [finishReplacement]);

  const loadEarlier = useCallback(() => {
    const loader = historyLoaderRef.current;
    if (!loader || loadingEarlier || catchingUpRef.current) return;
    if (failedCatchupRef.current) {
      void retryCatchup();
      return;
    }
    if (!loader.hasEarlier) return;
    prepareHistoryPrepend();
    void loader.loadEarlier();
  }, [loadingEarlier, prepareHistoryPrepend, retryCatchup]);

  const disconnect = useCallback(() => {
    contextGenerationRef.current += 1;
    persistenceEpochRef.current = beginTimelinePersistenceEpoch(runtimeRef.current);
    clearTransitionTimer();
    disposeLoader();
    replacementGateRef.current = false;
    deferredChangeRef.current = null;
    failedCatchupRef.current = null;
    catchingUpRef.current = false;
    setCatchupFailed(false);
    setCatchingUp(false);
    setReconnectPhase(null);
    fragmentAssemblerRef.current?.reset();
    fragmentAssemblerRef.current = null;
    applyTimelineChange(runtimeRef.current.markDisconnected(), true);
  }, [applyTimelineChange, clearTransitionTimer, disposeLoader]);

  const invalidateScope = useCallback(() => {
    forceAuthoritativeReplacementRef.current = true;
    disconnect();
    setHasEarlierState(false);
    resetOutputFollowing();
    applyTimelineChange(runtimeRef.current.invalidateScope(true), true);
  }, [applyTimelineChange, disconnect, resetOutputFollowing]);

  const clearTimeline = useCallback(() => {
    disconnect();
    setHasEarlierState(false);
    setLastSyncedAt(undefined);
    resetOutputFollowing();
    applyTimelineChange(runtimeRef.current.clear(), true);
  }, [applyTimelineChange, disconnect, resetOutputFollowing]);

  useEffect(() => () => {
    contextGenerationRef.current += 1;
    clearTransitionTimer();
    if (streamTimerRef.current) clearTimeout(streamTimerRef.current);
    historyLoaderRef.current?.dispose();
  }, [clearTransitionTimer]);

  return {
    items,
    lastSyncedAt,
    setLastSyncedAt,
    hasEarlier: hasEarlierState || catchupFailed || catchingUp,
    loadingEarlier: loadingEarlier || catchingUp,
    reconnectPhase,
    catchupFailed,
    catchingUp,
    runtimeRef,
    historyLoaderRef,
    fragmentAssemblerRef,
    applyTimelineChange,
    startLive,
    retryCatchup,
    loadEarlier,
    disconnect,
    invalidateScope,
    clearTimeline,
    ...viewport,
  };
}
