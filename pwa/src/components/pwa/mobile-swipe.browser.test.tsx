import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Menu } from "@mantine/core";
import { enableTouch, pointer, resetTouch, syntheticCapture, syntheticSwipe, touch, touchDrag, touchOrigin, touchTap } from "@/test/browser/swipe";
import { useSettingsRoute } from "@/lib/pwa/settings-route";
import { PwaUiProvider } from "./pwa-ui-provider";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaWorkspaceLayout } from "./pwa-workspace-layout";
import { MarkdownContent } from "./timeline-content";
import { ToolPreview } from "./tool-preview";
import { SessionActionsMenu } from "./session-actions-menu";
import type { ToolValue } from "./tool-presentation";
import type { WorkspaceNavigationProps } from "./workspace-view";
import "./tool-reader.css";

const wide = "unbroken_long_line_".repeat(60);
const columns = Array.from({ length: 18 }, (_, index) => `Column ${index}`);
const markdown = `Body **child text** for swipe.\n\n\`\`\`text\n${wide}\n\`\`\`\n\n| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.map(() => "Cell value").join(" | ")} |`;
const diff: ToolValue = { event_id: "event", session_id: "session", leaf_id: "leaf", group_id: "group", timestamp: 0, kind: "tool", tool_call_id: "call", tool: "edit", args: { path: "notes.txt" }, status: "complete", truncated: false, result: { diff: `-${wide}\n+${wide}` } };
let showMenu: (value: boolean) => void;
let enterSettings: () => void;
const navigation: WorkspaceNavigationProps = {
  devices: [], endpoints: [], history: [], activeDeviceId: null, activeEndpointId: null, selectedHistoryId: null, snapshotReady: true, pairingPresence: {},
  onPair: () => {}, onSettings: () => {}, onSelectDevice: () => {}, onSelectEndpoint: () => {}, onSelectHistory: () => {}, onRename: () => {}, onRemove: () => {},
};
function Harness({ clicks, empty = false }: { clicks: () => void; empty?: boolean }) {
  const { route, openSettings, closeSettings } = useSettingsRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  useLayoutEffect(() => {
    showMenu = setMenuOpen;
    enterSettings = () => openSettings({ kind: "workspace" });
  }, [openSettings]);
  return <PwaUiProvider><PwaAppShell runtimeNotice={null}><PwaWorkspaceLayout
    navigation={navigation} titleBar={{ title: "Swipe Pi", showTitle: true, moreMenu: <SessionActionsMenu info={{ name: "Swipe Pi", computer: "Computer", status: "Online", cwd: "/notes" }} /> }}
    historyMode={false} toast={null} settingsRoute={route} onOpenSettings={openSettings} onSettingsBack={closeSettings}
    renderSettings={({ titleRef }) => <><h1 ref={titleRef} id="pwa-settings-title" tabIndex={-1}>Settings</h1><button onClick={closeSettings}>Back</button></>}
    overlays={<Menu opened={menuOpen} onChange={setMenuOpen} withinPortal={false}><Menu.Target><button style={{ position: "absolute", right: 0, bottom: 0 }}>Command menu</button></Menu.Target><Menu.Dropdown><Menu.Item>New session</Menu.Item></Menu.Dropdown></Menu>}
    closeBackgroundOverlay={(close) => close()}
  >
    {empty ? <div className="pwa-workspace-state"><p data-testid="empty-copy">No messages</p></div> : <div className="pwa-message-list" data-testid="messages">
      <MarkdownContent text={markdown} />
      <ToolPreview value={diff} />
      <button type="button" data-testid="tap-button" onClick={clicks}>Ordinary action</button>
      {Array.from({ length: 35 }, (_, index) => <MarkdownContent key={index} text={`Paragraph ${index} with reading content to make the message list scroll.`} />)}
    </div>}
    <div className="pwa-composer"><input aria-label="Draft" /><span data-testid="composer-copy">Composer controls</span></div>
    <span contentEditable suppressContentEditableWarning data-testid="editable">Editable</span>
    <span data-swipe-ignore data-testid="ignored">Ignored</span>
  </PwaWorkspaceLayout></PwaAppShell></PwaUiProvider>;
}
async function setup(synthetic = true, empty = false) {
  const clicks = vi.fn();
  const screen = await render(<Harness clicks={clicks} empty={empty} />);
  const main = document.querySelector<HTMLElement>(".pwa-main")!;
  if (synthetic) syntheticCapture(main);
  const child = document.querySelector(".pwa-message-list strong") ?? screen.getByTestId("empty-copy").element();
  return { screen, main, child, clicks };
}
const navigationOpen = () => document.querySelector(".pwa-session-trigger")?.getAttribute("aria-expanded") === "true";

