import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { List, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";
import type { DocumentHeading } from "./file-text-content";
import { pwaMotionShiftDisabled, usePwaMenuTransition, usePwaMotionDuration } from "./use-pwa-motion";
import { pwaSpringProgress } from "@/lib/ui/motion";
import { useOutsideTapGuard } from "./use-outside-tap-guard";
import "./reader-document.css";

export type ReaderTocProps = { headings: readonly DocumentHeading[]; scroll: HTMLElement | null; partial?: boolean };

function headingElement(scroll: HTMLElement, id: string) {
  const element = scroll.ownerDocument.getElementById(id);
  return element && scroll.contains(element) ? element : null;
}

export function ReaderToc({ headings, scroll, partial = false }: ReaderTocProps) {
  const { t } = useI18n();
  const transition = usePwaMenuTransition();
  const middlewares = useFloatingSafeMiddlewares();
  const scrollDuration = usePwaMotionDuration("--pwa-duration-scroll-latest");
  useOutsideTapGuard();
  const [opened, setOpened] = useState(false);
  const [active, setActive] = useState<string>();
  const glideFrame = useRef<number | null>(null);
  const stopGlide = useCallback(() => {
    if (glideFrame.current !== null) cancelAnimationFrame(glideFrame.current);
    glideFrame.current = null;
  }, []);
  useEffect(() => {
    if (!scroll) return;
    scroll.addEventListener("wheel", stopGlide, { passive: true });
    scroll.addEventListener("touchstart", stopGlide, { passive: true });
    scroll.addEventListener("pointerdown", stopGlide, { passive: true });
    return () => {
      stopGlide();
      scroll.removeEventListener("wheel", stopGlide);
      scroll.removeEventListener("touchstart", stopGlide);
      scroll.removeEventListener("pointerdown", stopGlide);
    };
  }, [scroll, stopGlide]);
  const menuScroll = useRef<HTMLDivElement>(null);
  const updateActive = useCallback(() => {
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top + scroll.clientTop;
    let current = headings[0]?.id;
    for (const heading of headings) {
      const target = headingElement(scroll, heading.id);
      if (target && target.getBoundingClientRect().top <= top + 1) current = heading.id;
    }
    setActive(current);
  }, [scroll, headings]);
  useEffect(() => {
    if (!scroll) return;
    const frame = requestAnimationFrame(updateActive);
    scroll.addEventListener("scroll", updateActive, { passive: true });
    const observer = new ResizeObserver(updateActive);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => { cancelAnimationFrame(frame); scroll.removeEventListener("scroll", updateActive); observer.disconnect(); };
  }, [scroll, updateActive]);
  const revealActive = useCallback(() => {
    const container = menuScroll.current;
    const selected = container?.querySelector<HTMLElement>('[data-reader-current="true"]');
    if (!container || !selected) return;
    const bounds = container.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    // 菜单进入时带缩放；视觉差值须还原成 scrollTop 使用的布局像素。
    const dropdown = container.closest<HTMLElement>(".pwa-reader-toc")!;
    const transform = getComputedStyle(dropdown).transform;
    const scaleY = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).m22;
    if (item.top < bounds.top) container.scrollTop -= Math.ceil((bounds.top - item.top) / scaleY);
    else if (item.bottom > bounds.bottom) container.scrollTop += Math.ceil((item.bottom - bounds.bottom) / scaleY);
  }, []);
  useLayoutEffect(() => { if (opened) revealActive(); }, [opened, active, revealActive]);
  if (headings.length < 2) return null;
  const jump = (heading: DocumentHeading) => {
    if (!scroll) return;
    const target = headingElement(scroll, heading.id);
    if (!target) return;
    const top = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop));
    stopGlide();
    if (pwaMotionShiftDisabled(scroll) || scrollDuration <= 0) scroll.scrollTo({ top, behavior: "auto" });
    else {
      const from = scroll.scrollTop;
      let start: number | null = null;
      const step = (now: number) => {
        if (!scroll.isConnected) { glideFrame.current = null; return; }
        start ??= now;
        const progress = pwaSpringProgress((now - start) / scrollDuration);
        scroll.scrollTo({ top: from + (top - from) * progress, behavior: "auto" });
        glideFrame.current = progress < 1 ? requestAnimationFrame(step) : null;
      };
      glideFrame.current = requestAnimationFrame(step);
    }
    setActive(heading.id);
  };
  return <Menu opened={opened} onChange={setOpened} position="bottom-end" offset={8} width="min(320px, calc(100vw - 32px))"
    withinPortal portalProps={{ target: ".pwa-root" }} zIndex="var(--pwa-z-reader)" floatingStrategy="fixed"
    middlewares={middlewares} transitionProps={transition} onEnterTransitionEnd={revealActive} returnFocus
    clickOutsideEvents={["mousedown", "touchstart"]}>
    <Menu.Target><ActionIcon className="pwa-icon-button" aria-label={t.files.contents} title={t.files.contents} onClick={updateActive}><List size={20} aria-hidden="true" /></ActionIcon></Menu.Target>
    <Menu.Dropdown className="pwa-reader-toc pwa-menu-motion" inert={!opened} data-pwa-reader-overlay={opened || undefined} aria-label={t.files.contents}>
      <div className="pwa-reader-toc-head"><span>{t.files.contents}</span><ActionIcon className="pwa-icon-button" aria-label={t.files.closeContents} title={t.files.closeContents} onClick={() => setOpened(false)}><X size={20} aria-hidden="true" /></ActionIcon></div>
      <div ref={menuScroll} className="pwa-reader-toc-scroll">
        {headings.map(heading => <Menu.Item key={heading.id} className="pwa-reader-toc-item" data-level={heading.level} data-reader-current={heading.id === active ? "true" : undefined} aria-current={heading.id === active ? "location" : undefined} onClick={() => jump(heading)}>{heading.text}</Menu.Item>)}
      </div>
      {partial ? <Menu.Label className="pwa-reader-toc-notice">{t.files.partialContents}</Menu.Label> : null}
    </Menu.Dropdown>
  </Menu>;
}
