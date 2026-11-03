import { useLayoutEffect, type RefObject } from "react";
import { DESKTOP_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

type WindowControlsOverlay = EventTarget & {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
};

const GEOMETRY_PROPERTIES = ["x", "y", "width", "height", "right"] as const;

function clearOverlay(root: HTMLElement) {
  for (const attribute of ["data-wco", "data-wco-sidebar-below", "data-wco-main-below"]) root.removeAttribute(attribute);
  for (const property of GEOMETRY_PROPERTIES) root.style.removeProperty(`--pwa-wco-${property}`);
}

function validRect(rect: DOMRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= window.innerWidth && rect.y + rect.height <= window.innerHeight;
}

const px = (value: string) => Number.parseFloat(value) || 0;

/** 内容不足以与系统控件共用首行时，仅把受影响列移到系统带下方。按真实字形和点击区测量，不猜平台。 */
function measureFallback(root: HTMLElement, rect: DOMRect, safeTop: number) {
  const center = rect.y + rect.height / 2;
  const rootStyle = getComputedStyle(root);
  const visualSize = Math.min(px(rootStyle.getPropertyValue("--pwa-hit-target")) - 8, rect.height);
  // 与两列 CSS 的实际 padding 起点一致，避免 y > 0 时负 padding 被归零而误判可融合。
  const fitsVertically = (height: number) => center - Math.max(height, visualSize) / 2 >= Math.max(safeTop, rect.y);
  const brand = root.querySelector<HTMLElement>(".pwa-desktop-navigation .pwa-sidebar-brand");
  const sidebar = brand?.closest<HTMLElement>(".pwa-sidebar");
  const main = root.querySelector<HTMLElement>(".pwa-main");
  const actions = root.querySelector<HTMLElement>(".pwa-title-bar-actions");
  const toggle = root.querySelector<HTMLElement>(".pwa-sidebar-toggle");
  if (brand && sidebar && toggle) {
    const style = getComputedStyle(brand);
    const sidebarStyle = getComputedStyle(sidebar);
    const childrenWidth = [...brand.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
    const required = childrenWidth + px(style.columnGap) * Math.max(0, brand.children.length - 1)
      + px(style.paddingLeft) + px(style.paddingRight) + px(sidebarStyle.paddingRight);
    // 侧栏从 viewport 原点展开；只取布局宽度，不让收展 translate 被误判为系统控件挤占空间。
    const available = Math.min(sidebar.getBoundingClientRect().width, rect.x + rect.width)
      - Math.max(rect.x, px(sidebarStyle.paddingLeft));
    const contentHeight = Math.max(...[...brand.children].map(child => child.getBoundingClientRect().height));
    root.toggleAttribute("data-wco-sidebar-below", available < required || !fitsVertically(contentHeight));
  }
  if (main && actions && toggle) {
    const title = main.querySelector<HTMLElement>(".pwa-title-bar")!;
    const gutter = px(getComputedStyle(root).getPropertyValue("--pwa-gutter"));
    const toggleWidth = root.hasAttribute("data-sidebar-collapsed") ? toggle.getBoundingClientRect().width : 0;
    const available = rect.x + rect.width - Math.max(rect.x, main.getBoundingClientRect().left);
    // 即使标题省略也要保留完整操作槽和两个 gutter；放不下则整列标题下移。
    const required = actions.scrollWidth + toggleWidth + gutter * 2;
    const titleHeight = px(getComputedStyle(title).getPropertyValue("--pwa-text-title"))
      * px(getComputedStyle(title).getPropertyValue("--pwa-leading-ui"));
    root.toggleAttribute("data-wco-main-below", available < required || !fitsVertically(titleHeight));
  }
}

/** WCO 是可选增强：API 是启用真源，CSS env 只负责与浏览器原生标题带取保守交集。 */
export function useWindowControlsOverlay(rootRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
    if (!overlay) { clearOverlay(root); return; }
    const desktop = window.matchMedia(DESKTOP_LAYOUT_QUERY);
    // 由浏览器解析同一份 API/env 交集及安全区，避免在 JS 再实现 CSS max()/env() 规则。
    const geometryProbe = document.createElement("div");
    geometryProbe.setAttribute("aria-hidden", "true");
    geometryProbe.style.cssText = "position: absolute; visibility: hidden; pointer-events: none; top: var(--pwa-wco-top); left: var(--pwa-wco-left); right: var(--pwa-wco-reserved-right); height: var(--pwa-wco-band-height); padding-top: var(--pwa-safe-top); box-sizing: content-box;";
    root.append(geometryProbe);
    const update = () => {
      const origin = root.getBoundingClientRect();
      if (!overlay.visible || !desktop.matches || document.fullscreenElement || origin.x !== 0 || origin.y !== 0) {
        clearOverlay(root);
        return;
      }
      let rect: DOMRect;
      try { rect = overlay.getTitlebarAreaRect(); } catch { clearOverlay(root); return; }
      if (!validRect(rect)) { clearOverlay(root); return; }
      const geometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: window.innerWidth - rect.x - rect.width };
      for (const property of GEOMETRY_PROPERTIES) root.style.setProperty(`--pwa-wco-${property}`, `${geometry[property]}px`);
      root.setAttribute("data-wco", "");
      const bounds = geometryProbe.getBoundingClientRect();
      const safeTop = px(getComputedStyle(geometryProbe).paddingTop);
      measureFallback(root, new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height - safeTop), safeTop);
    };
    update();
    overlay.addEventListener("geometrychange", update);
    window.addEventListener("resize", update);
    desktop.addEventListener("change", update);
    document.addEventListener("fullscreenchange", update);
    // 覆盖字号变化、侧栏收展与布局变更；不参与现有标题/通知测量的状态所有权。
    const observer = new ResizeObserver(update);
    for (const element of [root, ...root.querySelectorAll(".pwa-main, .pwa-sidebar-brand, .pwa-sidebar-brand > *, .pwa-title-bar-actions")]) observer.observe(element);
    const attributes = new MutationObserver(update);
    attributes.observe(root, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
    return () => {
      overlay.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
      desktop.removeEventListener("change", update);
      document.removeEventListener("fullscreenchange", update);
      observer.disconnect();
      attributes.disconnect();
      geometryProbe.remove();
      clearOverlay(root);
    };
  }, [rootRef]);
}
