import { useCallback, useLayoutEffect, type RefObject } from "react";
import { TIMELINE_GEOMETRY_EVENT } from "@/lib/pwa/use-timeline-viewport";

const MAX_VISUAL_LINES = 6;
const MIN_INPUT_HEIGHT = 44;
const COMPACT_READING_PADDING = 8;
const LAYOUT_EPSILON = 1;
const pixels = (value: string) => Number.parseFloat(value) || 0;

function availableInputHeight(input: HTMLTextAreaElement, sixLines: number) {
  const main = input.closest<HTMLElement>(".pwa-main");
  const list = main?.querySelector<HTMLElement>(".pwa-message-list");
  const footer = input.closest<HTMLElement>(".pwa-chat-footer");
  if (!main || !list || !footer) return sixLines;

  const listStyle = getComputedStyle(list);
  const bodyLine = pixels(listStyle.getPropertyValue("--pwa-text-body")) * pixels(listStyle.getPropertyValue("--pwa-leading-body"));
  const latest = footer.querySelector<HTMLElement>(".pwa-message-actions");
  const latestHeight = latest?.getBoundingClientRect().height ?? 0;
  const compactReadingSpace = Math.ceil(bodyLine + 2 * COMPACT_READING_PADDING + latestHeight);
  const normalReadingSpace = bodyLine + pixels(listStyle.getPropertyValue("--pwa-timeline-pad-top")) + pixels(listStyle.getPropertyValue("--pwa-timeline-pad-bottom")) + latestHeight;
  // 从真实布局扣除顶栏/通知及 footer 的非文字高度，附件与队列变化自然计入预算。
  const footerChrome = footer.getBoundingClientRect().height - input.getBoundingClientRect().height;
  const space = main.getBoundingClientRect().bottom - list.getBoundingClientRect().top - footerChrome;
  const compact = space - sixLines < normalReadingSpace;
  const available = space - (compact ? compactReadingSpace : normalReadingSpace);
  const budget = available < MIN_INPUT_HEIGHT - LAYOUT_EPSILON ? "conflict" : compact ? "constrained" : null;
  const previousBudget = main.dataset.composerBudget ?? null;
  if (budget) main.dataset.composerBudget = budget;
  else delete main.dataset.composerBudget;
  // 预算切换会改变消息区内边距（尺寸不变，ResizeObserver 不触发），需通知时间线重新贴底或恢复锚点。
  if ((previousBudget === null) !== (budget === null)) list.dispatchEvent(new Event(TIMELINE_GEOMETRY_EVENT));
  return Math.max(MIN_INPUT_HEIGHT, Math.min(sixLines, available));
}

function contentHeight(input: HTMLTextAreaElement) {
  // 不能把真实 textarea 临时归零：消息区会瞬间变高，浏览器钳制 scrollTop 后会被误判为用户回看。
  const measure = input.cloneNode() as HTMLTextAreaElement;
  measure.removeAttribute("id");
  measure.removeAttribute("name");
  measure.setAttribute("aria-hidden", "true");
  measure.inert = true;
  measure.value = input.value;
  Object.assign(measure.style, {
    position: "absolute", visibility: "hidden", pointerEvents: "none", top: "0", left: "0",
    width: `${input.getBoundingClientRect().width}px`, height: "0", minHeight: "0", maxHeight: "none", overflowY: "hidden",
  });
  input.parentElement!.append(measure);
  const height = measure.scrollHeight;
  measure.remove();
  return height;
}

/** 按实际视觉行增长；读高度不写 scrollTop，由 useTimelineViewport 维持贴底或阅读锚点。 */
export function useComposerAutosize(inputRef: RefObject<HTMLTextAreaElement | null>) {
  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input || input.getBoundingClientRect().width === 0) return;
    const style = getComputedStyle(input);
    const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
    const border = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
    const sixLines = MAX_VISUAL_LINES * pixels(style.lineHeight) + padding + border;
    const maximum = availableInputHeight(input, sixLines);
    const needed = contentHeight(input) + border;
    input.style.maxHeight = `${maximum}px`;
    const height = Math.max(MIN_INPUT_HEIGHT, Math.min(needed, maximum));
    input.style.height = `${height}px`;
    input.style.overflowY = needed > height + LAYOUT_EPSILON ? "auto" : "hidden";
  }, [inputRef]);

  // 草稿、附件、队列均可能由本次 render 改变；布局提交后统一测量，不依赖换行符数量。
  useLayoutEffect(() => { resize(); });
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; resize(); });
    };
    const observer = new ResizeObserver(schedule);
    const main = input.closest<HTMLElement>(".pwa-main");
    const footer = input.closest<HTMLElement>(".pwa-chat-footer");
    for (const element of [input, main, footer]) if (element) observer.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (main) delete main.dataset.composerBudget;
    };
  }, [inputRef, resize]);
}
