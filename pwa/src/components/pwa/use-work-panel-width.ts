import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from "react";

export const WORK_PANEL_MIN_WIDTH = 360;
export const WORK_PANEL_DEFAULT_WIDTH = 440;
export const WORK_PANEL_GUTTER = 16;
export const WORK_PANEL_CONVERSATION_MIN_WIDTH = 480;
export const WORK_PANEL_SPLIT_MIN_WIDTH = 900;
export const WORK_PANEL_KEYBOARD_STEP = 24;
export const WORK_PANEL_DESKTOP_MIN_WIDTH = 768;

interface DragState {
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startWidth: number;
}

type HandleProps = Pick<HTMLAttributes<HTMLDivElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
  | "onLostPointerCapture" | "onKeyDown"
>;

function clampWidth(width: number, maximum: number) {
  return Math.min(Math.max(width, WORK_PANEL_MIN_WIDTH), maximum);
}

export function useWorkPanelWidth(element: HTMLElement | null, enabled: boolean) {
  const [available, setAvailable] = useState(0);
  const [desktop, setDesktop] = useState(false);
  const [requestedWidth, setRequestedWidth] = useState(WORK_PANEL_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  const canSplit = desktop && available >= WORK_PANEL_SPLIT_MIN_WIDTH;
  const maximum = Math.max(WORK_PANEL_MIN_WIDTH,
    available - WORK_PANEL_CONVERSATION_MIN_WIDTH - WORK_PANEL_GUTTER);
  const width = clampWidth(requestedWidth, maximum);

  if (dragging && (!enabled || !canSplit)) setDragging(false);

  const releaseCapture = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
  }, []);
  const stopDragging = useCallback(() => {
    releaseCapture();
    setDragging(false);
  }, [releaseCapture]);

  useLayoutEffect(() => {
    const media = window.matchMedia(`(min-width: ${WORK_PANEL_DESKTOP_MIN_WIDTH}px)`);
    const measure = () => {
      stopDragging();
      setDesktop(media.matches);
      if (!element) {
        setAvailable(0);
        return;
      }
      const style = window.getComputedStyle(element);
      setAvailable(Math.max(0, element.clientWidth
        - (Number.parseFloat(style.paddingLeft) || 0)
        - (Number.parseFloat(style.paddingRight) || 0)));
    };
    const onSecondPointer = (event: PointerEvent) => {
      if (drag.current && event.pointerId !== drag.current.pointerId) stopDragging();
    };
    const onBlur = () => stopDragging();
    const onVisibility = () => {
      if (document.hidden) stopDragging();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (element) observer?.observe(element);
    measure();
    media.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pointerdown", onSecondPointer, true);
    return () => {
      observer?.disconnect();
      media.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onSecondPointer, true);
      releaseCapture();
    };
  }, [element, releaseCapture, stopDragging]);

  useLayoutEffect(() => {
    if (!enabled || !canSplit) releaseCapture();
  }, [enabled, canSplit, releaseCapture]);

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) stopDragging();
  };
  const handleProps: HandleProps = {
    onPointerDown(event) {
      if (!enabled || !canSplit || event.button !== 0 || !event.isPrimary || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        target: event.currentTarget,
        startX: event.clientX,
        startWidth: width,
      };
      event.preventDefault();
      setDragging(true);
    },
    onPointerMove(event) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId || !enabled || !canSplit) return;
      event.preventDefault();
      setRequestedWidth(clampWidth(current.startWidth + current.startX - event.clientX, maximum));
    },
    onPointerUp: finishPointer,
    onPointerCancel: finishPointer,
    onLostPointerCapture: finishPointer,
    onKeyDown(event) {
      if (!enabled || !canSplit) return;
      let next: number;
      switch (event.key) {
        case "ArrowLeft": next = width + WORK_PANEL_KEYBOARD_STEP; break;
        case "ArrowRight": next = width - WORK_PANEL_KEYBOARD_STEP; break;
        case "Home": next = WORK_PANEL_MIN_WIDTH; break;
        case "End": next = maximum; break;
        default: return;
      }
      event.preventDefault();
      setRequestedWidth(clampWidth(next, maximum));
    },
  };

  return {
    canSplit, width, maximum, dragging, handleProps,
    resetWidth: () => setRequestedWidth(WORK_PANEL_DEFAULT_WIDTH),
  };
}
