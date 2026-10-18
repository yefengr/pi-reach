import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { ActionIcon, Button, Menu, NavLink } from "@mantine/core";
import { Copy } from "lucide-react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { setLanguagePreference } from "@/lib/i18n";
import { APPEARANCE_STORAGE_KEY } from "@/lib/ui/appearance";
import { MessageComposer } from "./message-composer";
import { usePwaAppearance } from "./pwa-appearance";
import { usePwaMenuTransition } from "./use-pwa-motion";

const setMotion = (reduce: boolean) => cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });
const matrix = (element: Element, pseudo?: string) => new DOMMatrix(getComputedStyle(element, pseudo).transform === "none" ? undefined : getComputedStyle(element, pseudo).transform);
const rect = (element: Element) => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return [left, top, width, height].map(Math.round);
};

beforeEach(() => { setLanguagePreference("en"); });
afterEach(async () => {
  await userEvent.keyboard("{/Space}");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  localStorage.removeItem(APPEARANCE_STORAGE_KEY);
  setLanguagePreference("system");
  await page.viewport(1280, 900);
});

test("presses only internal Button and ActionIcon layers while target geometry stays fixed", async () => {
  const screen = await renderPwa(<><ActionIcon aria-label="Icon fixture"><Copy size={16} /></ActionIcon><Button>Button fixture</Button></>);
  for (const [label, selector, scale] of [["Icon fixture", ".mantine-ActionIcon-icon", 0.97], ["Button fixture", ".mantine-Button-inner", 0.98]] as const) {
    const target = screen.getByRole("button", { name: label }).element() as HTMLButtonElement;
    const drawing = target.querySelector(selector)!;
    const before = rect(target);
    target.focus();
    await userEvent.keyboard("{Space>}");
    await expect.poll(() => matrix(drawing).m11).toBeCloseTo(scale, 2);
    expect(rect(target)).toEqual(before);
    expect(matrix(target).m42).toBe(0);
    expect(matrix(target).m11).toBe(1);
    if (label === "Icon fixture") {
      expect(matrix(target, "::before").m11).toBeCloseTo(0.97, 2);
      expect(before[2]).toBeGreaterThanOrEqual(44);
      expect(before[3]).toBeGreaterThanOrEqual(44);
    }
    await userEvent.keyboard("{/Space}");
    await expect.poll(() => matrix(drawing).m11).toBe(1);
    expect(rect(target)).toEqual(before);
  }
});

test("runtime reduced motion and disabling a held button reset the drawing without moving focus", async () => {
  let setDisabled!: (value: boolean) => void;
  function Fixture() {
    const [disabled, update] = useState(false);
    useLayoutEffect(() => { setDisabled = update; }, [update]);
    return <ActionIcon aria-label="Held fixture" disabled={disabled}><Copy size={16} /></ActionIcon>;
  }
  const screen = await renderPwa(<Fixture />);
  const target = screen.getByRole("button", { name: "Held fixture" }).element() as HTMLButtonElement;
  const drawing = target.querySelector(".mantine-ActionIcon-icon")!;
  const before = rect(target);
  target.focus();
  await userEvent.keyboard("{Space>}");
  await expect.poll(() => matrix(drawing).m11).toBeCloseTo(0.97, 2);
  await setMotion(true);
  await expect.poll(() => matrix(drawing).m11).toBe(1);
  expect(matrix(target, "::before").m11).toBe(1);
  expect(rect(target)).toEqual(before);
  expect(document.activeElement).toBe(target);
  await userEvent.keyboard("{/Space}");
  await setMotion(false);
  await userEvent.keyboard("{Space>}");
  await expect.poll(() => matrix(drawing).m11).toBeCloseTo(0.97, 2);
  flushSync(() => setDisabled(true));
  expect(matrix(drawing).m11).toBe(1);
  expect(matrix(target, "::before").m11).toBe(1);
  expect(rect(target)).toEqual(before);
  await screen.unmount();
});

