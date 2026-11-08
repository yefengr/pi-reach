import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useToolDetailsView } from "@/components/pwa/tool-details-context";
import type { ToolValue } from "@/components/pwa/tool-presentation";
import { isToolSummary } from "./tool-details-inline";
import type { ToolDetailsState } from "./tool-details";
const EMPTY: ToolDetailsState = { phase: "idle" };
const noSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
export function useToolDetails(value: ToolValue | null, opened: boolean, sourceKey: string | undefined) {
  const view = useToolDetailsView();
  const controller = view?.controller;
  const snapshot = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const summary = isToolSummary(value) ? value : null;
  const targetKey = summary ? JSON.stringify([summary.session_id, summary.group_id, summary.tool_ref, summary.tool]) : null;
  const scopeKey = view?.scope ? JSON.stringify(view.scope) : null;
  const matchingSource = view !== null && view.sourceKey === sourceKey;
  const identityKey = JSON.stringify([scopeKey, targetKey, sourceKey]);
  const key = JSON.stringify([scopeKey, targetKey, sourceKey, view?.online]);
  const latest = useRef({ view, summary });
  const active = useRef<{ key: string; open: () => void } | null>(null);
  useLayoutEffect(() => { latest.current = { view, summary }; });
  useLayoutEffect(() => {
    const { view: currentView, summary: current } = latest.current;
    if (!opened || !controller || !matchingSource || !currentView?.scope || !current || current.session_id !== currentView.scope.sessionId) return;
    const owner = { key, open: () => {
      const { view: present, summary: selected } = latest.current;
      if (active.current !== owner || document.hidden || !present?.scope || !selected || present.sourceKey !== sourceKey || selected.session_id !== present.scope.sessionId) return;
      void controller.open(present.scope, { groupId: selected.group_id, toolRef: selected.tool_ref, tool: selected.tool }, present.online ? present.connection() : null, key);
    } };
    active.current = owner;
    const onVisibility = () => {
      if (active.current !== owner) return;
      if (document.hidden) controller.cancel();
      else owner.open();
    };
    owner.open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (active.current === owner) { active.current = null; controller.cancel(); }
    };
  }, [controller, opened, matchingSource, sourceKey, key]);
  const [exitPresentation, setExitPresentation] = useState<{ key: string; controller: typeof controller; state: ToolDetailsState } | null>(null);
  const retained = summary && matchingSource && exitPresentation?.key === identityKey && exitPresentation.controller === controller ? exitPresentation : null;
  let nextPresentation = retained;
  if (opened && controller && matchingSource && snapshot.key === key && retained?.state !== snapshot) nextPresentation = { key: identityKey, controller, state: snapshot };
  if (nextPresentation !== exitPresentation) setExitPresentation(nextPresentation);
  // 订阅立即取消，展示仅随阅读器退出；连接变化驱动重连，不改变退出快照的身份。
  // 换身份时渲染即隔离，不能等 effect 清理。
  const liveState = matchingSource && snapshot.key === key ? snapshot : EMPTY;
  const state = opened ? liveState : retained?.state ?? EMPTY;
  const content = state.content;
  const rendered: ToolValue | null = content && summary ? {
    ...content, kind: "tool", tool_call_id: content.tool_ref.tool_call_id, session_id: summary.session_id, leaf_id: summary.leaf_id, group_id: summary.group_id,
    status: content.status === "preparing" ? "running" : content.status, truncated: content.limited,
  } : value;
  const cancel = () => { active.current = null; controller?.cancel(); };
  const retry = () => { if (active.current?.key === key) active.current.open(); };
  return { value: rendered, state: summary ? state : EMPTY, pending: summary !== null && !content, cancel, retry };
}
