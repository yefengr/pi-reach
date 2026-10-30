import { useEffect, useLayoutEffect, useState, type ReactNode, type TransitionEvent } from "react";
import { usePwaMotionDuration } from "@/components/pwa/use-pwa-motion";

/** 过渡结束事件缺失时的兜底余量；视口的收起保持期使用同一时限。 */
export const COLLAPSE_EXIT_FALLBACK_MARGIN_MS = 50;

type CollapseProps = {
  open: boolean;
  id?: string;
  className?: string;
  /** 通知呈现目标或挂载状态变化，供运行提示观察实际过渡，不代表内容已经可见。 */
  onPresentationChange?: () => void;
  children: ReactNode;
};

/**
 * 手动展开／收起的高度伸缩：进入 180ms、退出 140ms，内容略微位移并淡入淡出。
 * - 只在 open 变化时播放；已展开内容的流式增长直接跟随，不重播动画。
 * - 退出期间内容 inert，并冻结为收起那一刻的内容，不再渲染新到的输出。
 * - 退出动画结束后卸载；过渡结束事件缺失时以时长加 50ms 兜底。中途反向时从当前位置继续。
 * 减少动态效果由全局规则处理：高度与位移不过渡，只保留透明度淡化。
 */
export function Collapse({ open, id, className, onPresentationChange, children }: CollapseProps) {
  const exitDuration = usePwaMotionDuration("--pwa-duration-collapse-out");
  const [previousOpen, setPreviousOpen] = useState(open);
  const [entered, setEntered] = useState(open);
  const [exiting, setExiting] = useState(false);
  const [frozen, setFrozen] = useState<ReactNode>(null);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    // 退出中重开直接反向；只有从已卸载状态打开才需要先提交收起帧。
    setEntered(open && exiting);
    setExiting(!open);
    if (!open) setFrozen(children);
  }

  useEffect(() => {
    if (!open || entered) return;
    // 先以收起状态提交一帧，再切到展开，浏览器才会播放过渡。
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [entered, open]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => setExiting(false), exitDuration + COLLAPSE_EXIT_FALLBACK_MARGIN_MS);
    return () => window.clearTimeout(timer);
  }, [exiting, exitDuration]);

  useLayoutEffect(() => { onPresentationChange?.(); }, [open, entered, exiting, onPresentationChange]);

  if (!open && !exiting) return null;
  const finishExit = (event: TransitionEvent<HTMLDivElement>) => {
    if (!open && event.target === event.currentTarget && event.propertyName === "opacity") setExiting(false);
  };
  return <div
    id={id}
    className={`pwa-collapse${className ? ` ${className}` : ""}`}
    data-open={open && entered ? "" : undefined}
    inert={!open || undefined}
    onTransitionEnd={finishExit}
  >
    <div className="pwa-collapse-inner">{open ? children : frozen}</div>
  </div>;
}
