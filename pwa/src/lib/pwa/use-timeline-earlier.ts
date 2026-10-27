import { useCallback, useRef, useState } from "react";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineEarlierSource } from "@/lib/pwa/timeline-local-pager";

type UseTimelineEarlierOptions = {
  /** 用户发起翻页前登记阅读锚点，前插后由视口协调器恢复。 */
  prepareHistoryPrepend: () => void;
  /** 等触摸、惯性与回弹结束后执行；返回取消函数。 */
  whenScrollIdle: (run: () => void) => () => void;
};

type EarlierHandlerOptions = {
  /** 来源所属的会话代际仍有效；失效后忽略迟到结果。 */
  current: () => boolean;
  /** 把一页记录并入当前投影。 */
  apply: (events: TimelineEvent[]) => void;
  /** 返回 true 时这一页立即并入，不等滚动静止（如在线会话的权威替换）。 */
  immediate?: () => boolean;
  onError?: (message: string) => void;
};

/**
 * 在线会话与只读历史共用的向前翻页：同一套加载状态、失败重试，以及「滚动停下再前插」。
 * 来源（Relay 加载器或本地分页器）只负责取页，前插时机与阅读位置保护都在这里。
 */
export function useTimelineEarlier({ prepareHistoryPrepend, whenScrollIdle }: UseTimelineEarlierOptions) {
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loading, setLoading] = useState(false);
  // 用户向前加载的一页在触摸、惯性或回弹期间暂存，静止后再前插；期间仍按加载中显示。
  const [holding, setHolding] = useState(false);
  // 普通向前翻页失败后停止自动加载，由用户重试。
  const [failed, setFailed] = useState(false);
  const sourceRef = useRef<TimelineEarlierSource | null>(null);
  const requestedRef = useRef(false);
  const heldRef = useRef<(() => void) | null>(null);

  /** 销毁当前来源并撤销暂存页；换会话后由新来源重新计算范围，旧页不再前插到新视图。 */
  const release = useCallback(() => {
    sourceRef.current?.dispose();
    sourceRef.current = null;
    setLoading(false);
    heldRef.current?.();
    heldRef.current = null;
    requestedRef.current = false;
    setHolding(false);
  }, []);

  const attach = useCallback((source: TimelineEarlierSource) => {
    sourceRef.current = source;
  }, []);

  const handlers = useCallback(({ current, apply, immediate, onError }: EarlierHandlerOptions) => ({
    onPage: (events: TimelineEvent[]) => {
      if (!current()) return;
      // 只推迟用户发起的翻页；补齐与替换的分页按原时序进入，不影响暂存门禁。
      const requested = requestedRef.current;
      requestedRef.current = false;
      if (!requested || immediate?.()) { apply(events); return; }
      let held = true;
      setHolding(true);
      const cancel = whenScrollIdle(() => {
        held = false;
        heldRef.current = null;
        setHolding(false);
        if (current()) apply(events);
      });
      if (held) heldRef.current = cancel;
    },
    onState: (state: { hasEarlier: boolean; loading: boolean }) => {
      if (!current()) return;
      setHasEarlier(state.hasEarlier);
      setLoading(state.loading);
    },
    onError: (message: string) => {
      if (!current()) return;
      requestedRef.current = false;
      setFailed(true);
      onError?.(message);
    },
  }), [whenScrollIdle]);

  const busy = loading || holding;
  /** 发起用户翻页；没有来源、正在加载或暂存中、或已没有更早记录时不发起。 */
  const request = useCallback(() => {
    const source = sourceRef.current;
    if (!source || busy || !source.hasEarlier) return;
    setFailed(false);
    prepareHistoryPrepend();
    requestedRef.current = true;
    void source.loadEarlier();
  }, [busy, prepareHistoryPrepend]);

  return { sourceRef, hasEarlier, loading, holding, busy, failed, setFailed, setHasEarlier, release, attach, handlers, request };
}
