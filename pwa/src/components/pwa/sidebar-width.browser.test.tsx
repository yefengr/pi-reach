import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { useSidebarWidth } from "./use-sidebar-width";
import { SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH_KEY } from "@/lib/ui/sidebar-width";

function WidthHarness() {
  const root = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(true);
  const sidebar = useSidebarWidth(root, enabled);
  return <div className="pwa-root" data-resizing={sidebar.dragging || undefined} ref={root} style={{ width: "100vw" }}>
    <div role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-controls="test-navigation" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={sidebar.cap} aria-valuenow={sidebar.width} tabIndex={sidebar.enabled ? 0 : -1} onPointerDown={sidebar.onPointerDown} onKeyDown={sidebar.onKeyDown} onDoubleClick={sidebar.onDoubleClick} style={{ width: 8, height: 300 }} />
    <div id="test-navigation" style={{ width: sidebar.width }} />
    <button onClick={() => setEnabled((current) => !current)}>Toggle availability</button>
    <textarea aria-label="Draft" />
  </div>;
}
// 存储故障只施加给宽度 hook，避免 Mantine 外观管理器成为无关的故障源。
const colorSchemeManager = { get: () => "light" as const, set() {}, subscribe() {}, unsubscribe() {}, clear() {} };
const mount = () => render(<PwaUiProvider colorSchemeManager={colorSchemeManager}><PwaAppShell runtimeNotice={null}><WidthHarness /></PwaAppShell></PwaUiProvider>);

beforeEach(async () => {
  localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  await page.viewport(1280, 900);
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  for (const name of ["left", "right"]) document.documentElement.style.removeProperty(`--pwa-safe-${name}`);
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
});

test("keyboard separator saves explicit choices and preserves draft node across disable/enable", async () => {
  const screen = await mount();
  const separator = screen.getByRole("separator", { name: "Resize sidebar" });
  await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  const draft = screen.getByRole("textbox", { name: "Draft" });
  await draft.fill("Unsent draft");
  const node = draft.element();
  separator.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "288");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("288");
  await userEvent.keyboard("{Home}");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "240");
  await userEvent.keyboard("{End}");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "360");
  await screen.getByRole("button", { name: "Toggle availability" }).click();
  await expect.element(separator).toHaveAttribute("tabindex", "-1");
  separator.element().focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("360");
  await screen.getByRole("button", { name: "Toggle availability" }).click();
  await expect.element(separator).toHaveAttribute("aria-valuenow", "360");
  expect(draft.element()).toBe(node);
  await expect.element(draft).toHaveValue("Unsent draft");
});

test("viewport caps never overwrite preference, mobile disables resize and wider viewport restores", async () => {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
  const screen = await mount();
  const separator = screen.getByRole("separator", { name: "Resize sidebar" });
  await page.viewport(768, 900);
  await expect.element(separator).toHaveAttribute("aria-valuemax", "276");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "276");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("360");
  await page.viewport(390, 844);
  await expect.element(separator).toHaveAttribute("tabindex", "-1");
  await page.viewport(1280, 900);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "360");
  await expect.element(separator).toHaveAttribute("tabindex", "0");
});

test("capped keyboard no-ops preserve preference and double-click stores the uncapped default", async () => {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
  await page.viewport(768, 900);
  const screen = await mount();
  const separator = screen.getByRole("separator");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "276");
  separator.element().focus();
  await userEvent.keyboard("{ArrowRight}{End}");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("360");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "268");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("268");
  await userEvent.keyboard("{End}");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "276");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("276");
  separator.element().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await expect.element(separator).toHaveAttribute("aria-valuenow", "276");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("280");
  await page.viewport(1280, 900);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
});

test("invalid initialization and cross-tab updates validate without write-back", async () => {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, '"320"');
  const screen = await mount();
  const separator = screen.getByRole("separator", { name: "Resize sidebar" });
  await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('"320"');
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "320");
  window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY, newValue: "320", storageArea: localStorage }));
  await expect.element(separator).toHaveAttribute("aria-valuenow", "320");
  localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
});

/** 隔离 hook 生命周期；原生捕获与真实拖动另由生产页面 sidebar-width E2E 验证。 */
function pointerFixture(node: Element) {
  let captured = false;
  vi.spyOn(node, "setPointerCapture").mockImplementation(() => { captured = true; });
  vi.spyOn(node, "hasPointerCapture").mockImplementation(() => captured);
  const release = vi.spyOn(node, "releasePointerCapture").mockImplementation((pointerId) => {
    captured = false;
    node.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId }));
  });
  const send = (type: string, x = 4) => (node.isConnected ? node : window).dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
    clientX: x, clientY: 80, bubbles: true, cancelable: true,
  }));
  return { send, release, captured: () => captured };
}