beforeEach(async () => {
  window.history.replaceState(null, "", "/app");
  window.localStorage.removeItem("pi-reach-sidebar-collapsed");
  window.getSelection()?.removeAllRanges();
  await page.viewport(390, 844);
  await enableTouch();
});
afterEach(async () => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  await resetTouch();
  window.history.replaceState(null, "", "/app");
  await page.viewport(1280, 900);
});

test("G1 from a body child opens navigation and closing returns focus to the visible trigger", async () => {
  const { screen, child } = await setup();
  syntheticSwipe(child);
  await expect.poll(navigationOpen).toBe(true);
  await screen.getByRole("button", { name: "Close navigation" }).click();
  await expect.poll(navigationOpen).toBe(false);
  await expect.element(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
});

test.each([
  ["vertical", 10, 100, "touch", 390], ["wrong direction", -100, 0, "touch", 390],
  ["mouse", 100, 0, "mouse", 390], ["desktop boundary", 100, 0, "touch", 768],
] as const)("G1 rejects %s", async (_label, dx, dy, pointerType, width) => {
  await page.viewport(width, 844);
  const { child } = await setup();
  syntheticSwipe(child, dx, dy, { pointerType });
  expect(navigationOpen()).toBe(false);
});

test("G1 excludes inputs, composer descendants, contenteditable, opt-out and selected text", async () => {
  const { screen, child } = await setup();
  for (const target of [screen.getByRole("textbox", { name: "Draft" }).element(), ...["composer-copy", "editable", "ignored"].map((id) => screen.getByTestId(id).element())]) {
    syntheticSwipe(target);
    expect(navigationOpen()).toBe(false);
  }
  const range = document.createRange(); range.selectNodeContents(child);
  window.getSelection()!.addRange(range);
  syntheticSwipe(child);
  expect(navigationOpen()).toBe(false);
});

test("G1 excludes real overflowing Markdown code, table and tool diff without changing their touch action", async () => {
  await setup();
  for (const selector of [".pwa-code-block pre", ".pwa-markdown-table", ".pwa-tool-diff-output"]) {
    const scroll = document.querySelector<HTMLElement>(selector)!;
    expect(scroll.scrollWidth, selector).toBeGreaterThan(scroll.clientWidth);
    expect(getComputedStyle(scroll).touchAction, selector).toBe("auto");
    syntheticSwipe(scroll.firstElementChild ?? scroll);
    expect(navigationOpen(), selector).toBe(false);
  }
});

test("G1 dynamically blocks actual command menu and nonmodal session info", async () => {
  const { screen, child } = await setup();
  flushSync(() => showMenu(true));
  await expect.element(screen.getByRole("menu")).toBeVisible();
  syntheticSwipe(child);
  expect(navigationOpen()).toBe(false);
  flushSync(() => showMenu(false));
  await screen.getByRole("button", { name: "Session details" }).click();
  const info = screen.getByRole("dialog", { name: "Session details" });
  await expect.element(info).toBeVisible();
  expect(info.element().getAttribute("aria-modal")).toBe("false");
  syntheticSwipe(child);
  expect(navigationOpen()).toBe(false);
});

test("G1 rechecks overlays at commit", async () => {
  const { child, main } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  flushSync(() => showMenu(true));
  pointer(main, "pointerup", 100);
  expect(navigationOpen()).toBe(false);
});

test("G1 blocks visible listboxes but ignores inert and aria-hidden exiting overlays", async () => {
  const { child, main, screen } = await setup();
  const overlay = document.createElement("div"); overlay.setAttribute("role", "listbox"); overlay.textContent = "Choices";
  overlay.style.cssText = "position:absolute;top:100px;width:80px;height:40px";
  main.closest(".pwa-root")!.append(overlay);
  syntheticSwipe(child); expect(navigationOpen()).toBe(false);
  overlay.inert = true;
  syntheticSwipe(child); await expect.poll(navigationOpen).toBe(true);
  await screen.getByRole("button", { name: "Close navigation" }).click();
  await expect.poll(navigationOpen).toBe(false);
  await expect.poll(() => document.querySelector(".pwa-session-sheet")).toBeNull();
  overlay.inert = false;
  overlay.setAttribute("aria-hidden", "true");
  syntheticSwipe(child); await expect.poll(navigationOpen).toBe(true);
  overlay.remove();
});

test.each(["child", "self"])("G1 distinguishes %s lost capture", async (target) => {
  const { child, main } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  pointer(target === "child" ? child : main, "lostpointercapture");
  pointer(main, "pointerup", 100);
  await expect.poll(navigationOpen).toBe(target === "child");
});

test("G1 cancels when settings opens and covers the existing scrollable empty state", async () => {
  const { child, main } = await setup();
  pointer(child, "pointerdown"); pointer(child, "pointermove", 50);
  flushSync(enterSettings);
  pointer(main, "pointerup", 100);
  expect(navigationOpen()).toBe(false);
  expect(getComputedStyle(main).touchAction).toBe("pan-y");
});

test("CDP G1 starts on a body child with implicit capture and commits after capture transfer", async () => {
  const { child } = await setup(false);
  await touchDrag(touchOrigin(child), 110, 0);
  await expect.poll(navigationOpen).toBe(true);
});

test("CDP existing scrollable empty-state body can open navigation", async () => {
  const { child } = await setup(false, true);
  expect(getComputedStyle(child.parentElement!).touchAction).toBe("pan-y");
  await touchDrag(touchOrigin(child, 8), 110, 0);
  await expect.poll(navigationOpen).toBe(true);
});

test("CDP vertical scrolling changes actual message scrollTop without opening navigation", async () => {
  const { screen } = await setup(false);
  const scroll = screen.getByTestId("messages").element() as HTMLElement;
  const before = scroll.scrollTop;
  await touchDrag(touchOrigin(scroll, 180, 350), 0, -160);
  await expect.poll(() => Math.round(scroll.scrollTop)).toBeGreaterThan(Math.round(before));
  expect(navigationOpen()).toBe(false);
});

test("CDP actual overflowing code scrolls horizontally without opening navigation", async () => {
  await setup(false);
  const code = document.querySelector<HTMLElement>(".pwa-code-block pre")!;
  expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
  const targets: string[] = [];
  document.addEventListener("pointerdown", (event) => targets.push((event.target as Element).outerHTML.slice(0, 160)), { once: true });
  await touchDrag(touchOrigin(code, 240), -130, 0);
  expect(targets.join(" "), JSON.stringify({ rect: code.getBoundingClientRect().toJSON(), frame: window.frameElement?.getBoundingClientRect().toJSON(), width: innerWidth })).toMatch(/<code/);
  await expect.poll(() => Math.round(code.scrollLeft)).toBeGreaterThan(0);
  expect(navigationOpen()).toBe(false);
});

test("CDP ordinary button tap clicks; swipe originating on that same button never clicks", async () => {
  const { screen, clicks } = await setup(false);
  const button = screen.getByTestId("tap-button").element();
  button.scrollIntoView({ block: "center" });
  const point = touchOrigin(button, 30);
  await touchTap(point);
  await expect.poll(() => clicks.mock.calls.length).toBe(1);
  clicks.mockClear();
  await touchDrag(point, 110, 0);
  await expect.poll(navigationOpen).toBe(true);
  expect(clicks).not.toHaveBeenCalled();
});

test.each(["inside", "outside"])("CDP second touch %s the surface cancels captured gesture", async (location) => {
  const { child, main } = await setup(false);
  const origin = touchOrigin(child);
  const first = { ...origin, x: origin.x + 50 };
  await touch("touchStart", [origin]);
  await touch("touchMove", [first]);
  // 外部触点实际命中主区之外的 Command menu 按钮，不只是另一 pointerId。
  const outside = document.querySelector(".pwa-root > button")!;
  const second = location === "inside" ? { ...origin, x: origin.x + 20, y: origin.y + 80, id: 2 } : { ...touchOrigin(outside), id: 2 };
  if (location === "outside") expect(main.contains(document.elementFromPoint(second.x, second.y))).toBe(false);
  await touch("touchStart", [first, second]);
  await touch("touchMove", [{ ...first, x: origin.x + 110 }, second]);
  await touch("touchEnd", []);
  expect(navigationOpen()).toBe(false);
});
