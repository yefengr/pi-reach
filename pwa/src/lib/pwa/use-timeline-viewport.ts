import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TimelineViewItem } from "./timeline-runtime";
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor,
  type TimelineViewportAnchor,
} from "./timeline-viewport-anchor";

/** 离开会话时的阅读位置：停在底部时继续跟随，否则记录可按行重新定位的锚点。 */
export type TimelineSessionPosition = { following: true } | { following: false; anchor: TimelineViewportAnchor };

export type TimelineViewport = {
  followingOutput: boolean;
  unreadOutput: number;
  messageListRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  receiveRealtimeOutput: (groupKey: string) => void;
  handleScroll: (nearBottom: boolean) => void;
  showLatest: () => void;
  reset: () => void;
  setReadingDetails: (reading: boolean) => void;
  prepareHistoryPrepend: () => void;
  captureSessionPosition: () => TimelineSessionPosition | null;
  restoreSessionPosition: (position: TimelineSessionPosition | null) => void;
};

type ProgrammaticScroll = {
  list: HTMLDivElement;
  target: number;
  last: number;
  smooth: boolean;
};

const BOTTOM_EPSILON = 1;
/** 内边距等不改变元素尺寸的布局变化（ResizeObserver 无法感知）由派发方通知时间线重新贴底或恢复锚点。 */
export const TIMELINE_GEOMETRY_EVENT = "pwa:timeline-geometry";
const OBSERVED_CONTENT_EXCLUSIONS = ".pwa-earlier-button, .pwa-bottom-sentinel, .pwa-chat-empty";

function maxScrollTop(list: HTMLDivElement): number {
  return Math.max(0, list.scrollHeight - list.clientHeight);
}

function isAtBottom(list: HTMLDivElement): boolean {
  return maxScrollTop(list) - list.scrollTop <= BOTTOM_EPSILON;
}