test.each(["touch", "pen"] as const)("%s press state clears on cancel, leave, a second pointer, disable and unmount without cancelling native events", async pointerType => {
  let disable!: (value: boolean) => void;
  let show!: (value: boolean) => void;
  function Fixture() {
    const [disabled, setDisabled] = useState(false);
    const [shown, setShown] = useState(true);
    useLayoutEffect(() => { disable = setDisabled; show = setShown; }, []);
    return shown ? <ActionIcon aria-label="Touch fixture" disabled={disabled}><Copy size={16} /></ActionIcon> : null;
  }
  const screen = await renderPwa(<Fixture />);
  const target = screen.getByRole("button", { name: "Touch fixture" }).element() as HTMLButtonElement;
  const drawing = target.querySelector(".mantine-ActionIcon-icon")!;
  const bounds = target.getBoundingClientRect();
  const dispatch = (type: string, init: PointerEventInit = {}) => {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType, isPrimary: true, button: 0, clientX: bounds.left + 10, clientY: bounds.top + 10, ...init });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };
  const start = () => { dispatch("pointerdown"); expect(target.hasAttribute("data-pwa-pressed")).toBe(true); };
  start();
  await expect.poll(() => matrix(drawing).m11).toBeCloseTo(0.97, 2);
  dispatch("pointercancel");
  expect(target.hasAttribute("data-pwa-pressed")).toBe(false);
  await expect.poll(() => matrix(drawing).m11).toBe(1);
  start();
  dispatch("pointermove", { clientX: bounds.left - 1 });
  expect(target.hasAttribute("data-pwa-pressed")).toBe(false);
  start();
  dispatch("pointerdown", { pointerId: 2, isPrimary: false });
  expect(target.hasAttribute("data-pwa-pressed")).toBe(false);
  start();
  flushSync(() => disable(true));
  await expect.poll(() => target.hasAttribute("data-pwa-pressed")).toBe(false);
  expect(matrix(drawing).m11).toBe(1);
  flushSync(() => disable(false));
  start();
  flushSync(() => show(false));
  await expect.poll(() => target.hasAttribute("data-pwa-pressed")).toBe(false);
  flushSync(() => show(true));
  const replacement = screen.getByRole("button", { name: "Touch fixture" }).element();
  replacement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, pointerType, isPrimary: true, button: 0 }));
  expect(replacement.hasAttribute("data-pwa-pressed")).toBe(true);
  await screen.unmount();
  expect(replacement.hasAttribute("data-pwa-pressed")).toBe(false);
});

function ComposerFixture() {
  const [draft, setDraft] = useState("Draft survives its container resizing");
  const [width, setWidth] = useState(320);
  const { setAppearance } = usePwaAppearance();
  const model = { id: "long-model-fixture", name: "A deliberately long model name for a narrow desktop panel", provider: "fixture", reasoning: true, context_window: 200_000, vision: true };
  return <div style={{ width: "100%" }}>
    <button type="button" onClick={() => setAppearance("light")}>Light fixture</button>
    <button type="button" onClick={() => setAppearance("dark")}>Dark fixture</button>
    <button type="button" onClick={() => setWidth(800)}>Widen fixture</button>
    <div data-testid="composer-container" style={{ width, maxWidth: "100%" }}>
      <MessageComposer enterSends={false} attachments={[]} canAttach sendingAttachments={false} attachmentNotice="Attachment limit fixture" isOnline isWorking={false} stopping={false}
        draft={draft} onDraftChange={setDraft} onSend={() => {}} onStop={() => {}} onAddFiles={() => {}} onRemoveAttachment={() => {}} onRetryAttachment={() => {}}
        commandModels={[model]} commandCurrentModel={model} commandCurrentModelFallback={null} commandThinking="high" commandPendingAction={null}
        onNewSession={() => {}} onCompactSession={() => {}} onSetModel={() => {}} onSetThinking={() => {}} onCommandsOpen={() => {}} />
    </div>
  </div>;
}

test("Composer owns its radius and light elevation without changing the shared radius or notice source", async () => {
  const screen = await renderPwa(<ComposerFixture />);
  await screen.getByRole("button", { name: "Light fixture" }).click();
  const card = document.querySelector<HTMLElement>(".pwa-composer-card")!;
  await expect.poll(() => getComputedStyle(card).boxShadow).not.toBe("none");
  expect(getComputedStyle(card).borderRadius).toBe("16px");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-radius-lg").trim()).toBe("12px");
  const notice = screen.getByText("Attachment limit fixture").element();
  expect(card.contains(notice)).toBe(false);
  expect(notice.getBoundingClientRect().bottom).toBeLessThanOrEqual(card.getBoundingClientRect().top);
  await screen.getByRole("button", { name: "Dark fixture" }).click();
  await expect.poll(() => getComputedStyle(card).boxShadow).toBe("none");
  expect(getComputedStyle(card).borderRadius).toBe("16px");
  expect(getComputedStyle(card).borderTopWidth).toBe("1px");
});

