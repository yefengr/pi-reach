import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TimelineViewItem } from "./timeline-runtime";
import type { OwnSendLayoutCapture } from "./own-send-transition";
import type { TimelineViewportAnchor } from "./timeline-viewport-anchor";
import { TimelineViewportCoordinator, type ViewportCapture, type ViewportPosition } from "./timeline-viewport-coordinator";
import { TimelineViewportLayout } from "./timeline-viewport-layout";
import { TimelineViewportObservers } from "./timeline-viewport-observers";
import { clearViewportDiagnostics, installViewportDiagnostics, recordViewportDiagnostic, viewportDiagnosticsEnabled } from "./timeline-viewport-diagnostics";

export { TIMELINE_GEOMETRY_EVENT } from "./timeline-viewport-observers";
/** 离开会话时的位置；只有调用方确认的相同 scope 可显式迁移恢复。 */
export type TimelineSessionPosition = ViewportPosition<TimelineViewportAnchor>;
export type OwnSendCapture = ViewportCapture<OwnSendLayoutCapture>;
export type TimelineViewport = {
  followingOutput: boolean;
  unreadOutput: number;
  messageListRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  receiveRealtimeOutput: (groupKey: string) => void;
  handleScroll: (nearBottom: boolean) => void;
  showLatest: () => void;
  captureOwnSend: () => OwnSendCapture | null;
  followOwnSend: (capture: OwnSendCapture | null) => void;
  reset: () => void;
  setReadingDetails: (reading: boolean) => void;
  prepareHistoryPrepend: () => void;
  captureSessionPosition: () => TimelineSessionPosition | null;
  restoreSessionPosition: (position: TimelineSessionPosition | null) => void;
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

  useLayoutEffect(() => {
    core.setDiagnostics((entry) => recordViewportDiagnostic(entry, () => layoutRef.current?.diagnosticGeometry() ?? null),
      () => layoutRef.current !== null && viewportDiagnosticsEnabled());
  }, [core]);

  const bind = useCallback(() => {
    const list = enabledRef.current ? messageListRef.current : null;
    if (layoutRef.current?.list === list) return;
    observersRef.current?.disconnect();
    observersRef.current = null;
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
    });
  }, [core]);

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
    const visibility = () => { if (document.hidden) { bind(); core.settle("hidden"); } };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => { if (motion.matches) { bind(); core.settle("reduce"); } };
    window.addEventListener("resize", settle);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", reduce);
    return () => {
      observersRef.current?.disconnect();
      observersRef.current = null;
      layoutRef.current = null;
      core.bind(null);
      clearDiagnostics();
      window.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", reduce);
    };
  }, [bind, core]);

  const receiveRealtimeOutput = useCallback((key: string) => { bind(); core.output(key); }, [bind, core]);
  const handleScroll = useCallback((nearBottom: boolean) => { bind(); core.scroll(nearBottom); }, [bind, core]);
  const showLatest = useCallback(() => { bind(); core.latest(); }, [bind, core]);
  const captureOwnSend = useCallback(() => { bind(); return core.captureOwnSend(); }, [bind, core]);
  const followOwnSend = useCallback((capture: OwnSendCapture | null) => { bind(); core.followOwnSend(capture); }, [bind, core]);
  const reset = useCallback(() => { bind(); core.reset(); }, [bind, core]);
  const setReadingDetails = useCallback((reading: boolean) => { bind(); core.details(reading); }, [bind, core]);
  const prepareHistoryPrepend = useCallback(() => { bind(); core.historyPrepend(); }, [bind, core]);
  const captureSessionPosition = useCallback(() => { bind(); return core.capturePosition(); }, [bind, core]);
  const restoreSessionPosition = useCallback((position: TimelineSessionPosition | null) => { bind(); core.restorePosition(position); }, [bind, core]);

  return { ...ui, messageListRef, bottomSentinelRef, receiveRealtimeOutput, handleScroll, showLatest, captureOwnSend,
    followOwnSend, reset, setReadingDetails, prepareHistoryPrepend, captureSessionPosition, restoreSessionPosition };
}
