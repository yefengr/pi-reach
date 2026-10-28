import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { readPwaMotionDuration } from "@/lib/ui/motion-duration";
import { pwaStandardEasing } from "@/lib/ui/motion";
import { STREAM_REVEAL_CLASS } from "@/lib/pwa/markdown-stream";

const NO_MARKS: readonly number[] = [];
/**
 * 最多保留的新显示片段。显示提交至少间隔 16ms，被挤出的片段已超过内容淡入时长（240ms）；
 * 渲染期间不读取时钟，只按片段数裁剪。
 */
const REVEAL_MARK_LIMIT = 16;

/** 流式追加时记录每次新显示文字的起点；替换或停止流式时不再新增。 */
export function useStreamRevealMarks(text: string, streaming: boolean): readonly number[] {
  const [state, setState] = useState<{ text: string; marks: readonly number[] }>(() => ({ text, marks: NO_MARKS }));
  if (state.text === text) return state.marks;
  const extendsShown = text.startsWith(state.text);
  const marks = !extendsShown
    ? NO_MARKS
    : streaming && text.length > state.text.length
      ? [...state.marks, state.text.length].slice(-REVEAL_MARK_LIMIT)
      : state.marks;
  setState({ text, marks });
  return marks;
}

/**
 * 提交后为新出现的片段播放淡入。起始时间按片段首次提交的时刻固定，
 * 后续渲染重建或复用 span 都从同一进度继续，不重播。
 */
export function useStreamRevealAnimation(root: RefObject<HTMLElement | null>, marks: readonly number[]): void {
  const starts = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const element = root.current;
    const known = starts.current;
    for (const mark of known.keys()) if (!marks.includes(mark)) known.delete(mark);
    if (!element || marks.length === 0) return;
    const now = document.timeline?.currentTime;
    const time = typeof now === "number" ? now : performance.now();
    for (const mark of marks) if (!known.has(mark)) known.set(mark, time);
    const spans = element.querySelectorAll<HTMLElement>(`.${STREAM_REVEAL_CLASS}`);
    if (spans.length === 0 || typeof spans[0].animate !== "function") return;
    const duration = readPwaMotionDuration("--pwa-duration-content");
    const easing = pwaStandardEasing(element);
    for (const span of spans) {
      const start = known.get(Number(span.dataset.revealOffset));
      if (start === undefined) continue;
      const [running] = span.getAnimations();
      if (running) {
        if (running.startTime !== start) running.startTime = start;
        continue;
      }
      const animation = span.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
      animation.startTime = start;
    }
  }, [root, marks]);
}
