import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { hasKeyboardOverlay } from "@/lib/pwa/keyboard-shortcuts";
import { useWorkPanel } from "./work-panel-layout";

export function readerFocusable(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element !== document.body && element !== document.documentElement && element.isConnected && !element.matches(":disabled")
    && !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";
}

export function useReaderIntent() {
  const [generation, setGeneration] = useState<object>({});
  const current = useRef(generation);
  const changeSelection = useCallback(() => {
    const next = {};
    current.current = next;
    setGeneration(next);
  }, []);
  const acceptsSelection = useCallback(() => current.current === generation, [generation]);
  return { changeSelection, acceptsSelection };
}

export function readerHasOverlay(surface: HTMLElement | null) {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')]
    .some(overlay => overlay !== surface && readerFocusable(overlay));
}

/** DOM 移动会清除焦点、选区；迁移前保存节点及偏移，迁移后只恢复仍属于正文的状态。 */
function moveContent(container: HTMLElement, target: HTMLElement) {
  if (container.parentElement === target) return;
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const selection = window.getSelection();
  const selected = selection?.anchorNode && selection.focusNode && container.contains(selection.anchorNode) && container.contains(selection.focusNode)
    ? { anchor: selection.anchorNode, start: selection.anchorOffset, focus: selection.focusNode, end: selection.focusOffset } : null;
  const scrolls = [...container.querySelectorAll<HTMLElement>(".pwa-tool-reader-scroll, .pwa-file-reader-scroll")].map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
  target.append(container);
  for (const { element, top, left } of scrolls) { element.scrollTop = top; element.scrollLeft = left; }
  if (readerFocusable(focused)) focused.focus({ preventScroll: true });
  if (selected && container.contains(selected.anchor) && container.contains(selected.focus)) selection?.setBaseAndExtent(selected.anchor, selected.start, selected.focus, selected.end);
}

/** 只迁移同一个 Portal 的宿主，宽窄切换不重挂正文，也不结束业务阅读生命周期。 */
export function useWorkPanelReader({ enabled, opened, onClose, onExitTransitionEnd, onEntered }: {
  enabled: boolean; opened: boolean; onClose: () => void; onExitTransitionEnd?: () => void; onEntered?: () => void;
}) {
  const panel = useWorkPanel();
  const owner = useId();
  const docked = enabled && panel?.canSplit === true;
  const [container] = useState(() => {
    const node = document.createElement("div");
    node.className = "pwa-reader-portal";
    return node;
  });
  const [modalHost, setModalHost] = useState<HTMLDivElement | null>(null);
  const rememberedFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // 宿主变为 hidden/inert 时浏览器会先撤销焦点，保留此前仍属于正文的控件。
    const focus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && container.contains(event.target)) rememberedFocus.current = event.target;
      else if (readerFocusable(event.target as Element | null)) rememberedFocus.current = null;
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, [container]);
  const callbacks = useRef({ opened, docked, onClose, onExitTransitionEnd, onEntered });
  useLayoutEffect(() => { callbacks.current = { opened, docked, onClose, onExitTransitionEnd, onEntered }; });
  const claim = panel?.claim;
  useLayoutEffect(() => {
    if (!docked || !opened || !claim) return;
    claim(owner, true);
    return () => claim(owner, false);
  }, [claim, docked, opened, owner]);
  useLayoutEffect(() => {
    const target = docked && opened ? panel?.host : modalHost;
    let focusFrame = 0;
    if (target && container.parentElement !== target) {
      const focused = rememberedFocus.current;
      moveContent(container, target);
      // Mantine 在下一个任务自动聚焦标题；迁移后恢复有效的原控件，不覆盖其他主动焦点。
      if (focused) focusFrame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (readerFocusable(focused) && container.contains(focused)
          && (!readerFocusable(active) || active === focused || active.matches("[data-autofocus]"))) focused.focus({ preventScroll: true });
      });
    } else if (!target && !opened) container.remove();
    return () => cancelAnimationFrame(focusFrame);
  }, [container, docked, opened, panel?.host, modalHost]);
  const previouslyOpen = useRef(false);
  const previouslyDocked = useRef(docked);
  useLayoutEffect(() => {
    let focusFrame = 0;
    if (opened && docked) {
      callbacks.current.onEntered?.();
      const newlyOpened = !previouslyOpen.current;
      if (newlyOpened || !previouslyDocked.current) focusFrame = requestAnimationFrame(() => {
        const heading = container.querySelector<HTMLElement>("[data-autofocus]");
        if ((newlyOpened || !readerFocusable(document.activeElement)) && readerFocusable(heading)) heading.focus({ preventScroll: true });
      });
    }
    if (!opened && previouslyOpen.current && (docked || previouslyDocked.current)) callbacks.current.onExitTransitionEnd?.();
    previouslyOpen.current = opened;
    previouslyDocked.current = docked;
    return () => cancelAnimationFrame(focusFrame);
  }, [opened, docked, container]);
  useLayoutEffect(() => {
    if (!docked || !opened) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
        || !readerFocusable(container) || hasKeyboardOverlay()) return;
      event.preventDefault();
      callbacks.current.onClose();
    };
    // 冒泡到 document 后处理，使子控件先消费 Escape。
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [container, docked, opened]);
  useLayoutEffect(() => () => container.remove(), [container]);
  const onExit = useCallback(() => {
    // 宽窄迁移也会让 Drawer 退出；它不代表用户结束阅读。
    if (!callbacks.current.opened) callbacks.current.onExitTransitionEnd?.();
  }, []);
  const portal = (children: ReactNode) => createPortal(children, container);
  return { docked, modalOpened: opened && !docked, setModalHost, portal, onExit };
}