test("isolated primary-left pointer previews immediately, clamps, commits once and double-click resets", async () => {
  const screen = await mount();
  const separator = screen.getByRole("separator");
  const node = separator.element();
  const pointer = pointerFixture(node);
  for (const init of [{ isPrimary: false, button: 0 }, { isPrimary: true, button: 2 }]) {
    node.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 9, bubbles: true }));
    expect(document.body.style.cursor).toBe("");
  }
  const save = vi.spyOn(Storage.prototype, "setItem");
  pointer.send("pointerdown");
  // 指针拖动不应主动抢走键盘焦点。
  expect(document.activeElement).not.toBe(node);
  expect(pointer.captured()).toBe(true);
  expect(document.body.style.cursor).toBe("col-resize");
  expect(document.body.style.userSelect).toBe("none");
  pointer.send("pointermove", 44);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "320");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  pointer.send("pointermove", 600);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "360");
  pointer.send("pointermove", -100);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "240");
  pointer.send("pointerup", -100);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("240");
  expect(save.mock.calls.filter(([key]) => key === SIDEBAR_WIDTH_KEY)).toEqual([[SIDEBAR_WIDTH_KEY, "240"]]);
  expect(pointer.captured()).toBe(false);
  expect(document.body.style.cursor).toBe("");
  expect(document.body.style.userSelect).toBe("");
  node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("280");
});

test.each(["pointercancel", "Escape", "lostcapture", "blur", "hidden", "unmount", "disable", "mobile"])("isolated %s cancels preview, releases capture and removes all drag listeners", async (reason) => {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "320");
  document.body.style.setProperty("cursor", "crosshair", "important");
  document.body.style.setProperty("user-select", "text", "important");
  const screen = await mount();
  const separator = screen.getByRole("separator");
  const node = separator.element();
  const pointer = pointerFixture(node);
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const removeTarget = vi.spyOn(node, "removeEventListener");
  pointer.send("pointerdown");
  pointer.send("pointermove", 28);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "344");
  if (reason === "pointercancel") pointer.send("pointercancel");
  if (reason === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  if (reason === "lostcapture") node.releasePointerCapture(1);
  if (reason === "blur") window.dispatchEvent(new Event("blur"));
  if (reason === "hidden") {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (reason === "unmount") await screen.unmount();
  if (reason === "disable") (screen.getByRole("button", { name: "Toggle availability" }).element() as HTMLButtonElement).click();
  if (reason === "mobile") await page.viewport(390, 844);
  await expect.poll(() => document.body.style.cursor).toBe("crosshair");
  expect(document.body.style.getPropertyPriority("cursor")).toBe("important");
  expect(document.body.style.userSelect).toBe("text");
  expect(document.body.style.getPropertyPriority("user-select")).toBe("important");
  expect(pointer.captured()).toBe(false);
  for (const name of ["pointermove", "pointerup", "pointercancel", "blur"]) expect(removeWindow).toHaveBeenCalledWith(name, expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith("keydown", expect.any(Function), true);
  expect(removeTarget).toHaveBeenCalledWith("lostpointercapture", expect.any(Function));
  pointer.send("pointermove", 40);
  pointer.send("pointerup", 40);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("320");
  if (reason !== "unmount" && reason !== "mobile") await expect.element(separator).toHaveAttribute("aria-valuenow", "320");
});

test("safe-area cap and a stationary press preserve the wider preference until an actual resize", async () => {
  await page.viewport(844, 900);
  document.documentElement.style.setProperty("--pwa-safe-left", "28px");
  document.documentElement.style.setProperty("--pwa-safe-right", "48px");
  localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
  const screen = await mount();
  const separator = screen.getByRole("separator");
  const pointer = pointerFixture(separator.element());
  await expect.element(separator).toHaveAttribute("aria-valuemax", "276");
  pointer.send("pointerdown");
  pointer.send("pointerup");
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("360");
  pointer.send("pointerdown");
  pointer.send("pointermove", -12);
  await expect.element(separator).toHaveAttribute("aria-valuenow", "260");
  pointer.send("pointerup", -12);
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("260");
});

test.each(["initialize", "write", "event"])("storage unavailable during %s keeps resize usable without uncaught getter failures", async (phase) => {
  const area = window.localStorage;
  if (phase === "initialize") vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Storage unavailable"); });
  const screen = await mount();
  const separator = screen.getByRole("separator");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
  if (phase === "write") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  separator.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(separator).toHaveAttribute("aria-valuenow", "288");
  if (phase === "event") {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Storage unavailable"); });
    window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY, storageArea: area }));
    await expect.element(separator).toHaveAttribute("aria-valuenow", "280");
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(separator).toHaveAttribute("aria-valuenow", "288");
  }
});