function reducedMotionPreferred(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useTimelineViewport(items?: readonly TimelineViewItem[], enabled = true): TimelineViewport {
  const [followingOutput, setFollowingOutput] = useState(true);
  const [unreadOutput, setUnreadOutput] = useState(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const followingOutputRef = useRef(followingOutput);
  const enabledRef = useRef(enabled);
  const realtimeOutputKeysRef = useRef(new Set<string>());
  const readingDetailsRef = useRef(false);
  const readingAnchorRef = useRef<TimelineViewportAnchor | null>(null);
  const pendingFollowFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef<ProgrammaticScroll | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const geometryListenerCleanupRef = useRef<(() => void) | null>(null);
  const resizeObserverListRef = useRef<HTMLDivElement | null>(null);
  const observedElementsRef = useRef(new Set<Element>());
  const pendingSessionAnchorRef = useRef<TimelineViewportAnchor | null>(null);

  useLayoutEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const cancelPendingFollow = useCallback(() => {
    if (pendingFollowFrameRef.current === null) return;
    cancelAnimationFrame(pendingFollowFrameRef.current);
    pendingFollowFrameRef.current = null;
  }, []);

  const markProgrammaticScroll = useCallback((list: HTMLDivElement, target: number, smooth = false) => {
    programmaticScrollRef.current = { list, target, last: list.scrollTop, smooth };
  }, []);

  const scheduleFollow = useCallback(() => {
    const scheduledList = messageListRef.current;
    if (!enabledRef.current || !scheduledList || pendingFollowFrameRef.current !== null) return;
    pendingFollowFrameRef.current = requestAnimationFrame(() => {
      pendingFollowFrameRef.current = null;
      const list = messageListRef.current;
      if (!enabledRef.current || list !== scheduledList || !followingOutputRef.current || readingDetailsRef.current) return;
      if (isAtBottom(list)) {
        programmaticScrollRef.current = null;
        return;
      }
      // Latest 的平滑滚动拥有当前位置；结束后再追上期间新增的输出。
      if (programmaticScrollRef.current?.list === list && programmaticScrollRef.current.smooth) return;
      markProgrammaticScroll(list, maxScrollTop(list));
      list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
    });
  }, [markProgrammaticScroll]);

  const captureReadingAnchor = useCallback((preserveScrollTopFallback = false) => {
    const list = messageListRef.current;
    readingAnchorRef.current = list ? captureTimelineViewportAnchor(list, preserveScrollTopFallback) : null;
  }, []);

  const restoreReadingAnchor = useCallback((list: HTMLDivElement) => {
    const anchor = readingAnchorRef.current;
    if (!anchor || anchor.list !== list) {
      readingAnchorRef.current = null;
      return;
    }
    const previousScrollTop = list.scrollTop;
    const restored = restoreTimelineViewportAnchor(list, anchor);
    if (list.scrollTop !== previousScrollTop) markProgrammaticScroll(list, list.scrollTop);
    // 保留原始偏移，避免 scrollTop 像素取整在连续更新中累积漂移。
    if (!restored) readingAnchorRef.current = captureTimelineViewportAnchor(list);
  }, [markProgrammaticScroll]);

  const handleGeometryChange = useCallback((list: HTMLDivElement) => {
    if (!enabledRef.current || messageListRef.current !== list) return;
    if (followingOutputRef.current && !readingDetailsRef.current) {
      scheduleFollow();
      return;
    }
    restoreReadingAnchor(list);
    if (!readingAnchorRef.current) readingAnchorRef.current = captureTimelineViewportAnchor(list);
  }, [restoreReadingAnchor, scheduleFollow]);

  const disconnectResizeObserver = useCallback(() => {
    resizeObserverRef.current?.disconnect();
    geometryListenerCleanupRef.current?.();
    geometryListenerCleanupRef.current = null;
    resizeObserverRef.current = null;
    resizeObserverListRef.current = null;
    observedElementsRef.current.clear();
  }, []);

  const refreshResizeObserver = useCallback((list: HTMLDivElement) => {
    if (typeof ResizeObserver === "undefined") return;
    if (resizeObserverListRef.current !== list || !resizeObserverRef.current) {
      disconnectResizeObserver();
      const observer = new ResizeObserver(() => {
        if (resizeObserverRef.current !== observer || messageListRef.current !== list) return;
        handleGeometryChange(list);
      });
      resizeObserverRef.current = observer;
      resizeObserverListRef.current = list;
      const onGeometry = () => {
        if (!enabledRef.current || messageListRef.current !== list) return;
        if (followingOutputRef.current && !readingDetailsRef.current) {
          // 尺寸钳制产生的 scroll 事件会晚于此次布局变化到达，需登记为程序滚动，否则被当成用户上滑而停止跟随。
          cancelPendingFollow();
          markProgrammaticScroll(list, maxScrollTop(list));
          list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
          return;
        }
        handleGeometryChange(list);
      };
      list.addEventListener(TIMELINE_GEOMETRY_EVENT, onGeometry);
      geometryListenerCleanupRef.current = () => list.removeEventListener(TIMELINE_GEOMETRY_EVENT, onGeometry);
    }

    const observer = resizeObserverRef.current;
    if (!observer) return;
    const nextElements = new Set<Element>([list]);
    for (const child of list.children) {
      if (child instanceof HTMLElement && !child.matches(OBSERVED_CONTENT_EXCLUSIONS)) nextElements.add(child);
    }
    for (const element of observedElementsRef.current) {
      if (!nextElements.has(element)) observer.unobserve(element);
    }
    for (const element of nextElements) {
      if (!observedElementsRef.current.has(element)) observer.observe(element);
    }
    observedElementsRef.current = nextElements;
  }, [cancelPendingFollow, disconnectResizeObserver, handleGeometryChange, markProgrammaticScroll]);

  const reset = useCallback(() => {
    cancelPendingFollow();
    readingDetailsRef.current = false;
    readingAnchorRef.current = null;
    programmaticScrollRef.current = null;
    realtimeOutputKeysRef.current.clear();
    followingOutputRef.current = true;
    setFollowingOutput(true);
    setUnreadOutput(0);
  }, [cancelPendingFollow]);

  const setReadingDetails = useCallback((reading: boolean) => {
    if (reading) {
      cancelPendingFollow();
      programmaticScrollRef.current = null;
      captureReadingAnchor();
      // 展开内容只暂停自动跟随；阅读位置是否离开底部仍由实际滚动决定。
    } else {
      captureReadingAnchor();
    }
    readingDetailsRef.current = reading;
  }, [cancelPendingFollow, captureReadingAnchor]);

  const receiveRealtimeOutput = useCallback((groupKey: string) => {
    if (readingDetailsRef.current || !followingOutputRef.current) {
      if (realtimeOutputKeysRef.current.has(groupKey)) return;
      realtimeOutputKeysRef.current.add(groupKey);
      setUnreadOutput((count) => count + 1);
      return;
    }
    scheduleFollow();
  }, [scheduleFollow]);

  const prepareHistoryPrepend = useCallback(() => {
    cancelPendingFollow();
    programmaticScrollRef.current = null;
    followingOutputRef.current = false;
    setFollowingOutput(false);
    captureReadingAnchor(true);
  }, [cancelPendingFollow, captureReadingAnchor]);

  useLayoutEffect(() => {
    if (!enabled) {
      cancelPendingFollow();
      readingAnchorRef.current = null;
      programmaticScrollRef.current = null;
      disconnectResizeObserver();
      return;
    }
    const list = messageListRef.current;
    if (!list) return;
    refreshResizeObserver(list);
    if (!items?.length) return;
    const pendingAnchor = pendingSessionAnchorRef.current;
    if (pendingAnchor) {
      // 切回看过的会话：锚点所在行加载出来后恢复离开时的位置；在此之前先停在底部。
      const previousScrollTop = list.scrollTop;
      if (restoreTimelineViewportAnchor(list, { ...pendingAnchor, list, preserveScrollTopFallback: false })) {
        pendingSessionAnchorRef.current = null;
        cancelPendingFollow();
        if (list.scrollTop !== previousScrollTop) markProgrammaticScroll(list, list.scrollTop);
        followingOutputRef.current = false;
        setFollowingOutput(false);
        readingAnchorRef.current = captureTimelineViewportAnchor(list);
        return;
      }
      scheduleFollow();
      return;
    }
    if (!followingOutputRef.current || readingDetailsRef.current) restoreReadingAnchor(list);
    else scheduleFollow();
  }, [cancelPendingFollow, disconnectResizeObserver, enabled, items, markProgrammaticScroll, refreshResizeObserver, restoreReadingAnchor, scheduleFollow]);

  const consumeProgrammaticScroll = useCallback((): boolean => {
    const guard = programmaticScrollRef.current;
    const list = messageListRef.current;
    if (!guard || !list || guard.list !== list) {
      programmaticScrollRef.current = null;
      return false;
    }
    const current = list.scrollTop;
    if (!guard.smooth) {
      if (Math.abs(current - guard.target) > BOTTOM_EPSILON) {
        programmaticScrollRef.current = null;
        return false;
      }
      programmaticScrollRef.current = null;
      return true;
    }
    // Markdown 收缩可能让旧目标超出新的滚动范围，抵达新底部也算完成。
    const reachableTarget = Math.min(guard.target, maxScrollTop(list));
    if (Math.abs(current - reachableTarget) <= BOTTOM_EPSILON) {
      programmaticScrollRef.current = null;
      scheduleFollow();
      return true;
    }
    if (current + BOTTOM_EPSILON < guard.last || current > guard.target + BOTTOM_EPSILON) {
      programmaticScrollRef.current = null;
      return false;
    }
    guard.last = current;
    return true;
  }, [scheduleFollow]);

  const handleScroll = useCallback((nearBottom: boolean) => {
    if (consumeProgrammaticScroll()) return;
    // 用户在恢复前主动往上回看时以用户的位置为准；内容清空导致的回到顶部不算。
    if (!nearBottom) pendingSessionAnchorRef.current = null;
    if (readingDetailsRef.current) {
      captureReadingAnchor();
      if (!nearBottom && followingOutputRef.current) {
        followingOutputRef.current = false;
        setFollowingOutput(false);
      }
      return;
    }
    if (nearBottom) {
      reset();
      return;
    }
    cancelPendingFollow();
    if (followingOutputRef.current) realtimeOutputKeysRef.current.clear();
    followingOutputRef.current = false;
    setFollowingOutput(false);
    captureReadingAnchor();
  }, [cancelPendingFollow, captureReadingAnchor, consumeProgrammaticScroll, reset]);

  const captureSessionPosition = useCallback((): TimelineSessionPosition | null => {
    const list = messageListRef.current;
    if (!list || !enabledRef.current) return null;
    if (followingOutputRef.current && !readingDetailsRef.current) return { following: true };
    const anchor = captureTimelineViewportAnchor(list);
    return anchor ? { following: false, anchor } : { following: true };
  }, []);

  /** 在 reset 之后调用：没有记录或离开时在底部则照常跟随最新内容。 */
  const restoreSessionPosition = useCallback((position: TimelineSessionPosition | null) => {
    pendingSessionAnchorRef.current = position && !position.following ? position.anchor : null;
  }, []);

  const showLatest = useCallback(() => {
    pendingSessionAnchorRef.current = null;
    reset();
    const list = messageListRef.current;
    if (!list) return;
    const smooth = !reducedMotionPreferred();
    markProgrammaticScroll(list, maxScrollTop(list), smooth);
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [markProgrammaticScroll, reset]);

  useEffect(() => () => {
    cancelPendingFollow();
    disconnectResizeObserver();
    readingAnchorRef.current = null;
    programmaticScrollRef.current = null;
  }, [cancelPendingFollow, disconnectResizeObserver]);

  return {
    followingOutput,
    unreadOutput,
    messageListRef,
    bottomSentinelRef,
    receiveRealtimeOutput,
    handleScroll,
    showLatest,
    reset,
    setReadingDetails,
    prepareHistoryPrepend,
    captureSessionPosition,
    restoreSessionPosition,
  };
}
