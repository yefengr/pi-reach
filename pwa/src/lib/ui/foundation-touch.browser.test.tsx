import { afterEach, expect, test, vi } from "vitest";
import { useEffect, useRef } from "react";
import { MantineProvider, Popover } from "@mantine/core";
import { render } from "vitest-browser-react";
import { installPressFeedback, PRESS_ROW_DELAY_MS, PRESS_ROW_TAP_MS } from "../../../../packages/pwa-foundation/src/press-feedback";
import { installOutsideTapGuard, outsideTapSwallowed } from "../../../../packages/pwa-foundation/src/outside-tap-guard";
import { enableTouch, resetTouch, touchTap, touchOrigin, pointer } from "@/test/browser/swipe";
import "@mantine/core/styles.css";
import "../../../../packages/pwa-foundation/theme.css";
import "../../../../packages/pwa-foundation/controls.css";

const cleanups: (() => void)[] = [];
afterEach(async () => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); await resetTouch(); });
function fixture() {
  const scope = document.createElement("div");
  scope.className = "pwa-ui-scope";
  scope.innerHTML = '<button class="button pwa-button" data-variant="default">Button</button><button class="row pwa-press-row">Row</button><div class="floating">Floating</div><button class="trigger">Trigger</button>';
  document.body.append(scope);
  cleanups.push(() => scope.remove());
  const button = scope.querySelector<HTMLButtonElement>(".button")!;
  const row = scope.querySelector<HTMLButtonElement>(".row")!;
  const floating = scope.querySelector<HTMLElement>(".floating")!;
  const trigger = scope.querySelector<HTMLElement>(".trigger")!;
  const press = () => {
    const dispose = installPressFeedback(scope, { buttonSelector: ".button", rowSelector: ".row", shouldIgnore: outsideTapSwallowed });
    cleanups.push(dispose);
    return dispose;
  };
  const guard = () => {
    const dispose = installOutsideTapGuard(scope, { getTopFloating: () => floating, isOwnTrigger: target => trigger.contains(target) });
    cleanups.push(dispose);
    return dispose;
  };
  return { scope, button, row, floating, trigger, press, guard };
}
function point(element: Element, type: string, init: PointerEventInit = {}) {
  const { x, y } = touchOrigin(element);
  pointer(element, type, x, y, { button: 0, ...init });
}
const pressed = (node: HTMLElement) => node.hasAttribute("data-pwa-pressed");

test("button feedback is touch/pen only, scope-limited, primary and does not cancel events", () => {
  const { scope, button, press } = fixture(); press();
  for (const init of [{ pointerType: "mouse" }, { isPrimary: false }, { button: 2 }]) {
    point(button, "pointerdown", init); expect(pressed(button)).toBe(false);
  }
  const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 1, isPrimary: true, button: 0 });
  const seen = vi.fn(); scope.addEventListener("pointerdown", seen);
  button.dispatchEvent(event);
  expect(pressed(button)).toBe(true); expect(event.defaultPrevented).toBe(false); expect(seen).toHaveBeenCalledOnce();
  point(button, "pointerup"); expect(pressed(button)).toBe(false);
  const outside = button.cloneNode(true) as HTMLElement; document.body.append(outside); cleanups.push(() => outside.remove());
  point(outside, "pointerdown"); expect(pressed(outside)).toBe(false);
});

test("row delay never flashes on scroll; short taps hold then release using local motion token", () => {
  vi.useFakeTimers();
  const { scope, row, press } = fixture(); scope.style.setProperty("--pwa-duration-press-out", "300ms"); press();
  point(row, "pointerdown"); vi.advanceTimersByTime(PRESS_ROW_DELAY_MS - 1); expect(pressed(row)).toBe(false);
  row.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(500); expect(pressed(row)).toBe(false);
  expect(row.hasAttribute("data-pwa-press-release")).toBe(false);
  point(row, "pointerdown"); point(row, "pointerup"); expect(pressed(row)).toBe(true);
  vi.advanceTimersByTime(PRESS_ROW_TAP_MS); expect(pressed(row)).toBe(false); expect(row.dataset.pwaPressRelease).toBe("true");
  vi.advanceTimersByTime(299); expect(row.dataset.pwaPressRelease).toBe("true");
  vi.advanceTimersByTime(1); expect(row.hasAttribute("data-pwa-press-release")).toBe(false);
});

