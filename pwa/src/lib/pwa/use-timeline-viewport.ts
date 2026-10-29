import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TimelineViewItem } from "./timeline-runtime";
import type { OwnSendLayoutCapture } from "./own-send-transition";
import type { TimelineViewportAnchor } from "./timeline-viewport-anchor";
import { TimelineViewportCoordinator, type ViewportCapture, type ViewportPosition } from "./timeline-viewport-coordinator";
import { TimelineViewportLayout } from "./timeline-viewport-layout";
import { TimelineViewportObservers } from "./timeline-viewport-observers";
import { ScrollIdleGate } from "./scroll-idle-gate";
import { LatestEntryVisibility } from "./latest-entry";
import { clearViewportDiagnostics, installViewportDiagnostics, recordViewportDiagnostic, viewportDiagnosticCapture, viewportDiagnosticsEnabled, viewportDiagnosticSamplingEnabled } from "./timeline-viewport-diagnostics";

export { TIMELINE_GEOMETRY_EVENT } from "./timeline-viewport-observers";
/** 离开会话时的位置；只有调用方确认的相同 scope 可显式迁移恢复。 */
export type TimelineSessionPosition = ViewportPosition<TimelineViewportAnchor>;
export type OwnSendCapture = ViewportCapture<OwnSendLayoutCapture>;
export type TimelineViewport = {
  followingOutput: boolean;
  unreadOutput: number;
  /** 「最新」入口是否显示：有未读输出，或已离开跟随、离底部超过一屏且滚动已停下。 */
  latestEntryVisible: boolean;
  messageListRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  receiveRealtimeOutput: (groupKey: string) => void;
  handleScroll: (nearBottom: boolean) => void;
  showLatest: () => void;
  captureOwnSend: () => OwnSendCapture | null;
  /** 当前是否仍在跟随最新输出且未因阅读详情暂停；回调中读取协调器的即时状态，不等 React 提交。 */
  followingNow: () => boolean;
  followOwnSend: (capture: OwnSendCapture | null) => void;
  reset: () => void;
  setReadingDetails: (reading: boolean) => void;
  prepareHistoryPrepend: () => void;
  captureSessionPosition: () => TimelineSessionPosition | null;
  restoreSessionPosition: (position: TimelineSessionPosition | null) => void;
  /** 等触摸、惯性与回弹结束后执行会改动滚动几何的工作；返回取消函数。 */
  whenScrollIdle: (run: () => void) => () => void;
};

