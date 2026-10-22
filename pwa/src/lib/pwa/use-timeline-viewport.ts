import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TimelineViewItem } from "./timeline-runtime";
import { OwnSendTransition } from "./own-send-transition";
import { ActivityFollowTransition } from "./timeline-follow-motion";
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
  /** 成功提交后恢复跟随，并在短期同一时钟内协调输入区回缩与贴底。 */
  followOwnSend: () => void;
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
const TOUCH_READ_THRESHOLD = 4;
/** 内边距等不改变元素尺寸的布局变化（ResizeObserver 无法感知）由派发方通知时间线重新贴底或恢复锚点。 */
export const TIMELINE_GEOMETRY_EVENT = "pwa:timeline-geometry";
const OBSERVED_CONTENT_EXCLUSIONS = ".pwa-earlier, .pwa-bottom-sentinel, .pwa-chat-empty";

function maxScrollTop(list: HTMLDivElement, scrollHeight = list.scrollHeight): number {
  return Math.max(0, scrollHeight - list.clientHeight);
}

function isAtBottom(list: HTMLDivElement, bottomEdge: number): boolean {
  return bottomEdge - list.scrollTop <= BOTTOM_EPSILON;
}

/** 已同步过的直接 children：用于在同一次 items 变更中跳过无变化的观察器差分。 */
type ObservedChildSnapshot = {
  elements: Element[];
  classNames: (string | null)[];
};

function childClassName(child: Element): string | null {
  return child instanceof HTMLElement ? child.className : null;
}

