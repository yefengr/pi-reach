import { Component, useCallback, useLayoutEffect, useRef, type ReactElement, type RefObject } from "react";
import { pwaContentEasing, pwaMotionShiftDisabled, usePwaMotionDuration } from "./use-pwa-motion";

/** 参与补位的元素标记；值为条目标识。脱离布局的离开项（data-detached）不参与。 */
export const FLIP_KEY_ATTRIBUTE = "data-flip-key";
const FLIP_ITEMS = `[${FLIP_KEY_ATTRIBUTE}]`;
/** 小于半像素的差异是亚像素取整，不播放。 */
const FLIP_MIN_DELTA_PX = 0.5;

type Point = { x: number; y: number };
type Snapshot = { keys: string; boxes: Map<string, Point>; top: number };

const flipItems = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FLIP_ITEMS)].filter((item) => item.dataset.detached === undefined);
const flipKeys = (items: HTMLElement[]) => items.map((item) => item.getAttribute(FLIP_KEY_ATTRIBUTE)).join("\n");

/**
 * 在 React 改动 DOM 之前取旧位置。函数组件没有变更前的入口，只有类组件的 getSnapshotBeforeUpdate 在同一次提交的
 * 全部 DOM 变更之前执行；它随所在列表组件的每次渲染更新，本身不渲染任何内容。
 */
class FlipCapture extends Component<{ capture: () => void }> {
  getSnapshotBeforeUpdate() {
    this.props.capture();
    return null;
  }
  // React 要求与 getSnapshotBeforeUpdate 成对定义。
  componentDidUpdate() {}
  render() { return null; }
}

/**
 * 短列表增删时其余项平滑补位（DESIGN「输入区内的增减」）：每次提交在 DOM 变更前记下带 data-flip-key 的元素此刻的
 * 视口位置，变更后条目集合有变化时以位移动画从旧位置滑到新位置（reorder、内容曲线）。旧位置取自变更前的那一刻，
 * 列表被周围布局带着移动（展开动画、键盘、滚动）也不会过期；在途的补位按当前绘制位置接续。条目不变的提交不播放，
 * 避免折叠展开、流式重渲染等其他布局变化被当成补位。edge 用于贴着下沿向上长的面板（排队抽屉）：
 * 上沿随之过渡，收缩时以上内边距、增长时以裁切从旧上沿走到新上沿。减少动态效果时一次到位。
 * 返回值须渲染在列表组件的输出中（位置不限），否则取不到旧位置、不播放。
 */
export function useFlipLayout(rootRef: RefObject<HTMLElement | null>, { edge = false }: { edge?: boolean } = {}): ReactElement {
  const duration = usePwaMotionDuration("--pwa-duration-reorder");
  const beforeRef = useRef<Snapshot | null>(null);
  const runningRef = useRef(new Map<Element, Animation>());
  const edgeRef = useRef<Animation | null>(null);

  const capture = useCallback(() => {
    const root = rootRef.current;
    if (!root) { beforeRef.current = null; return; }
    const items = flipItems(root);
    const boxes = new Map<string, Point>();
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      boxes.set(item.getAttribute(FLIP_KEY_ATTRIBUTE) ?? "", { x: rect.left, y: rect.top });
    }
    beforeRef.current = { keys: flipKeys(items), boxes, top: root.getBoundingClientRect().top };
  }, [rootRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const before = beforeRef.current;
    beforeRef.current = null;
    if (!root || !before || typeof root.animate !== "function") return;
    const items = flipItems(root);
    if (before.keys === flipKeys(items) || pwaMotionShiftDisabled(root)) return;
    const running = runningRef.current;
    const easing = pwaContentEasing(root);
    // 旧位置已含在途补位的位移；先撤销旧动画，再统一量新布局，避免逐项读写交错。
    items.forEach((item) => { running.get(item)?.cancel(); running.delete(item); });
    edgeRef.current?.cancel();
    edgeRef.current = null;
    const rects = items.map((item) => item.getBoundingClientRect());
    const top = root.getBoundingClientRect().top;
    items.forEach((item, index) => {
      const start = before.boxes.get(item.getAttribute(FLIP_KEY_ATTRIBUTE) ?? "");
      if (!start) return;
      const dx = start.x - rects[index].left;
      const dy = start.y - rects[index].top;
      if (Math.abs(dx) < FLIP_MIN_DELTA_PX && Math.abs(dy) < FLIP_MIN_DELTA_PX) return;
      const animation = item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing });
      running.set(item, animation);
      animation.onfinish = () => { if (running.get(item) === animation) running.delete(item); };
    });
    const shift = top - before.top;
    if (edge && Math.abs(shift) >= FLIP_MIN_DELTA_PX) {
      const style = getComputedStyle(root);
      // 贴下沿的面板：加回上内边距让上沿停在原处、内容不动，再收回；增长时裁掉新露出的部分再展开。
      edgeRef.current = shift > 0
        ? root.animate([{ paddingTop: `calc(${style.paddingTop} + ${shift}px)` }, { paddingTop: style.paddingTop }], { duration, easing })
        : root.animate([{ clipPath: `inset(${-shift}px 0 0 0 round ${style.borderTopLeftRadius})` }, { clipPath: `inset(0 0 0 0 round ${style.borderTopLeftRadius})` }], { duration, easing });
    }
  });

  useLayoutEffect(() => () => {
    runningRef.current.forEach((animation) => animation.cancel());
    runningRef.current.clear();
    edgeRef.current?.cancel();
  }, []);

  return <FlipCapture capture={capture} />;
}
