import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import { TimelineEventFragmentAssembler } from "@/lib/pwa/timeline-transfer";
import { TimelineHistoryLoader } from "@/lib/pwa/timeline-history-loader";
import { TimelineRuntime, type TimelinePreviewTarget, type TimelineScope, type TimelineRuntimeChange, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { TIMELINE_RECENT_LIMIT } from "@/lib/pwa/timeline-reconnect";
import { StreamDisplayBuffer } from "@/lib/pwa/stream-display-buffer";
import { StreamDisplayScheduler } from "@/lib/pwa/stream-display-scheduler";
import { clearTimelineBranchCheckpoint, discardTimelineEventsAfter, ensureTimelineBranchCheckpoint, latestTimelineEvent, loadTimeline, mergeTimelineEvents, replaceTimelineEvents, type TimelineBranchCheckpoint } from "@/lib/pwa/timeline-store";
import { beginTimelinePersistenceEpoch, enqueueTimelinePersistence } from "@/lib/pwa/timeline-persistence";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { ClientFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";

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
  /** 本地缓存与当前分支不一致（断线期间换了分支、未收到 reset）；调用方按 branch reset 恢复。 */
  onBranchMismatch: () => void;
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

/** 预览只取末尾连续编号的最近记录，握手确认同一会话后才能按已保留区间增量追加；存在无序号记录时不预览。 */
function recentContiguousEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  if (events.some((event) => event.event_seq === undefined)) return [];
  const recent: TimelineEvent[] = [];
  for (let index = events.length - 1; index >= 0 && recent.length < TIMELINE_RECENT_LIMIT; index -= 1) {
    const event = events[index]!;
    if (recent.length > 0 && event.event_seq !== recent[0]!.event_seq! - 1) break;
    recent.unshift(event);
  }
  return recent;
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
  // 普通向前翻页失败后停止自动加载，由用户重试；补齐失败另由 catchupFailed 表示。
  const [earlierFailed, setEarlierFailed] = useState(false);
  // 接在本地预览之后的补齐只追加最新记录，不在顶部显示「正在加载记录」，避免内容上下跳动。
  const [quietCatchup, setQuietCatchup] = useState(false);

  const runtimeRef = useRef(new TimelineRuntime());
  const historyLoaderRef = useRef<TimelineHistoryLoader | null>(null);
  const fragmentAssemblerRef = useRef<TimelineEventFragmentAssembler | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef<TimelineViewItem[]>([]);
  const contextGenerationRef = useRef(0);
  const replacementGateRef = useRef(false);
  const deferredChangeRef = useRef<TimelineRuntimeChange | null>(null);
  const failedCatchupRef = useRef<FailedCatchup | null>(null);
  const onHistoryChangedRef = useRef<(() => void) | null>(null);
  // 当前连接补齐成功后待执行的分支核对；每个连接只执行一次。
  const branchCheckRef = useRef<(() => Promise<void>) | null>(null);
  const forceAuthoritativeReplacementRef = useRef(false);
  const replacementRequiresReplaceRef = useRef(false);
  const persistenceEpochRef = useRef(0);
  const catchingUpRef = useRef(false);
  // 切换 Pi 后的本地预览读取是异步的；再次切换或清空时作废尚未返回的读取。
  const previewTokenRef = useRef(0);
  const viewport = useTimelineViewport(items, enabled);
  const { receiveRealtimeOutput, prepareHistoryPrepend, reset: resetOutputFollowing } = viewport;

  const updateItems = useCallback((next: TimelineViewItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const [streamDisplay] = useState(() => new StreamDisplayScheduler(new StreamDisplayBuffer(), () => undefined));
  useLayoutEffect(() => {
    streamDisplay.setPublisher((next, realtime) => {
      updateItems(next);
      if (!realtime) return;
      const groups = new Set(next.flatMap((item) => item.kind === "partial" ? [item.partial.group_id] : []));
      for (const groupId of groups) receiveRealtimeOutput(groupId);
    });
  }, [receiveRealtimeOutput, streamDisplay, updateItems]);

  const renderChange = useCallback((change: TimelineRuntimeChange, resetDisplay: boolean) => {
    streamDisplay.update(change.items, resetDisplay);
  }, [streamDisplay]);

  useEffect(() => {
    const onVisibilityChange = () => streamDisplay.setHidden(document.hidden);
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      streamDisplay.cancel();
    };
  }, [streamDisplay]);

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

  const runBranchCheck = useCallback(() => {
    const check = branchCheckRef.current;
    branchCheckRef.current = null;
    void check?.();
  }, []);

  const startLive = useCallback(({ scope, headSeq, send, onHistoryChanged, onBranchMismatch }: StartLiveOptions) => {
    const generation = ++contextGenerationRef.current;
    streamDisplay.cancel();
    clearTransitionTimer();
    disposeLoader();
    replacementGateRef.current = false;
    deferredChangeRef.current = null;
    failedCatchupRef.current = null;
    onHistoryChangedRef.current = onHistoryChanged;
    catchingUpRef.current = false;
    setCatchupFailed(false);
    setEarlierFailed(false);
    setCatchingUp(false);
    setReconnectPhase(null);

    const forceAuthoritativeReplacement = forceAuthoritativeReplacementRef.current;
    forceAuthoritativeReplacementRef.current = false;
    persistenceEpochRef.current = beginTimelinePersistenceEpoch(runtimeRef.current);
    const prepared = runtimeRef.current.prepareLive(scope, headSeq);
    // 只有 branch reset 或同一会话序号回退说明本地记录已过期，才整段替换；缺口过大、Pi 重启或换会话
    // 只是显示窗口从最新处重新开始，按首次打开合并，不删除本浏览器已保存的更早记录。
    const knownStale = forceAuthoritativeReplacement || prepared.sequenceRegressed;
    replacementRequiresReplaceRef.current = knownStale;
    // 冷启动等内存中没有已保留记录时，按本地已保存的最大序号补判回退；读取失败按未回退处理，与首次打开一致。
    const localLatest = knownStale ? Promise.resolve(null) : latestTimelineEvent(scope).catch(() => null);
    const localAhead = localLatest.then((latest) => {
      const ahead = (latest?.event_seq ?? 0) > headSeq;
      if (ahead && generation === contextGenerationRef.current) replacementRequiresReplaceRef.current = true;
      return ahead;
    });
    // 超出 head 的本地记录必属旧分支，合并路径不会覆盖它们。握手时同步排进持久化队列，
    // 先于之后实时事件的保存执行，不会误删握手后收到的新事件。
    // 分支检查点同样排在补齐与实时事件写入之前，见下方 branchCheckRef。
    let checkpoint: TimelineBranchCheckpoint | null = null;
    let checkpointReady = Promise.resolve(false);
    if (!knownStale) {
      void enqueueTimelinePersistence(runtimeRef.current, persistenceEpochRef.current, () => discardTimelineEventsAfter(scope, headSeq)).catch(() => {
        if (generation === contextGenerationRef.current) reportHistoryFailure("Could not update local history.");
      });
      // 写入失败时不能跳过核对：退回握手时读到的本地最新记录，至少在本次连接内核对一次。
      checkpointReady = enqueueTimelinePersistence(runtimeRef.current, persistenceEpochRef.current, async () => {
        checkpoint = await ensureTimelineBranchCheckpoint(scope).catch(async () => {
          const latest = await localLatest;
          return latest?.event_seq === undefined ? null : { eventSeq: latest.event_seq, eventId: latest.event_id };
        });
      }).catch(() => false);
    }
    setQuietCatchup(prepared.previewMatched);
    fragmentAssemblerRef.current = new TimelineEventFragmentAssembler({ session_id: scope.sessionId, leaf_id: scope.leafId });

    const loader = new TimelineHistoryLoader({
      scope,
      headSeq,
      ...(prepared.plan.earliestSeq === null ? {} : { boundary: prepared.plan.earliestSeq }),
      send,
      currentLeafId: () => {
        const current = runtimeRef.current.currentScope;
        return current && current.sessionId === scope.sessionId ? current.leafId : scope.leafId;
      },
      // Branch replacement must persist one complete staged projection before exposing it.
      load: async (target) => {
        await localAhead;
        return prepared.plan.mode === "replace" && replacementRequiresReplaceRef.current ? [] : loadTimeline(target);
      },
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
        if (generation !== contextGenerationRef.current) return;
        setEarlierFailed(true);
        reportHistoryFailure(message);
      },
    });
    historyLoaderRef.current = loader;

    const range = prepared.plan.startSeq === null
      ? null
      : { start: prepared.plan.startSeq, end: prepared.plan.endSeq };
    const hasCatchupWork = range !== null || prepared.plan.mode === "replace";
    catchingUpRef.current = hasCatchupWork;
    setCatchingUp(hasCatchupWork);

    // 序号未回退时本地缓存仍可能属于断线期间被放弃的分支：补齐后取检查点序号的权威事件核对 event_id。
    // 一致说明此前的记录都在当前分支上；不一致则按 branch reset 恢复，强制替换会清掉期间写入的记录与检查点，
    // 避免继续向前加载时把两个分支拼在一起。核对放在补齐之后，不拖慢打开。检查点持久化在本地、核对通过才清除：
    // 请求失败或中途断线时留到下次连接，不让本次补齐写入的当前分支记录顶替它而使核对误判通过。
    branchCheckRef.current = async () => {
      if (!await checkpointReady || await localAhead || generation !== contextGenerationRef.current) return;
      const pending = checkpoint;
      if (!pending) return;
      // 检查点超出当前 head（此前已因序号回退删去其记录），不可能在当前分支上。
      if (pending.eventSeq > headSeq) {
        onBranchMismatch();
        return;
      }
      const remoteId = await loader.fetchEventId(pending.eventSeq);
      if (remoteId === null || generation !== contextGenerationRef.current) return;
      if (remoteId !== pending.eventId) {
        onBranchMismatch();
        return;
      }
      await clearTimelineBranchCheckpoint(scope, pending).catch(() => {});
    };

    const loadPreparedRange = async () => {
      // 替换前须确定是否整段替换本地记录；没有区间可取时也要等补判完成。
      await localAhead;
      if (generation !== contextGenerationRef.current) return;
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
          return;
        }
        runBranchCheck();
        return;
      }
      catchingUpRef.current = false;
      setCatchingUp(false);
      runBranchCheck();
    };

    if (prepared.plan.mode === "append") {
      applyTimelineChange(prepared.change);
      void loadPreparedRange();
      return prepared.plan;
    }

    replacementGateRef.current = true;
    deferredChangeRef.current = null;
    renderChange(prepared.change, true);
    streamDisplay.cancel();

    // 暂存期间保持旧投影可见；失败时保留暂存门禁，重试成功后再提交。
    void loadPreparedRange();
    return prepared.plan;
  }, [applyTimelineChange, clearTransitionTimer, disposeLoader, finishReplacement, renderChange, reportHistoryFailure, runBranchCheck, streamDisplay]);

  const retryCatchup = useCallback(async (): Promise<boolean> => {
    const failed = failedCatchupRef.current;
    const loader = historyLoaderRef.current;
    if (catchingUpRef.current || !failed || !loader || failed.generation !== contextGenerationRef.current) return false;
    catchingUpRef.current = true;
    setCatchingUp(true);
    // 补齐失败也经 onError 记为分页失败；重试时一并清除，再次失败会重新设置。
    setEarlierFailed(false);

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
      runBranchCheck();
    } else {
      failedCatchupRef.current = failed;
      setCatchupFailed(true);
    }
    return succeeded;
  }, [finishReplacement, runBranchCheck]);

  const loadEarlier = useCallback(() => {
    const loader = historyLoaderRef.current;
    if (!loader || loadingEarlier || catchingUpRef.current) return;
    if (failedCatchupRef.current) {
      void retryCatchup();
      return;
    }
    if (!loader.hasEarlier) return;
    setEarlierFailed(false);
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
    branchCheckRef.current = null;
    catchingUpRef.current = false;
    setCatchupFailed(false);
    // loader 已销毁，旧的失败无法再重试；重连后按新连接的结果判断。
    setEarlierFailed(false);
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
    previewTokenRef.current += 1;
    disconnect();
    setHasEarlierState(false);
    setLastSyncedAt(undefined);
    resetOutputFollowing();
    applyTimelineChange(runtimeRef.current.clear(), true);
  }, [applyTimelineChange, disconnect, resetOutputFollowing]);

  /** 切换到另一个 Pi：立即撤下旧会话；有本地缓存时先显示该会话最近的记录，握手后再增量补齐或改为加载新会话。 */
  const switchLive = useCallback((preview: TimelinePreviewTarget | null) => {
    const token = ++previewTokenRef.current;
    disconnect();
    setHasEarlierState(false);
    setLastSyncedAt(undefined);
    resetOutputFollowing();
    applyTimelineChange(runtimeRef.current.detachLive(), true);
    if (!preview) return;
    // 预览只为提速：读取失败或晚于握手时放弃，照常等待实时会话的正式加载。
    void loadTimeline({ ...preview, leafId: null }).then((events) => {
      if (token !== previewTokenRef.current) return;
      const change = runtimeRef.current.showPreview(preview, recentContiguousEvents(events));
      if (change) applyTimelineChange(change, true);
    }, () => undefined);
  }, [applyTimelineChange, disconnect, resetOutputFollowing]);

  useEffect(() => () => {
    previewTokenRef.current += 1;
    contextGenerationRef.current += 1;
    clearTransitionTimer();
    streamDisplay.cancel();
    historyLoaderRef.current?.dispose();
  }, [clearTransitionTimer, streamDisplay]);

  return {
    items,
    lastSyncedAt,
    setLastSyncedAt,
    hasEarlier: hasEarlierState || catchupFailed || (catchingUp && !quietCatchup),
    loadingEarlier: loadingEarlier || (catchingUp && !quietCatchup),
    loadEarlierFailed: earlierFailed || catchupFailed,
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
    switchLive,
    ...viewport,
  };
}
