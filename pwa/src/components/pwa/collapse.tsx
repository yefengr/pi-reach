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
  /** 本次收起由系统自动触发：改用 collapse-settle，内容淡出与高度收拢同步放缓。只在 open 转为 false 的那次提交读取。 */
  settle?: boolean;
  children: ReactNode;
};

/**
 * 手动展开／收起的高度伸缩：进入 180ms、退出 140ms，内容略微位移并淡入淡出。
 * - 只在 open 变化时播放；已展开内容的流式增长直接跟随，不重播动画。
 * - 退出期间内容 inert，并冻结为收起前最后一次展开时呈现的内容：与收起同一提交到达的变化（如思考结束后标题回到明细）
 *   不在退出中出现，新到的输出也不再渲染。
 * - 退出动画结束后卸载；过渡结束事件缺失时以时长加 50ms 兜底。中途反向时从当前位置继续。
 * - 自动收起（settle）以 260ms 播放：透明度与高度同用对称曲线，内容边淡出边被收拢的高度裁切，不留空白。
 * 减少动态效果由全局规则处理：高度与位移不过渡，只保留透明度淡化。
 */
export function Collapse({ open, id, className, onPresentationChange, settle = false, children }: CollapseProps) {
  const standardExit = usePwaMotionDuration("--pwa-duration-collapse-out");
  const settleExit = usePwaMotionDuration("--pwa-duration-collapse-settle");
  const [previousOpen, setPreviousOpen] = useState(open);
  const [entered, setEntered] = useState(open);
  const [exiting, setExiting] = useState(false);
  const [settling, setSettling] = useState(false);
  // 最近一次展开时呈现的内容；收起后不再更新，作为退出期间的冻结内容。
  const [shown, setShown] = useState<ReactNode>(children);
  if (open && shown !== children) setShown(children);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    // 退出中重开直接反向；只有从已卸载状态打开才需要先提交收起帧。
    setEntered(open && exiting);
    setExiting(!open);
    setSettling(!open && settle);
  }
  const exitDuration = settling ? settleExit : standardExit;

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
    data-exit={!open && settling ? "settle" : undefined}
    inert={!open || undefined}
    onTransitionEnd={finishExit}
  >
    <div className="pwa-collapse-inner">{open ? children : shown}</div>
  </div>;
}
