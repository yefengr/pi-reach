import { createRef, useImperativeHandle, useState } from "react";
import type { ReactNode, Ref } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
import { useWorkPanelWidth } from "./use-work-panel-width";

function Probe({ parentWidth = 1300, enabled = true, padding = false }: {
  parentWidth?: number;
  enabled?: boolean;
  padding?: boolean;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { handleProps, resetWidth, ...state } = useWorkPanelWidth(element, enabled);
  return (
    <div style={{ width: parentWidth }}>
      <div ref={setElement} data-testid="main" style={{
        width: "100%", boxSizing: "border-box", height: 100,
        paddingLeft: padding ? 24 : 0, paddingRight: padding ? 36 : 0,
      }}>
        <div {...handleProps} data-testid="separator" role="separator" tabIndex={0}
          aria-orientation="vertical" aria-valuemin={360} aria-valuemax={state.maximum}
          aria-valuenow={state.width}
          style={{ width: 44, height: 80, marginLeft: 650, touchAction: "none" }} />
        <output data-testid="state">{JSON.stringify(state)}</output>
        <button onClick={resetWidth}>Reset</button>
      </div>
    </div>
  );
}

type ProbeScreen = Awaited<ReturnType<typeof renderPwa>>;

function rerenderPwa(screen: ProbeScreen, ui: ReactNode) {
  return screen.rerender(<PwaUiProvider><div className="pwa-root">{ui}</div></PwaUiProvider>);
}

interface LifecycleControls {
  disable: () => void;
  unmount: () => void;
}

function LifecycleProbe({ controls }: { controls: Ref<LifecycleControls> }) {
  const [enabled, setEnabled] = useState(true);
  const [mounted, setMounted] = useState(true);
  useImperativeHandle(controls, () => ({
    disable: () => setEnabled(false),
    unmount: () => setMounted(false),
  }), []);
  return mounted ? <Probe enabled={enabled} /> : null;
}

function state(screen: ProbeScreen) {
  return JSON.parse(screen.getByTestId("state").element().textContent!) as {
    canSplit: boolean;
    width: number;
    maximum: number;
    dragging: boolean;
  };
}

async function key(screen: ProbeScreen, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  flushSync(() => { screen.getByTestId("separator").element().dispatchEvent(event); });
  return event.defaultPrevented;
}

function pointer(target: Element, type: string, pointerId: number, clientX: number) {
  const event = new PointerEvent(type, {
    pointerId, clientX, bubbles: true, cancelable: true, isPrimary: true, button: 0,
  });
  target.dispatchEvent(event);
  return event;
}

// 由真实鼠标按下取得 capture，再在同一次原生点击的 pointerup 前检查拖动生命周期。
async function duringPress(screen: ProbeScreen, callback: (target: HTMLDivElement, event: PointerEvent) => void) {
  const target = screen.getByTestId("separator").element() as HTMLDivElement;
  let called = false;
  let callbackError: unknown;
  const listener = (event: PointerEvent) => {
    if (event.target !== target) return;
    document.removeEventListener("pointerdown", listener);
    called = true;
    try {
      callback(target, event);
    } catch (error) {
      callbackError = error;
    }
  };
  document.addEventListener("pointerdown", listener);
  try {
    await userEvent.click(target);
    expect(called).toBe(true);
    if (callbackError) throw callbackError;
  } finally {
    document.removeEventListener("pointerdown", listener);
  }
}

beforeEach(async () => { await page.viewport(1440, 1000); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("measures the actual parent content width, deducts both paddings, and splits at 900", async () => {
  const screen = await renderPwa(<Probe padding />);
  expect((screen.getByTestId("main").element() as HTMLElement).clientWidth).toBe(1300);
  await expect.poll(() => state(screen)).toEqual({
    canSplit: true, width: 440, maximum: 744, dragging: false,
  });
  await rerenderPwa(screen, <Probe parentWidth={959} padding />);
  await expect.poll(() => state(screen).canSplit).toBe(false);
  await rerenderPwa(screen, <Probe parentWidth={960} padding />);
  await expect.poll(() => state(screen)).toEqual({
    canSplit: true, width: 404, maximum: 404, dragging: false,
  });
});

test("requires a viewport of at least 768 even when the measured main is wide", async () => {
  const screen = await renderPwa(<Probe />);
  await expect.poll(() => state(screen).canSplit).toBe(true);
  await page.viewport(767, 1000);
  await expect.poll(() => state(screen).canSplit).toBe(false);
  expect(await key(screen, "End")).toBe(false);
  expect(state(screen).width).toBe(440);
  await page.viewport(768, 1000);
  await expect.poll(() => state(screen).canSplit).toBe(true);
});

test("retains requested width through narrow containers and restores the default after reset", async () => {
  const screen = await renderPwa(<Probe />);
  await expect.poll(() => state(screen).maximum).toBe(804);
  await key(screen, "End");
  expect(state(screen).width).toBe(804);
  await rerenderPwa(screen, <Probe parentWidth={900} />);
  await expect.poll(() => state(screen).width).toBe(404);
  await rerenderPwa(screen, <Probe parentWidth={850} />);
  await expect.poll(() => state(screen).width).toBe(360);
  await rerenderPwa(screen, <Probe />);
  await expect.poll(() => state(screen).width).toBe(804);
  await rerenderPwa(screen, <Probe parentWidth={900} />);
  await expect.poll(() => state(screen).width).toBe(404);
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  await rerenderPwa(screen, <Probe />);
  await expect.poll(() => state(screen).width).toBe(440);
});

test("handles 24px arrow steps and Home/End bounds without consuming unrelated keys", async () => {
  const screen = await renderPwa(<Probe />);
  await expect.poll(() => state(screen).canSplit).toBe(true);
  expect(await key(screen, "ArrowLeft")).toBe(true);
  expect(state(screen).width).toBe(464);
  await key(screen, "ArrowRight");
  expect(state(screen).width).toBe(440);
  await key(screen, "Home");
  await key(screen, "ArrowRight");
  expect(state(screen).width).toBe(360);
  await key(screen, "End");
  await key(screen, "ArrowLeft");
  expect(state(screen).width).toBe(804);
  expect(await key(screen, "Escape")).toBe(false);
  expect(await key(screen, "Tab")).toBe(false);
});

test("uses real pointer capture, ignores unrelated moves, clamps dragging, and releases on pointerup", async () => {
  const screen = await renderPwa(<Probe />);
  await expect.poll(() => state(screen).canSplit).toBe(true);
  let captureId = 0;
  let prevented = false;
  await duringPress(screen, (target, event) => {
    captureId = event.pointerId;
    expect(target.hasPointerCapture(captureId)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(pointer(target, "pointermove", captureId + 1, event.clientX - 500).defaultPrevented).toBe(false);
    flushSync(() => {
      prevented = pointer(target, "pointermove", captureId, event.clientX - 100).defaultPrevented;
    });
    expect(state(screen).dragging).toBe(true);
  });
  expect(prevented).toBe(true);
  expect(state(screen).width).toBe(540);
  expect(state(screen).dragging).toBe(false);
  expect(screen.getByTestId("separator").element().hasPointerCapture(captureId)).toBe(false);
  await duringPress(screen, (target, event) => {
    pointer(target, "pointermove", event.pointerId, event.clientX - 2000);
  });
  expect(state(screen).width).toBe(804);
  await duringPress(screen, (target, event) => {
    pointer(target, "pointermove", event.pointerId, event.clientX + 2000);
  });
  expect(state(screen).width).toBe(360);
});

for (const reason of ["pointercancel", "lostpointercapture", "blur", "hidden", "second-pointer", "resize"] as const) {
  test(`cancels an active capture on ${reason} and ignores subsequent moves`, async () => {
    const screen = await renderPwa(<Probe />);
    await expect.poll(() => state(screen).canSplit).toBe(true);
    await duringPress(screen, (target, event) => {
      const id = event.pointerId;
      if (reason === "blur" || reason === "resize") window.dispatchEvent(new Event(reason));
      else if (reason === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "second-pointer") pointer(document.body, "pointerdown", id + 1, event.clientX);
      else pointer(target, reason, id, event.clientX);
      expect(target.hasPointerCapture(id)).toBe(false);
      expect(pointer(target, "pointermove", id, event.clientX - 100).defaultPrevented).toBe(false);
    });
    expect(state(screen).dragging).toBe(false);
    expect(state(screen).width).toBe(440);
  });
}

test("disabled mode preserves split availability and width while ignoring keyboard and pointer input", async () => {
  const screen = await renderPwa(<Probe enabled={false} />);
  await expect.poll(() => state(screen).canSplit).toBe(true);
  expect(await key(screen, "End")).toBe(false);
  await duringPress(screen, (target, event) => {
    expect(event.defaultPrevented).toBe(false);
    expect(target.hasPointerCapture(event.pointerId)).toBe(false);
    pointer(target, "pointermove", event.pointerId, event.clientX - 100);
  });
  expect(state(screen).width).toBe(440);
  expect(state(screen).dragging).toBe(false);
});

for (const reason of ["disable", "unmount"] as const) {
  test(`releases active capture immediately on ${reason}`, async () => {
    const controls = createRef<LifecycleControls>();
    const screen = await renderPwa(<LifecycleProbe controls={controls} />);
    await expect.poll(() => state(screen).canSplit).toBe(true);
    await duringPress(screen, (target, event) => {
      expect(target.hasPointerCapture(event.pointerId)).toBe(true);
      flushSync(() => { controls.current![reason](); });
      expect(target.hasPointerCapture(event.pointerId)).toBe(false);
      expect(pointer(target, "pointermove", event.pointerId, event.clientX - 100).defaultPrevented).toBe(false);
      if (reason === "disable") {
        expect(state(screen).dragging).toBe(false);
        expect(state(screen).canSplit).toBe(true);
      } else expect(target.isConnected).toBe(false);
    });
    if (reason === "disable") expect(state(screen).width).toBe(440);
    await screen.unmount();
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("falls back to real geometry and window resize when ResizeObserver is unavailable", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const screen = await renderPwa(<Probe padding />);
  await expect.poll(() => state(screen).maximum).toBe(744);
  const main = screen.getByTestId("main").element() as HTMLElement;
  main.parentElement!.style.width = "960px";
  flushSync(() => { window.dispatchEvent(new Event("resize")); });
  expect(state(screen)).toEqual({ canSplit: true, width: 404, maximum: 404, dragging: false });
});
