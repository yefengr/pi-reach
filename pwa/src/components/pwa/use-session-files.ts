import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import type { TimelineRuntime, TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { usePublishedFiles } from "@/lib/pwa/use-published-files";
import { publishedFilesView } from "./published-files-bridge";

type Options = {
  ready: boolean;
  items: readonly TimelineViewItem[];
  runtimeRef: { current: TimelineRuntime };
  channelRef: { current: PeerChannel | null };
  setReading: (reading: boolean) => void;
};

/** 获取门禁跟随正式历史同步；设置页/普通 leaf 推进不构成目标切换。 */
export function useSessionFiles({ ready, items, runtimeRef, channelRef, setReading }: Options) {
  const { controller, state } = usePublishedFiles();
  const readyRef = useRef(false);
  const readingSources = useRef({ tools: false, files: false });
  const mountGeneration = useRef(0);
  const onToolReading = useCallback((reading: boolean) => {
    readingSources.current.tools = reading;
    setReading(reading || readingSources.current.files);
  }, [setReading]);
  const onFileReading = useCallback((reading: boolean) => {
    readingSources.current.files = reading;
    setReading(reading || readingSources.current.tools);
  }, [setReading]);
  const view = useMemo(() => {
    // 保留 active getter；对象展开会把它变成旧 render 的快照。
    const next = publishedFilesView(controller, state, ready);
    next.onReadingChange = onFileReading;
    return next;
  }, [controller, state, ready, onFileReading]);
  const disposeIfUnmounted = useCallback((generation: number) => {
    queueMicrotask(() => { if (mountGeneration.current === generation) controller.dispose(); });
  }, [controller]);

  useLayoutEffect(() => {
    const scope = runtimeRef.current.currentScope;
    const channel = channelRef.current;
    readyRef.current = ready && !!scope && !!channel && !channel.closed && !runtimeRef.current.replacing;
    if (!readyRef.current || !scope || !channel) { controller.disconnect(); return; }
    controller.connect(scope, (frame) => {
      if (channelRef.current !== channel || channel.closed || (frame.type !== "file_close" && !readyRef.current)) throw new Error("disconnected");
      if (!channel.send(frame)) throw new Error("disconnected");
    });
  }, [controller, ready, items, runtimeRef, channelRef]);

  useEffect(() => {
    const generation = ++mountGeneration.current;
    const onPageHide = () => { controller.disconnect(); readyRef.current = false; };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      controller.disconnect();
      readyRef.current = false;
      // StrictMode 的同步 cleanup/setup 重放不应永久 dispose 仍被复用的 controller。
      disposeIfUnmounted(generation);
    };
  }, [controller, disposeIfUnmounted]);
  return { controller, readyRef, view, onToolReading };
}
