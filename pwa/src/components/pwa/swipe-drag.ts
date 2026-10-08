import { pwaStandardEasing } from "./use-pwa-motion";

/** 存续期间标记在目标元素上，样式表据此关闭 CSS 过渡，使 WAAPI 动画不被 Mantine 的过渡盖过。 */
export const SWIPE_DRAG_ACTIVE_ATTRIBUTE = "data-swipe-drag-active";

/** 暂停动画的虚拟时长；currentTime = progress × 该值，线性映射不受曲线影响。 */
const DRAG_SPAN_MS = 1000;
const SETTLE_MIN_MS = 80;
const SETTLE_MIN_VELOCITY = 0.3;

export type SwipeDragTarget = {
  element: HTMLElement;
  /** progress 0 为手势起点，1 为终点；拖动与收尾都从它取值，故收尾可从任意位置起步。 */
  frame: (progress: number) => Keyframe;
};

type SwipeDragOptions = {
  targets: SwipeDragTarget[];
  /** 全程位移像素，取目标元素的实际宽度。 */
  extent: () => number;
  /** 全程时长 token（毫秒）。 */
  duration: () => number;
};

export type SwipeDrag = {
  setDistance(px: number): void;
  /** toEnd 只表示 keyframes 的终点或起点；被 dispose 或新的 settle 中止时 resolve(false)，不抛出。 */
  settle(toEnd: boolean, velocity?: number): Promise<boolean>;
  settling(): boolean;
  progress(): number;
  dispose(): void;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function settleDuration(remaining: number, velocity: number, full: number): number {
  return Math.min(full, Math.max(SETTLE_MIN_MS, remaining / Math.max(velocity, SETTLE_MIN_VELOCITY)));
}

export function createSwipeDrag({ targets, extent, duration }: SwipeDragOptions): SwipeDrag {
  targets.forEach(({ element }) => element.setAttribute(SWIPE_DRAG_ACTIVE_ATTRIBUTE, ""));
  let animations = targets.map(({ element, frame }) => element.animate([frame(0), frame(1)], { duration: DRAG_SPAN_MS, easing: "linear", fill: "both" }));
  animations.forEach((animation) => animation.pause());
  let progress = 0;
  let token = 0;
  let settling = false;
  let disposed = false;
  let abort: (() => void) | null = null;
  let settleTarget = 0;

  const setProgress = (value: number) => {
    progress = value;
    animations.forEach((animation) => { animation.currentTime = value * DRAG_SPAN_MS; });
  };
  const readProgress = () => {
    if (!settling || !animations[0]) return progress;
    // 收尾动画的 timing.progress 已含曲线，直接还原成整体进度。
    const eased = animations[0].effect?.getComputedTiming().progress;
    return typeof eased === "number" ? progress + (settleTarget - progress) * eased : progress;
  };
  return {
    setDistance(px) {
      if (disposed || settling) return;
      const width = extent();
      setProgress(width > 0 ? clamp(px / width, 0, 1) : 0);
    },
    settle(toEnd, velocity = 0) {
      if (disposed) return Promise.resolve(false);
      abort?.();
      const from = readProgress();
      const to = toEnd ? 1 : 0;
      const run = ++token;
      progress = from;
      settleTarget = to;
      settling = true;
      const easing = pwaStandardEasing(targets[0].element);
      const time = settleDuration(Math.abs(to - from) * extent(), velocity, duration());
      animations.forEach((animation) => animation.cancel());
      animations = targets.map(({ element, frame }) => element.animate([frame(from), frame(to)], { duration: time, easing, fill: "forwards" }));
      const current = animations;
      return new Promise<boolean>((resolve) => {
        abort = () => resolve(false);
        Promise.all(current.map((animation) => animation.finished)).then(
          () => { if (token === run && !disposed) { abort = null; resolve(true); } else resolve(false); },
          () => resolve(false),
        );
      });
    },
    settling: () => settling,
    progress: readProgress,
    dispose() {
      if (disposed) return;
      disposed = true;
      token += 1;
      abort?.();
      abort = null;
      animations.forEach((animation) => animation.cancel());
      targets.forEach(({ element }) => element.removeAttribute(SWIPE_DRAG_ACTIVE_ATTRIBUTE));
    },
  };
}
