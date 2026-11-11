import { useLayoutEffect, useRef, type RefObject } from "react";
import { pwaContentEasing, pwaMotionShiftDisabled, usePwaMotionDuration } from "./use-pwa-motion";

/** 参与补位的元素标记；值为条目标识。脱离布局的离开项（data-detached）不参与。 */
export const FLIP_KEY_ATTRIBUTE = "data-flip-key";
const FLIP_ITEMS = `[${FLIP_KEY_ATTRIBUTE}]`;
/** 小于半像素的差异是亚像素取整，不播放。 */
const FLIP_MIN_DELTA_PX = 0.5;

type Point = { x: number; y: number };
type Snapshot = { keys: string; boxes: Map<string, Point>; top: number };

const flipItems = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FLIP_ITEMS)].filter((item) => item.dataset.detached === undefined);

/** 正在补位的元素此刻的位移（动画中的 translate）；布局位置 = 视觉位置减去它。 */
function animatedOffset(item: HTMLElement, running: Map<Element, Animation>): Point {
  const animation = running.get(item);
  if (!animation || animation.playState === "finished") return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(getComputedStyle(item).transform);
  return { x: matrix.m41, y: matrix.m42 };
}

/**
 * 短列表增删时其余项平滑补位（DESIGN「输入区内的增减」）：每次提交后比较带 data-flip-key 的元素与上次的视口位置，
 * 条目集合变化时以位移动画从旧位置滑到新位置（reorder、内容曲线）。条目不变的提交与滚动只刷新记录，不播放，
 * 避免折叠展开、流式重渲染等其他布局变化被当成补位。edge 用于贴着下沿向上长的面板（排队抽屉）：
 * 上沿随之过渡，收缩时以上内边距、增长时以裁切从旧上沿走到新上沿。减少动态效果时一次到位。
 */
export function useFlipLayout(rootRef: RefObject<HTMLElement | null>, { edge = false }: { edge?: boolean } = {}) {
  const duration = usePwaMotionDuration("--pwa-duration-reorder");
  const snapshotRef = useRef<Snapshot | null>(null);
  const runningRef = useRef(new Map<Element, Animation>());
  const edgeRef = useRef<Animation | null>(null);

  const record = (root: HTMLElement, keepTop: number | null): Snapshot => {
    const items = flipItems(root);
    const boxes = new Map<string, Point>();
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const offset = animatedOffset(item, runningRef.current);
      boxes.set(item.getAttribute(FLIP_KEY_ATTRIBUTE) ?? "", { x: rect.left - offset.x, y: rect.top - offset.y });
    }
    return { keys: items.map((item) => item.getAttribute(FLIP_KEY_ATTRIBUTE)).join("\n"), boxes, top: keepTop ?? root.getBoundingClientRect().top };
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    const previous = snapshotRef.current;
    if (!root) { snapshotRef.current = null; return; }
    const items = flipItems(root);
    const keys = items.map((item) => item.getAttribute(FLIP_KEY_ATTRIBUTE)).join("\n");
    if (!previous || previous.keys === keys || typeof root.animate !== "function" || pwaMotionShiftDisabled(root)) {
      // 补位或上沿过渡进行中时保留它们的终点，滚动等刷新不打断。
      snapshotRef.current = record(root, edgeRef.current?.playState === "running" && previous ? previous.top : null);
      return;
    }
    const running = runningRef.current;
    const easing = pwaContentEasing(root);
    // 先取全部旧视觉位置并撤销旧动画，再统一量新布局，避免逐项读写交错。
    const from = items.map((item) => {
      const before = previous.boxes.get(item.getAttribute(FLIP_KEY_ATTRIBUTE) ?? "");
      const offset = animatedOffset(item, running);
      running.get(item)?.cancel();
      running.delete(item);
      return before ? { x: before.x + offset.x, y: before.y + offset.y } : null;
    });
    edgeRef.current?.cancel();
    edgeRef.current = null;
    const rects = items.map((item) => item.getBoundingClientRect());
    const top = root.getBoundingClientRect().top;
    items.forEach((item, index) => {
      const start = from[index];
      if (!start) return;
      const dx = start.x - rects[index].left;
      const dy = start.y - rects[index].top;
      if (Math.abs(dx) < FLIP_MIN_DELTA_PX && Math.abs(dy) < FLIP_MIN_DELTA_PX) return;
      const animation = item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing });
      running.set(item, animation);
      animation.onfinish = () => { if (running.get(item) === animation) running.delete(item); };
    });
    const shift = top - previous.top;
    if (edge && Math.abs(shift) >= FLIP_MIN_DELTA_PX) {
      const style = getComputedStyle(root);
      // 贴下沿的面板：加回上内边距让上沿停在原处、内容不动，再收回；增长时裁掉新露出的部分再展开。
      edgeRef.current = shift > 0
        ? root.animate([{ paddingTop: `calc(${style.paddingTop} + ${shift}px)` }, { paddingTop: style.paddingTop }], { duration, easing })
        : root.animate([{ clipPath: `inset(${-shift}px 0 0 0 round ${style.borderTopLeftRadius})` }, { clipPath: `inset(0 0 0 0 round ${style.borderTopLeftRadius})` }], { duration, easing });
    }
    snapshotRef.current = { keys, boxes: new Map(items.map((item, index) => [item.getAttribute(FLIP_KEY_ATTRIBUTE) ?? "", { x: rects[index].left, y: rects[index].top }])), top };
  });

  // 外层滚动或窗口尺寸变化会移动全部条目；下一帧刷新记录，免得下次增删按过期位置补位。
  useLayoutEffect(() => {
    let frame: number | null = null;
    const refresh = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const root = rootRef.current;
        const previous = snapshotRef.current;
        if (root && previous) snapshotRef.current = record(root, edgeRef.current?.playState === "running" ? previous.top : null);
      });
    };
    window.addEventListener("scroll", refresh, { capture: true, passive: true });
    window.addEventListener("resize", refresh, { passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", refresh, { capture: true });
      window.removeEventListener("resize", refresh);
    };
  }, [rootRef]);

  useLayoutEffect(() => () => {
    runningRef.current.forEach((animation) => animation.cancel());
    runningRef.current.clear();
    edgeRef.current?.cancel();
  }, []);
}
