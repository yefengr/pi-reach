import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

type Indicator = { node: SVGSVGElement; keys: readonly string[] };
type RegisterIndicator = (slot: string, node: SVGSVGElement | null, keys: readonly string[]) => void;
export type RunningToolsChange = (groupKey: string, keys: readonly string[] | null) => void;

export const ToolIndicatorContext = createContext<RegisterIndicator | null>(null);

/** 工具身份来自渲染参数；DOM 只用于判断已注册图标是否真的被画出，不推断执行状态。 */
export function useToolIndicatorRef(keys: readonly string[]) {
  const register = useContext(ToolIndicatorContext);
  const slot = useId();
  const identity = JSON.stringify(keys);
  return useCallback((node: SVGSVGElement | null) => {
    register?.(slot, node, JSON.parse(identity) as string[]);
  }, [identity, register, slot]);
}

/** 折叠高度、透明度和内层裁剪都可能使已经挂载的图标暂不可见。 */
function indicatorVisible(node: SVGSVGElement, group: HTMLElement): boolean {
  if (!node.isConnected) return false;
  const rect = node.getBoundingClientRect();
  let { left, right, top, bottom } = rect;
  if (right <= left || bottom <= top) return false;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
    const clip = parent.getBoundingClientRect();
    if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
    if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    if (right <= left || bottom <= top) return false;
    if (parent === group) break;
  }
  return true;
}

function hasPresentationMotion(group: HTMLElement): boolean {
  return group.getAnimations({ subtree: true }).some(animation =>
    Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)
    && (animation.playState === "running" || animation.pending));
}

/** 只在有限的呈现过渡内逐帧观察；转圈自身的无限动画不会启动持续轮询。 */
export function useVisibleToolIndicators(activityKey: string | undefined, onChange: RunningToolsChange | undefined) {
  const groupRef = useRef<HTMLElement>(null);
  const indicators = useRef(new Map<string, Indicator>());
  const frame = useRef<number | null>(null);
  const register = useCallback<RegisterIndicator>((slot, node, keys) => {
    if (node === null) indicators.current.delete(slot);
    else indicators.current.set(slot, { node, keys });
  }, []);

  const observe = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (activityKey === undefined || onChange === undefined) return;
    const measure = () => {
      const group = groupRef.current;
      const visible = new Set<string>();
      if (group) for (const { node, keys } of indicators.current.values()) {
        if (indicatorVisible(node, group)) for (const key of keys) visible.add(key);
      }
      onChange(activityKey, [...visible].sort());
    };
    const sample = () => {
      frame.current = null;
      // rAF 中同步提交交接结果，不能让 React 把 Working 的更新延到下一次绘制。
      flushSync(measure);
      if (groupRef.current && hasPresentationMotion(groupRef.current)) frame.current = requestAnimationFrame(sample);
    };
    measure();
    if (groupRef.current && hasPresentationMotion(groupRef.current)) frame.current = requestAnimationFrame(sample);
  }, [activityKey, onChange]);

  useLayoutEffect(observe);
  useLayoutEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (activityKey !== undefined) onChange?.(activityKey, null);
  }, [activityKey, onChange]);
  return { groupRef, register, observe };
}