test.each(["pointercancel", "lostpointercapture", "move", "blur", "scroll", "dispose"])("clears held feedback on %s", action => {
  const { button, press } = fixture(); const dispose = press(); point(button, "pointerdown");
  if (action === "move") point(button, "pointermove", { clientX: -100, clientY: -100 });
  else if (action === "blur") window.dispatchEvent(new Event("blur"));
  else if (action === "scroll") button.dispatchEvent(new Event("scroll"));
  else if (action === "dispose") dispose();
  else point(button, action);
  expect(pressed(button)).toBe(false);
});

test.each(["held", "tapped", "releasing"])("disable, hide and removal clean tracked %s elements", async phase => {
  const { row, scope, press } = fixture(); const dispose = press();
  for (const change of [() => row.setAttribute("aria-disabled", "true"), () => scope.hidden = true, () => row.remove()]) {
    scope.hidden = false; row.removeAttribute("aria-disabled"); scope.append(row);
    point(row, "pointerdown");
    if (phase === "held") await expect.poll(() => pressed(row)).toBe(true);
    else {
      point(row, "pointerup");
      if (phase === "releasing") await expect.poll(() => row.hasAttribute("data-pwa-press-release")).toBe(true);
    }
    change();
    await expect.poll(() => pressed(row) || row.hasAttribute("data-pwa-press-release")).toBe(false);
  }
  dispose();
});

test("visibility change cancels press timers and pending guard click", () => {
  vi.useFakeTimers(); const { button, row, press, guard } = fixture(); press(); const disposeGuard = guard();
  point(button, "pointerdown"); point(button, "pointerup");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(click(button).defaultPrevented).toBe(false);
  hidden.mockReturnValue(false);
  // 关闭 guard，单独检查已经补显的短触行。
  disposeGuard();
  point(row, "pointerdown"); point(row, "pointerup"); expect(pressed(row)).toBe(true);
  hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
  vi.runAllTimers(); expect(pressed(row)).toBe(false); expect(row.hasAttribute("data-pwa-press-release")).toBe(false);
  hidden.mockRestore();
});

test("row movement inside a large hit area cancels delay without release flash", () => {
  vi.useFakeTimers(); const { row, press } = fixture(); row.style.width = "200px"; press();
  const { x, y } = touchOrigin(row);
  pointer(row, "pointerdown", x, y, { button: 0 });
  pointer(row, "pointermove", x + 11, y, { button: 0 });
  vi.runAllTimers(); expect(pressed(row)).toBe(false); expect(row.hasAttribute("data-pwa-press-release")).toBe(false);
});

test("button variants and opt-in row render press colors without moving the hit area", () => {
  const { button, row, press } = fixture(); press();
  for (const variant of ["filled", "default", "transparent", "outline"]) {
    button.dataset.variant = variant;
    const before = button.getBoundingClientRect();
    point(button, "pointerdown");
    expect(getComputedStyle(button).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Math.round(button.getBoundingClientRect().width)).toBe(Math.round(before.width));
    expect(getComputedStyle(button).transform).toBe("none");
    point(button, "pointerup");
  }
  row.dataset.pwaPressed = "host";
  expect(getComputedStyle(row).transitionDuration).toBe("0s");
});

test("unmount removes short-tap/release timers and preserves marks not owned by this installer", () => {
  vi.useFakeTimers(); const { row, button, press } = fixture(); button.dataset.pwaPressed = "host";
  const dispose = press(); point(button, "pointerdown"); point(button, "pointerup"); expect(button.dataset.pwaPressed).toBe("host");
  point(row, "pointerdown"); point(row, "pointerup"); dispose(); vi.runAllTimers();
  expect(pressed(row)).toBe(false); expect(row.hasAttribute("data-pwa-press-release")).toBe(false);
});

