import { useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "@mantine/hooks";
import { pwaContentEasing, pwaMotionShiftDisabled } from "./use-pwa-motion";

export type ImageBounds = { left: number; top: number; width: number; height: number };
type ImageMotion = { cancel: () => void; bounds: () => ImageBounds | null; readonly active: boolean };

/** object-fit: contain 的绘制边界；只接受已解码且完全位于可用视口/裁剪祖先内的图片。 */
export function publishedImageBounds(image: HTMLImageElement | null, requireVisible = true, ownHidden = false): ImageBounds | null {
  if (!image?.isConnected || !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) return null;
  const box = image.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const ratio = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const width = image.naturalWidth * ratio;
  const height = image.naturalHeight * ratio;
  const bounds = { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  if (!requireVisible) return bounds;
  const viewport = image.ownerDocument.defaultView;
  if (!viewport || bounds.left < 0 || bounds.top < 0 || bounds.left + width > viewport.innerWidth || bounds.top + height > viewport.innerHeight) return null;
  for (let parent: Element | null = image; parent; parent = parent.parentElement) {
    if (parent.matches("[hidden]")) return null;
    const style = getComputedStyle(parent);
    const visibility = style.visibility === "visible" || ownHidden && parent === image && style.visibility === "hidden";
    if (style.display === "none" || !visibility || Number(style.opacity) === 0) return null;
    // 打开时阅读器的遮罩会把背景 inert/aria-hidden；来源几何仍可用，不据 inert 判断错误目标。
    if (parent !== image) {
      const clip = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (bounds.left < clip.left || bounds.left + width > clip.right)) return null;
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (bounds.top < clip.top || bounds.top + height > clip.bottom)) return null;
    }
  }
  return bounds;
}

/** 局部 WAAPI 避免文档级快照冻结 Drawer 两步挂载和既有 history／跟手流程。业务退出不依赖动画 Promise。 */
export function animatePublishedImage({ image, source, sourceUrl, root, direction, duration, from }: {
  image: HTMLImageElement;
  source: HTMLButtonElement | undefined;
  sourceUrl: string;
  root: HTMLElement;
  direction: "in" | "out";
  duration: number;
  from?: ImageBounds | null;
}): ImageMotion | null {
  const thumbnail = source?.querySelector("img") ?? null;
  if (document.hidden || !thumbnail || thumbnail.currentSrc !== sourceUrl || image.currentSrc !== sourceUrl || pwaMotionShiftDisabled(root)) return null;
  if (source?.closest("[data-publication-id]")?.getAttribute("data-publication-id") !== root.dataset.publicationId) return null;
  const small = publishedImageBounds(thumbnail);
  const large = publishedImageBounds(image, false);
  const portal = root.closest<HTMLElement>(".pwa-root");
  if (!small || !large || !portal || typeof image.animate !== "function") return null;
  const sourceBox = thumbnail.getBoundingClientRect();
  const targetBox = root.getBoundingClientRect();
  const clone = image.cloneNode(false) as HTMLImageElement;
  clone.className = "pwa-published-image-transition";
  clone.alt = "";
  clone.setAttribute("aria-hidden", "true");
  // fixed 图片层独立改变几何，不用 scale 连同 8px 圆角一起缩放；反向仍从当前屏幕边界接续。
  const geometry = (bounds: ImageBounds) => ({ left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  Object.assign(clone.style, geometry(large), { transform: "none" });
  const sourceVisibility = thumbnail.style.visibility;
  const targetVisibility = image.style.visibility;
  let animation: Animation | null = null;
  let timer: number | undefined;
  let observer: MutationObserver | undefined;
  let resize: ResizeObserver | undefined;
  let finished = false;
  const hide = () => { if (document.hidden) cleanup(); };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    animation?.cancel();
    window.clearTimeout(timer);
    observer?.disconnect();
    resize?.disconnect();
    window.removeEventListener("resize", cleanup);
    window.removeEventListener("scroll", cleanup, true);
    document.removeEventListener("visibilitychange", hide);
    clone.remove();
    thumbnail.style.visibility = sourceVisibility;
    image.style.visibility = targetVisibility;
  };
  try {
    portal.append(clone);
    thumbnail.style.visibility = "hidden";
    image.style.visibility = "hidden";
    animation = clone.animate(direction === "in" ? [geometry(small), geometry(large)] : [geometry(from ?? large), geometry(small)], { duration, easing: pwaContentEasing(root), fill: "both" });
    animation.finished.then(cleanup, cleanup);
    timer = window.setTimeout(cleanup, duration + 50);
    window.addEventListener("resize", cleanup);
    window.addEventListener("scroll", cleanup, true);
    document.addEventListener("visibilitychange", hide);
    observer = new MutationObserver(() => {
      const next = publishedImageBounds(thumbnail, true, true);
      if (!source?.isConnected || !image.isConnected || thumbnail.currentSrc !== sourceUrl || image.currentSrc !== sourceUrl || !next
        || root.hasAttribute("data-pwa-dragging") || source.closest("[data-publication-id]")?.getAttribute("data-publication-id") !== root.dataset.publicationId
        || ["left", "top", "width", "height"].some(key => Math.round(next[key as keyof ImageBounds]) !== Math.round(small[key as keyof ImageBounds]))) cleanup();
    });
    observer.observe(portal, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "style", "class", "hidden", "data-pwa-dragging", "data-publication-id"] });
    resize = new ResizeObserver(() => {
      const next = root.getBoundingClientRect();
      const original = thumbnail.getBoundingClientRect();
      if (Math.round(next.width) !== Math.round(targetBox.width) || Math.round(next.height) !== Math.round(targetBox.height)
        || Math.round(original.width) !== Math.round(sourceBox.width) || Math.round(original.height) !== Math.round(sourceBox.height)) cleanup();
    });
    resize.observe(root);
    resize.observe(thumbnail);
    return { cancel: cleanup, bounds: () => finished ? null : clone.getBoundingClientRect(), get active() { return !finished; } };
  } catch { cleanup(); return null; }
}

export function usePublishedImageMotion({ image, source, root, url, opened, instant, zoomed, allowEnter, enterDuration, exitDuration }: {
  image: HTMLImageElement | null;
  source: HTMLButtonElement | undefined;
  root: HTMLDivElement | null;
  url: string;
  opened: boolean;
  instant: boolean;
  zoomed: boolean;
  allowEnter: boolean;
  enterDuration: number;
  exitDuration: number;
}) {
  const reduced = useReducedMotion();
  const phase = useRef<boolean | null>(null);
  const motion = useRef<ImageMotion | null>(null);
  useLayoutEffect(() => {
    if (!image || !root) { motion.current?.cancel(); return; }
    const changed = phase.current !== opened;
    const from = motion.current?.active ? motion.current.bounds() : null;
    motion.current?.cancel();
    phase.current = opened;
    if (!changed || instant || reduced || zoomed || opened && !allowEnter || root.hasAttribute("data-pwa-dragging")) return;
    motion.current = animatePublishedImage({ image, source, sourceUrl: url, root, direction: opened ? "in" : "out", duration: opened ? enterDuration : exitDuration, from });
  }, [image, source, root, url, opened, instant, reduced, zoomed, allowEnter, enterDuration, exitDuration]);
  useLayoutEffect(() => () => { motion.current?.cancel(); }, []);
}