function isSameObservedChildren(snapshot: ObservedChildSnapshot, children: HTMLCollection): boolean {
  if (snapshot.elements.length !== children.length) return false;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (snapshot.elements[index] !== child) return false;
    // className 变化会改变角色排除结果，必须与身份一起比较。
    if (snapshot.classNames[index] !== childClassName(child)) return false;
  }
  return true;
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
  const followGenerationRef = useRef(0);
  const ownSendRef = useRef<OwnSendTransition | null>(null);
  const activityFollowRef = useRef<ActivityFollowTransition | null>(null);
  const handoffRef = useRef<HTMLDivElement | null>(null);
  const lastTopRef = useRef(0);
  const activityGeometryReadyRef = useRef(false);
  const programmaticScrollRef = useRef<ProgrammaticScroll | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const geometryListenerCleanupRef = useRef<(() => void) | null>(null);
  const resizeObserverListRef = useRef<HTMLDivElement | null>(null);
  const observedElementsRef = useRef(new Set<Element>());
  const observedChildSnapshotRef = useRef<ObservedChildSnapshot | null>(null);
  const pendingSessionAnchorRef = useRef<TimelineViewportAnchor | null>(null);

  useLayoutEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const cancelPendingFollow = useCallback(() => {
    followGenerationRef.current += 1;
    handoffRef.current = null;
    if (pendingFollowFrameRef.current === null) return;
    cancelAnimationFrame(pendingFollowFrameRef.current);
    pendingFollowFrameRef.current = null;
  }, []);

  const markProgrammaticScroll = useCallback((list: HTMLDivElement, target: number, smooth = false) => {
    programmaticScrollRef.current = { list, target, last: list.scrollTop, smooth };
  }, []);

  const writeScroll = useCallback((list: HTMLDivElement, top: number) => {
    // 先登记意图也兼容同步派发 scroll 的消费者，返回后再按真实落点校正。
    markProgrammaticScroll(list, top);
    list.scrollTo({ top, behavior: "auto" });
    // 浏览器会钳制或取整请求值；异步 scroll 应匹配实际接受的位置。
    lastTopRef.current = list.scrollTop;
    markProgrammaticScroll(list, list.scrollTop);
  }, [markProgrammaticScroll]);

  const finishOwnSend = useCallback((preserveAnchor = false) => {
    const transition = ownSendRef.current ?? activityFollowRef.current;
    ownSendRef.current = null;
    activityFollowRef.current = null;
    if (!transition) return;
    const anchor = preserveAnchor ? captureTimelineViewportAnchor(transition.list) : null;
    transition.finish();
    if (anchor) {
      restoreTimelineViewportAnchor(transition.list, anchor);
      markProgrammaticScroll(transition.list, transition.list.scrollTop);
    }
  }, [markProgrammaticScroll]);

  const followNow = useCallback((now = performance.now()): boolean => {
    const list = messageListRef.current;
    if (!enabledRef.current || !list || !followingOutputRef.current || readingDetailsRef.current) return false;
    // Latest 的平滑滚动拥有当前位置；结束后再追上期间新增的输出。
    if (programmaticScrollRef.current?.list === list && programmaticScrollRef.current.smooth) return false;
    const transition = ownSendRef.current ?? activityFollowRef.current;
    if (transition) {
      if (transition.list !== list || !list.isConnected || reducedMotionPreferred() || document.hidden) finishOwnSend();
      else {
        const step = transition.advance(now);
        if (step.finished) {
          // 先恢复自然布局再读取真实终点，不能让末帧和释放后的几何分属两次绘制。
          finishOwnSend();
          writeScroll(list, maxScrollTop(list));
          handoffRef.current = list;
          return true;
        }
        writeScroll(list, step.top);
        return true;
      }
    }
    const height = list.scrollHeight;
    const bottomEdge = maxScrollTop(list, height);
    if (handoffRef.current === list) {
      handoffRef.current = null;
      writeScroll(list, height);
    } else if (!isAtBottom(list, bottomEdge)) writeScroll(list, height);
    else lastTopRef.current = list.scrollTop;
    activityGeometryReadyRef.current = true;
    return false;
  }, [finishOwnSend, writeScroll]);

  const scheduleFollow = useCallback(function schedule() {
    const scheduledList = messageListRef.current;
    if (!enabledRef.current || !scheduledList || pendingFollowFrameRef.current !== null) return;
    const generation = followGenerationRef.current;
    pendingFollowFrameRef.current = requestAnimationFrame((now) => {
      if (generation !== followGenerationRef.current) return;
      pendingFollowFrameRef.current = null;
      if (messageListRef.current === scheduledList && followNow(now)) schedule();
    });
  }, [followNow]);

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
    observedChildSnapshotRef.current = null;
  }, []);

  const refreshResizeObserver = useCallback((list: HTMLDivElement) => {
    if (typeof ResizeObserver === "undefined") return;
    if (resizeObserverListRef.current !== list || !resizeObserverRef.current) {
      disconnectResizeObserver();
      activityGeometryReadyRef.current = false;
      const observer = new ResizeObserver(() => {
        if (resizeObserverRef.current !== observer || messageListRef.current !== list) return;
        handleGeometryChange(list);
      });
      resizeObserverRef.current = observer;
      resizeObserverListRef.current = list;
      const onGeometry = (event: Event) => {
        if (!enabledRef.current || messageListRef.current !== list) return;
        if (followingOutputRef.current && !readingDetailsRef.current) {
          // 尺寸钳制产生的 scroll 事件会晚于此次布局变化到达，需登记为程序滚动，否则被当成用户上滑而停止跟随。
          if (programmaticScrollRef.current?.smooth) return;
          const activityChanged = event instanceof CustomEvent && event.detail?.reason === "activity";
          if (activityChanged && activityGeometryReadyRef.current && !ownSendRef.current && !activityFollowRef.current && !reducedMotionPreferred() && !document.hidden &&
              Math.abs(maxScrollTop(list) - lastTopRef.current) > BOTTOM_EPSILON) {
            activityFollowRef.current = new ActivityFollowTransition(list, lastTopRef.current);
          }
          if (ownSendRef.current || activityFollowRef.current) { if (followNow()) scheduleFollow(); return; }
          cancelPendingFollow();
          followNow();
          return;
        }
        handleGeometryChange(list);
      };
      const interrupt = () => {
        if (!ownSendRef.current && !activityFollowRef.current && !handoffRef.current) return;
        cancelPendingFollow();
        finishOwnSend(true);
        programmaticScrollRef.current = null;
        readingAnchorRef.current = captureTimelineViewportAnchor(list);
        followingOutputRef.current = false;
        setFollowingOutput(false);
      };
      const main = list.closest(".pwa-main");
      const onInput = (event: Event) => {
        if (!(event.target instanceof HTMLTextAreaElement) || !ownSendRef.current) return;
        // 下一条草稿重新交还 autosize，不让上一条发送动画继续覆盖它的尺寸。
        cancelPendingFollow();
        finishOwnSend(true);
      };
      let touch: { id: number; y: number } | null = null;
      const onTouchStart = (event: TouchEvent) => {
        const first = event.touches[0];
        touch = event.touches.length === 1 ? { id: first.identifier, y: first.clientY } : null;
      };
      const onTouchMove = (event: TouchEvent) => {
        const first = event.touches[0];
        if (event.touches.length !== 1 || first.identifier !== touch?.id) { touch = null; return; }
        // 手指向下拖，才是向更早消息回看；轻点、反向移动及多指缩放不暂停跟随。
        if (first.clientY - touch.y > TOUCH_READ_THRESHOLD) { touch = null; interrupt(); }
      };
      const onTouchEnd = () => { touch = null; };
      const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) interrupt(); };
      const onKey = (event: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) interrupt(); };
      const onPointerDown = (event: PointerEvent) => {
        // 拖动原生滚动条也是明确用户输入，不由收尾保护吞掉。
        if (event.pointerType === "mouse" && event.target === list) interrupt();
      };
      list.addEventListener(TIMELINE_GEOMETRY_EVENT, onGeometry);
      list.addEventListener("wheel", onWheel, { passive: true });
      list.addEventListener("touchstart", onTouchStart, { passive: true });
      list.addEventListener("touchmove", onTouchMove, { passive: true });
      list.addEventListener("touchend", onTouchEnd, { passive: true });
      list.addEventListener("touchcancel", onTouchEnd, { passive: true });
      list.addEventListener("keydown", onKey);
      list.addEventListener("pointerdown", onPointerDown);
      main?.addEventListener("input", onInput, true);
      geometryListenerCleanupRef.current = () => {
        list.removeEventListener(TIMELINE_GEOMETRY_EVENT, onGeometry);
        list.removeEventListener("wheel", onWheel);
        list.removeEventListener("touchstart", onTouchStart);
        list.removeEventListener("touchmove", onTouchMove);
        list.removeEventListener("touchend", onTouchEnd);
        list.removeEventListener("touchcancel", onTouchEnd);
        list.removeEventListener("keydown", onKey);
        list.removeEventListener("pointerdown", onPointerDown);
        main?.removeEventListener("input", onInput, true);
      };
    }

    const observer = resizeObserverRef.current;
    if (!observer) return;
    const children = list.children;
    const previousSnapshot = observedChildSnapshotRef.current;
    // 内容流更新通常只换子树文本：身份与类名一致时无需重建 Set、重跑排除匹配或做观察目标差分。
    if (previousSnapshot && isSameObservedChildren(previousSnapshot, children)) return;
    const nextElements = new Set<Element>([list]);
    const elements: Element[] = [];
    const classNames: (string | null)[] = [];
    for (const child of children) {
      elements.push(child);
      classNames.push(childClassName(child));
      if (child instanceof HTMLElement && !child.matches(OBSERVED_CONTENT_EXCLUSIONS)) nextElements.add(child);
    }
    for (const element of observedElementsRef.current) {
      if (!nextElements.has(element)) observer.unobserve(element);
    }
    for (const element of nextElements) {
      if (!observedElementsRef.current.has(element)) observer.observe(element);
    }
    observedElementsRef.current = nextElements;
    observedChildSnapshotRef.current = { elements, classNames };
  }, [cancelPendingFollow, disconnectResizeObserver, finishOwnSend, followNow, handleGeometryChange, scheduleFollow]);

  const reset = useCallback(() => {
    cancelPendingFollow();
    finishOwnSend();
    readingDetailsRef.current = false;
    readingAnchorRef.current = null;
    programmaticScrollRef.current = null;
    lastTopRef.current = messageListRef.current?.scrollTop ?? 0;
    activityGeometryReadyRef.current = false;
    realtimeOutputKeysRef.current.clear();
    followingOutputRef.current = true;
    setFollowingOutput(true);
    setUnreadOutput(0);
  }, [cancelPendingFollow, finishOwnSend]);

  const setReadingDetails = useCallback((reading: boolean) => {
    if (reading) {
      cancelPendingFollow();
      finishOwnSend(true);
      programmaticScrollRef.current = null;
      captureReadingAnchor();
      // 展开内容只暂停自动跟随；阅读位置是否离开底部仍由实际滚动决定。
    } else {
      captureReadingAnchor();
    }
    readingDetailsRef.current = reading;
  }, [cancelPendingFollow, captureReadingAnchor, finishOwnSend]);

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
    finishOwnSend(true);
    programmaticScrollRef.current = null;
    followingOutputRef.current = false;
    setFollowingOutput(false);
    captureReadingAnchor(true);
  }, [cancelPendingFollow, captureReadingAnchor, finishOwnSend]);

  useLayoutEffect(() => {
    if (!enabled) {
      cancelPendingFollow();
      finishOwnSend();
      readingAnchorRef.current = null;
      programmaticScrollRef.current = null;
      disconnectResizeObserver();
      activityGeometryReadyRef.current = false;
      return;
    }
    const list = messageListRef.current;
    if (!list) return;
    refreshResizeObserver(list);
    if (!items?.length) { activityGeometryReadyRef.current = false; return; }
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
      cancelPendingFollow();
      followNow();
      return;
    }
    if (!followingOutputRef.current || readingDetailsRef.current) restoreReadingAnchor(list);
    else {
      // 成功发送只合并目标；普通输出仍在绘制前贴底，不重启短期发送时钟。
      if (ownSendRef.current || activityFollowRef.current) { if (followNow()) scheduleFollow(); }
      else { cancelPendingFollow(); followNow(); }
    }
    // 子组件的布局通知先于此处；reset 后必须先建立新内容的基线才能创建状态过渡。
    activityGeometryReadyRef.current = true;
  }, [cancelPendingFollow, disconnectResizeObserver, enabled, finishOwnSend, items, markProgrammaticScroll, refreshResizeObserver, restoreReadingAnchor, followNow, scheduleFollow]);

  const consumeProgrammaticScroll = useCallback((): boolean => {
    const guard = programmaticScrollRef.current;
    const list = messageListRef.current;
    if (!guard || !list || guard.list !== list) {
      programmaticScrollRef.current = null;
      return false;
    }
    const current = list.scrollTop;
    if (!guard.smooth) {
      const reachable = Math.min(guard.target, maxScrollTop(list));
      if (Math.abs(current - reachable) > BOTTOM_EPSILON) {
        // 仅当前控制器及其下一帧收尾拥有纠正权；明确用户输入会先撤销所有权。
        if (ownSendRef.current || activityFollowRef.current || handoffRef.current === list) {
          writeScroll(list, reachable);
          return true;
        }
        programmaticScrollRef.current = null;
        return false;
      }
      lastTopRef.current = current;
      if (!ownSendRef.current && !activityFollowRef.current && !handoffRef.current) programmaticScrollRef.current = null;
      return true;
    }
    lastTopRef.current = current;
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
  }, [scheduleFollow, writeScroll]);

  const handleScroll = useCallback((nearBottom: boolean) => {
    if (consumeProgrammaticScroll()) return;
    lastTopRef.current = messageListRef.current?.scrollTop ?? 0;
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
      activityGeometryReadyRef.current = true;
      return;
    }
    cancelPendingFollow();
    finishOwnSend(true);
    if (followingOutputRef.current) realtimeOutputKeysRef.current.clear();
    followingOutputRef.current = false;
    setFollowingOutput(false);
    captureReadingAnchor();
  }, [cancelPendingFollow, captureReadingAnchor, consumeProgrammaticScroll, finishOwnSend, reset]);

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

  const followOwnSend = useCallback(() => {
    pendingSessionAnchorRef.current = null;
    // 连续发送从当前可见尺寸续接，不先跳到上一条消息的收缩终点。
    ownSendRef.current?.finish(false);
    ownSendRef.current = null;
    reset();
    const list = messageListRef.current;
    if (enabledRef.current && list?.isConnected && !reducedMotionPreferred() && !document.hidden) {
      ownSendRef.current = new OwnSendTransition(list);
    }
  }, [reset]);

  const showLatest = useCallback(() => {
    pendingSessionAnchorRef.current = null;
    reset();
    const list = messageListRef.current;
    if (!list) return;
    const smooth = !reducedMotionPreferred();
    const height = list.scrollHeight;
    markProgrammaticScroll(list, maxScrollTop(list, height), smooth);
    list.scrollTo({ top: height, behavior: smooth ? "smooth" : "auto" });
  }, [markProgrammaticScroll, reset]);

  useEffect(() => {
    const settle = () => {
      if (!ownSendRef.current && !activityFollowRef.current && !handoffRef.current) return;
      cancelPendingFollow();
      finishOwnSend();
      followNow();
    };
    const onVisibility = () => { if (document.hidden) settle(); };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => { if (motion.matches) settle(); };
    window.addEventListener("resize", settle);
    document.addEventListener("visibilitychange", onVisibility);
    motion.addEventListener("change", onMotion);
    return () => {
      cancelPendingFollow();
      finishOwnSend();
      disconnectResizeObserver();
      readingAnchorRef.current = null;
      programmaticScrollRef.current = null;
      window.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", onMotion);
    };
  }, [cancelPendingFollow, disconnectResizeObserver, finishOwnSend, followNow]);

  return {
    followingOutput,
    unreadOutput,
    messageListRef,
    bottomSentinelRef,
    receiveRealtimeOutput,
    handleScroll,
    showLatest,
    followOwnSend,
    reset,
    setReadingDetails,
    prepareHistoryPrepend,
    captureSessionPosition,
    restoreSessionPosition,
  };
}