test("a narrow Composer adapts to its own container even on desktop without shrinking targets or clearing the draft", async () => {
  await page.viewport(1440, 900);
  const screen = await renderPwa(<ComposerFixture />);
  const container = screen.getByTestId("composer-container").element();
  const card = document.querySelector<HTMLElement>(".pwa-composer-card")!;
  const thinking = document.querySelector<HTMLElement>(".pwa-composer-model-thinking")!;
  expect(getComputedStyle(thinking).display).toBe("none");
  for (const button of card.querySelectorAll(".pwa-composer-footer button")) {
    const bounds = button.getBoundingClientRect();
    expect(Math.round(bounds.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(bounds.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(bounds.left)).toBeGreaterThanOrEqual(Math.round(card.getBoundingClientRect().left));
    expect(Math.round(bounds.right)).toBeLessThanOrEqual(Math.round(card.getBoundingClientRect().right));
  }
  expect(Math.round(card.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(container.getBoundingClientRect().right));
  await screen.getByRole("button", { name: "Widen fixture" }).click();
  await expect.poll(() => getComputedStyle(thinking).display).not.toBe("none");
  expect((screen.getByRole("textbox").element() as HTMLTextAreaElement).value).toBe("Draft survives its container resizing");
});

function MenuFixture({ position = "top-start", onControl }: { position?: "top-start" | "bottom-end"; onControl?: (update: (opened: boolean) => void) => void }) {
  const [opened, setOpened] = useState(false);
  useLayoutEffect(() => { onControl?.(setOpened); }, [onControl]);
  const transition = usePwaMenuTransition();
  return <div style={{ position: "fixed", left: 80, top: 400 }}>
    <Menu opened={opened} onChange={setOpened} position={position} withinPortal portalProps={{ target: ".pwa-root" }} returnFocus transitionProps={transition}>
      <Menu.Target><Button>Menu fixture</Button></Menu.Target>
      <Menu.Dropdown className="pwa-menu-motion pwa-command-menu-dropdown" inert={!opened}>
        <Menu.Item className="pwa-command-row pwa-command-choice" data-selected>One line fixture</Menu.Item>
        <Menu.Item className="pwa-command-row"><span className="pwa-command-copy"><span>Two line fixture</span><small>Secondary fixture</small></span></Menu.Item>
      </Menu.Dropdown>
    </Menu>
    <NavLink className="pwa-nav-session" classNames={{ body: "pwa-nav-link-body", label: "pwa-nav-link-label", description: "pwa-nav-link-description" }} component="button" label="Session fixture" description="Secondary navigation fixture" />
  </div>;
}

async function sampleMenu(windowMs: number) {
  const result = { maxShift: 0, minScale: 1, minOpacity: 1 };
  const end = performance.now() + windowMs;
  await new Promise<void>(resolve => {
    const tick = () => {
      const node = document.querySelector(".pwa-menu-motion");
      if (node) {
        const transform = matrix(node);
        result.maxShift = Math.max(result.maxShift, Math.abs(transform.m41), Math.abs(transform.m42));
        result.minScale = Math.min(result.minScale, transform.m11);
        result.minOpacity = Math.min(result.minOpacity, Number(getComputedStyle(node).opacity));
      }
      if (performance.now() < end) requestAnimationFrame(tick); else resolve();
    };
    tick();
  });
  return result;
}

test.each([false, true])("action menu uses actual anchor, semantic timing and stationary reduced motion (reduce=%s)", async reduce => {
  await setMotion(reduce);
  let setOpened!: (opened: boolean) => void;
  const screen = await renderPwa(<MenuFixture onControl={update => { setOpened = update; }} />);
  const entering = sampleMenu(300);
  flushSync(() => setOpened(true));
  await expect.poll(() => document.querySelector(".pwa-menu-motion")).not.toBeNull();
  const menu = document.querySelector<HTMLElement>(".pwa-menu-motion")!;
  await expect.poll(() => getComputedStyle(menu).opacity).toBe("1");
  expect(menu.dataset.position).toBe("top-start");
  expect(getComputedStyle(menu).getPropertyValue("--pwa-menu-shift-y").trim()).toBe("4px");
  expect(parseFloat(getComputedStyle(menu).transitionDuration)).toBe(reduce ? 0.12 : 0.16);
  const enter = await entering;
  expect(enter.minOpacity).toBeLessThan(1);
  expect(enter.minScale).toBe(1);
  if (reduce) expect(enter.maxShift).toBe(0);
  else expect(enter.maxShift).toBeGreaterThan(0);
  flushSync(() => setOpened(false));
  expect(menu.hasAttribute("inert")).toBe(true);
  await expect.poll(() => menu.style.opacity).toBe("0");
  expect(parseFloat(getComputedStyle(menu).transitionDuration)).toBe(0.12);
  expect(getComputedStyle(menu).transitionTimingFunction).toBe(reduce ? "cubic-bezier(0.2, 0, 0, 1)" : "cubic-bezier(0.3, 0, 1, 1)");
  await expect.poll(() => document.querySelector(".pwa-menu-motion")).toBeNull();
  await screen.unmount();
});

test("fine and coarse input change visual density without overlapping 44px menu targets or clipping two-line navigation", async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  // Linux headless 禁用触控模拟后会报告 pointer: none 且无法恢复，fine 断言只在存在鼠标指针时执行。
  const fine = matchMedia("(pointer: fine)").matches;
  const screen = await renderPwa(<MenuFixture position="bottom-end" />);
  await screen.getByRole("button", { name: "Menu fixture" }).click();
  const row = screen.getByRole("menuitem", { name: "One line fixture" }).element();
  const second = screen.getByRole("menuitem", { name: "Two line fixture Secondary fixture" }).element();
  const navigation = document.querySelector<HTMLElement>(".pwa-nav-session")!;
  const description = navigation.querySelector<HTMLElement>(".pwa-nav-link-description")!;
  await expect.poll(() => getComputedStyle(document.querySelector(".pwa-menu-motion")!).opacity).toBe("1");
  expect(Math.round(row.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(second.getBoundingClientRect().top));
  const fineHeight = Math.round(navigation.getBoundingClientRect().height);
  if (fine) {
    expect(Math.round(row.getBoundingClientRect().height)).toBe(44);
    expect(Math.round(parseFloat(getComputedStyle(row, "::before").height))).toBe(40);
    const point = { x: row.getBoundingClientRect().left + 8, y: row.getBoundingClientRect().top + 1 };
    expect(document.elementFromPoint(point.x, point.y)?.closest("[data-menu-item]")).toBe(row);
    expect(getComputedStyle(navigation).paddingTop).toBe("4px");
  }
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await expect.poll(() => matchMedia("(any-pointer: coarse)").matches).toBe(true);
  await expect.poll(() => getComputedStyle(navigation).paddingTop).toBe("6px");
  expect(Math.round(parseFloat(getComputedStyle(row, "::before").height))).toBe(44);
  if (fine) expect(Math.round(navigation.getBoundingClientRect().height)).toBeGreaterThan(fineHeight);
  expect(Math.round(description.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(navigation.getBoundingClientRect().bottom));
  expect(getComputedStyle(navigation).minHeight).toBe("44px");
});

test.each(["entering", "entered"] as const)("a menu adopts runtime reduced motion while %s before its next close", async phase => {
  let setOpened!: (opened: boolean) => void;
  await renderPwa(<MenuFixture onControl={update => { setOpened = update; }} />);
  flushSync(() => setOpened(true));
  await expect.poll(() => document.querySelector(".pwa-menu-motion")).not.toBeNull();
  if (phase === "entered") await expect.poll(() => getComputedStyle(document.querySelector(".pwa-menu-motion")!).opacity).toBe("1");
  await setMotion(true);
  const menu = document.querySelector<HTMLElement>(".pwa-menu-motion")!;
  await expect.poll(() => getComputedStyle(menu).transitionDuration).toBe("0.12s");
  const exiting = sampleMenu(200);
  flushSync(() => setOpened(false));
  await expect.poll(() => document.querySelector(".pwa-menu-motion")).toBeNull();
  const result = await exiting;
  expect(result.maxShift).toBe(0);
  expect(result.minScale).toBe(1);
});