function click(element: HTMLElement, init: PointerEventInit = {}) {
  const { x, y } = touchOrigin(element);
  const event = new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, detail: 1, clientX: x, clientY: y, ...init });
  element.dispatchEvent(event); return event;
}
test("guard leaves original down listeners intact, marks press ignore, and matches touch clicks only", () => {
  const { button, scope, guard, press } = fixture(); guard(); press();
  const seen = vi.fn(); scope.addEventListener("pointerdown", seen);
  point(button, "pointerdown"); expect(seen).toHaveBeenCalledOnce(); expect(pressed(button)).toBe(false); point(button, "pointerup");
  expect(click(button, { detail: 0 }).defaultPrevented).toBe(false);
  expect(click(button, { pointerType: "mouse" }).defaultPrevented).toBe(false);
  expect(click(button, { pointerId: 2 }).defaultPrevented).toBe(false);
  expect(click(button).defaultPrevented).toBe(true);
  expect(click(button).defaultPrevented).toBe(false);
});

test("scope exterior, floating and own trigger remain untouched", () => {
  const { button, floating, trigger, guard } = fixture(); guard();
  const outside = button.cloneNode(true) as HTMLElement; document.body.append(outside); cleanups.push(() => outside.remove());
  for (const target of [outside, floating, trigger]) { point(target, "pointerdown"); point(target, "pointerup"); expect(click(target).defaultPrevented).toBe(false); }
});

test("a floating returned from outside the owned scope cannot arm the guard", () => {
  const { scope, button, floating, guard } = fixture();
  scope.after(floating); cleanups.push(() => floating.remove()); guard();
  point(button, "pointerdown"); point(button, "pointerup");
  expect(click(button).defaultPrevented).toBe(false);
});

test.each(["move", "scroll", "pointercancel", "blur", "timeout", "new-down", "dispose"])("guard cancels on %s and never eats a later touch click", action => {
  vi.useFakeTimers(); const { button, guard } = fixture(); const dispose = guard(); point(button, "pointerdown");
  if (action === "move") point(button, "pointermove", { clientX: -100, clientY: -100 });
  if (action === "scroll") button.dispatchEvent(new Event("scroll"));
  if (action === "pointercancel") point(button, "pointercancel");
  if (action === "blur") window.dispatchEvent(new Event("blur"));
  if (action === "new-down") point(button, "pointerdown", { pointerType: "mouse" });
  if (action === "dispose") dispose();
  point(button, "pointerup"); if (action === "timeout") vi.advanceTimersByTime(701);
  expect(click(button).defaultPrevented).toBe(false);
});

// 独立 fixture 不挂载 Reach 的 guard，避免把现有消费者行为误当公共包证据。
test("real Mantine touch outside closes without click/focus; next touch activates and own trigger works", async () => {
  await enableTouch(); let actions = 0;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => installOutsideTapGuard(ref.current!, {
      getTopFloating: () => ref.current!.querySelector<HTMLElement>(".mantine-Popover-dropdown"),
      isOwnTrigger: target => !!target.closest("[aria-expanded='true']"),
    }), []);
    return <MantineProvider><div ref={ref}>
      <Popover withinPortal={false}><Popover.Target><button>Trigger</button></Popover.Target><Popover.Dropdown>Floating</Popover.Dropdown></Popover>
      <input aria-label="Outside field" style={{ display: "block", marginTop: 200 }} onClick={() => actions++} />
    </div></MantineProvider>;
  }
  const screen = await render(<Harness />); cleanups.push(() => { void screen.unmount(); });
  const trigger = screen.getByRole("button", { name: "Trigger" }).element();
  const field = screen.getByRole("textbox").element();
  await touchTap(touchOrigin(trigger));
  await expect.poll(() => document.querySelector(".mantine-Popover-dropdown")).not.toBeNull();
  await touchTap(touchOrigin(field));
  await expect.poll(() => document.querySelector(".mantine-Popover-dropdown")).toBeNull();
  expect(actions).toBe(0); expect(document.activeElement).not.toBe(field);
  await touchTap(touchOrigin(field)); expect(actions).toBe(1);
  await touchTap(touchOrigin(trigger));
  await expect.poll(() => document.querySelector(".mantine-Popover-dropdown")).not.toBeNull();
  await touchTap(touchOrigin(trigger));
  await expect.poll(() => document.querySelector(".mantine-Popover-dropdown")).toBeNull();
});