/** React 仅订阅 UI、注册浏览器事件并报告布局；不持有过程或滚动控制权。 */
export function useTimelineViewport(items?: readonly TimelineViewItem[], enabled = true): TimelineViewport {
  const [ui, setUi] = useState({ followingOutput: true, unreadOutput: 0 });
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(enabled);
  const layoutRef = useRef<TimelineViewportLayout | null>(null);
  const observersRef = useRef<TimelineViewportObservers | null>(null);
  const commitRef = useRef<{ items: typeof items; enabled: boolean; layout: TimelineViewportLayout | null } | null>(null);
  const [core] = useState(() => new TimelineViewportCoordinator<OwnSendLayoutCapture, TimelineViewportAnchor>({
    now: () => performance.now(), request: (callback) => requestAnimationFrame(callback), cancel: (frame) => cancelAnimationFrame(frame),
  }, (state) => setUi((previous) => previous.followingOutput === state.following && previous.unreadOutput === state.unread
    ? previous : { followingOutput: state.following, unreadOutput: state.unread })));
  const [idleGate] = useState(() => new ScrollIdleGate({
    now: () => performance.now(), setTimeout: (run, ms) => window.setTimeout(run, ms), clearTimeout: (id) => window.clearTimeout(id),
  }));
  const [latestDistant, setLatestDistant] = useState(false);
  const [latestEntry] = useState(() => new LatestEntryVisibility({
    now: () => performance.now(), setTimeout: (run, ms) => window.setTimeout(run, ms), clearTimeout: (id) => window.clearTimeout(id),
  }, setLatestDistant));

  useLayoutEffect(() => {
    core.setDiagnostics((entry) => recordViewportDiagnostic(entry, () => layoutRef.current?.diagnosticGeometry() ?? null),
      () => layoutRef.current !== null && viewportDiagnosticsEnabled(),
      () => layoutRef.current !== null && viewportDiagnosticSamplingEnabled());
  }, [core]);

  const bind = useCallback(() => {
    const list = enabledRef.current ? messageListRef.current : null;
    if (layoutRef.current?.list === list) return;
    observersRef.current?.disconnect();
    observersRef.current = null;
    // 换绑后旧列表的触摸不会再收到抬起事件；新列表的入口按新的滚动重新判断。
    idleGate.touch(false);
    latestEntry.touch(false);
    latestEntry.hide();
    clearViewportDiagnostics();
    const layout = list ? new TimelineViewportLayout(list) : null;
    layoutRef.current = layout;
    core.bind(layout);
    if (!list || !layout) return;
    const valid = () => enabledRef.current && messageListRef.current === list && layoutRef.current === layout;
    observersRef.current = new TimelineViewportObservers(list, {
      geometry: (activity) => { if (valid()) core.notify(activity ? "activity" : "geometry"); },
      resize: () => { if (valid()) core.notify("resize"); },
      interrupt: () => { if (valid()) core.interrupt(); },
      input: () => { if (valid()) core.input(); },
      engage: () => { if (valid()) core.engage(); },
      touch: (active) => { if (!valid()) return; idleGate.touch(active); latestEntry.touch(active); },
    });
  }, [core, idleGate, latestEntry]);

  // RefObject 的 current 变化不触发依赖比较；即使 items 未变，DOM 替换也必须在绘制前换绑。
  // 普通 UI 重渲染只比较身份，不重复提交内容或重新测量。
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    bind();
    const previous = commitRef.current;
    const layout = layoutRef.current;
    if (previous?.layout === layout && previous.enabled === enabled && previous.items === items) return;
    commitRef.current = { items, enabled, layout };
    observersRef.current?.refresh();
    if (enabled) core.notify("commit", Boolean(items?.length));
  });

  useEffect(() => {
    const clearDiagnostics = installViewportDiagnostics();
    const settle = () => { bind(); core.settle("viewport-resize"); };
    const pagehide = () => viewportDiagnosticCapture.terminate();
    const visibility = () => { if (document.hidden) { pagehide(); bind(); core.settle("hidden"); } };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => { if (motion.matches) { bind(); core.settle("reduce"); } };
    window.addEventListener("resize", settle);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    motion.addEventListener("change", reduce);
    return () => {
      observersRef.current?.disconnect();
      observersRef.current = null;
      layoutRef.current = null;
      core.bind(null);
      idleGate.dispose();
      latestEntry.dispose();
      clearDiagnostics();
      window.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      motion.removeEventListener("change", reduce);
    };
  }, [bind, core, idleGate, latestEntry]);

  const receiveRealtimeOutput = useCallback((key: string) => { bind(); core.output(key); }, [bind, core]);
  const handleScroll = useCallback((nearBottom: boolean) => {
    bind();
    idleGate.scrolled();
    core.scroll(nearBottom);
    const list = layoutRef.current?.list;
    if (list) latestEntry.scrolled(list.scrollHeight - list.scrollTop - list.clientHeight, list.clientHeight);
  }, [bind, core, idleGate, latestEntry]);
  const showLatest = useCallback(() => { bind(); core.latest(); }, [bind, core]);
  const captureOwnSend = useCallback(() => { bind(); return core.captureOwnSend(); }, [bind, core]);
  const followingNow = useCallback(() => core.state.following && !core.state.paused, [core]);
  const followOwnSend = useCallback((capture: OwnSendCapture | null) => { bind(); core.followOwnSend(capture); }, [bind, core]);
  const reset = useCallback(() => { bind(); core.reset(); latestEntry.hide(); }, [bind, core, latestEntry]);
  const setReadingDetails = useCallback((reading: boolean) => { bind(); core.details(reading); }, [bind, core]);
  const prepareHistoryPrepend = useCallback(() => { bind(); core.historyPrepend(); }, [bind, core]);
  const captureSessionPosition = useCallback(() => { bind(); return core.capturePosition(); }, [bind, core]);
  const restoreSessionPosition = useCallback((position: TimelineSessionPosition | null) => { bind(); core.restorePosition(position); }, [bind, core]);
  const whenScrollIdle = useCallback((run: () => void) => idleGate.defer(run), [idleGate]);

  const latestEntryVisible = ui.unreadOutput > 0 || (!ui.followingOutput && latestDistant);
  return { ...ui, latestEntryVisible, messageListRef, bottomSentinelRef, receiveRealtimeOutput, handleScroll, showLatest, captureOwnSend,
    followingNow, followOwnSend, reset, setReadingDetails, prepareHistoryPrepend, captureSessionPosition, restoreSessionPosition, whenScrollIdle };
}
