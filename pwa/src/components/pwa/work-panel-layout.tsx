import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { TIMELINE_GEOMETRY_EVENT } from "@/lib/pwa/use-timeline-viewport";
import { useWorkPanelWidth, WORK_PANEL_MIN_WIDTH } from "./use-work-panel-width";
import "./work-panel.css";

type WorkPanelContextValue = {
  canSplit: boolean;
  host: HTMLDivElement | null;
  claim: (owner: string, active: boolean) => void;
};
const WorkPanelContext = createContext<WorkPanelContextValue | null>(null);
export const useWorkPanel = () => useContext(WorkPanelContext);

/** 主区测宽与正文列同生命周期；关闭面板不卸载聊天、草稿或时间线。 */
export function WorkPanelLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const panelId = useId();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const { canSplit, width, maximum, dragging, resetWidth, handleProps } = useWorkPanelWidth(element, owner !== null);
  const split = canSplit && owner !== null;
  const claim = useCallback((id: string, active: boolean) => setOwner(current => active ? id : current === id ? null : current), []);
  const value = useMemo(() => ({ canSplit, host, claim }), [canSplit, host, claim]);
  useLayoutEffect(() => {
    // 布局变化也可能只是列内换行，交给现有时间线恢复贴底／阅读锚点。
    element?.querySelector(".pwa-message-list")?.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
  }, [element, split, width]);
  return <WorkPanelContext.Provider value={value}>
    <div ref={setElement} className="pwa-work-panel-layout" data-split={split || undefined} data-resizing={dragging || undefined} style={{ "--pwa-work-panel-width": `${width}px` } as CSSProperties}>
      <div className="pwa-work-panel-conversation">{children}</div>
      <div className="pwa-work-panel-gutter" hidden={!split}>
        <div {...handleProps} className="pwa-work-panel-resize" role="separator" tabIndex={0} aria-label={t.workPanel.resize} aria-orientation="vertical" aria-controls={panelId} aria-valuemin={WORK_PANEL_MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={width} />
      </div>
      <aside id={panelId} className="pwa-work-panel" aria-label={t.workPanel.label} aria-hidden={!split || undefined} inert={!split}>
        <div ref={setHost} className="pwa-work-panel-host" />
        <div className="pwa-work-panel-toolbar"><button type="button" className="pwa-work-panel-reset" onClick={resetWidth}>{t.workPanel.resetWidth}</button></div>
      </aside>
    </div>
  </WorkPanelContext.Provider>;
}
