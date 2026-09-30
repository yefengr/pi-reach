import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { WireModel } from "@/lib/pi-reach/types";
import { SessionActionsMenu, type SessionActionsMenuProps } from "./session-actions-menu";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200000,
  vision: true,
};

type MenuHarnessProps = Partial<SessionActionsMenuProps>;

function MenuHarness({
  info = { name: "Release check with a very long session name that wraps inside the information area", cwd: "/Users/pi/Code/pi-reach/packages/protocol", computer: "Studio Mac", status: "Idle" },
  readOnly = false,
  isOnline = true,
  isWorking = false,
  pendingAction = null,
  models = [model],
  currentModel = model,
  currentModelFallback = null,
  thinking = "medium",
  onNewSession = () => {},
  onCompactSession = () => {},
  onSetModel = () => {},
  onSetThinking = () => {},
  onCommandsOpen = () => {},
  onRetry,
}: MenuHarnessProps) {
  return <>
    <SessionActionsMenu
      info={info}
      readOnly={readOnly}
      isOnline={isOnline}
      isWorking={isWorking}
      pendingAction={pendingAction}
      models={models}
      currentModel={currentModel}
      currentModelFallback={currentModelFallback}
      thinking={thinking}
      onNewSession={onNewSession}
      onCompactSession={onCompactSession}
      onSetModel={onSetModel}
      onSetThinking={onSetThinking}
      onCommandsOpen={onCommandsOpen}
      onRetry={onRetry}
    />
    <button type="button">Outside focus</button>
  </>;
}

async function openMenu(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "Session actions" });
  await trigger.click();
  const menu = screen.getByRole("menu", { name: "Session actions" });
  await expect.element(menu).toBeVisible();
  return { trigger, menu };
}

async function settleOverlayFocus() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
}

test("opens the icon trigger with one menu relationship and a 44px target", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const trigger = screen.getByRole("button", { name: "Session actions" });
  expect(trigger.element().getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  expect(trigger.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  const menu = screen.getByRole("menu", { name: "Session actions" });
  await expect.element(menu).toBeVisible();
  await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await expect.element(trigger).toHaveAttribute("aria-controls", menu.element().id);
  expect(menu.element().closest(".pwa-root")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
});

test("requests command models once per open", async () => {
  let commandOpens = 0;
  const screen = await renderPwa(<MenuHarness onCommandsOpen={() => { commandOpens += 1; }} />);
  const { trigger } = await openMenu(screen);
  expect(commandOpens).toBe(1);

  await userEvent.keyboard("{Escape}");
  await trigger.click();
  expect(commandOpens).toBe(2);
});

test("leaves model and thinking choices to the composer", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { menu } = await openMenu(screen);
  await expect.element(menu.getByRole("menuitem", { name: "New session" })).toBeVisible();
  await expect.element(menu.getByRole("menuitem", { name: "Compact context" })).toBeVisible();
  // 模型与思考级别只从输入区的模型标签与「/」菜单进入，会话菜单不重复。
  expect(menu.element().querySelector('[data-command-view="models"]')).toBeNull();
  expect(menu.element().querySelector('[data-command-view="thinking"]')).toBeNull();
  expect(menu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(2);
});

test("navigates keyboard focus through root commands and closes on Escape", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const trigger = screen.getByRole("button", { name: "Session actions" });
  trigger.element().focus();
  await userEvent.keyboard("{ArrowDown}");
  const newSession = screen.getByRole("menuitem", { name: "New session" });
  await expect.element(newSession).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(screen.getByRole("menuitem", { name: "Compact context" })).toHaveFocus();
  await userEvent.keyboard("{Home}");
  await expect.element(newSession).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(screen.getByRole("menuitem", { name: "Compact context" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});

test("closes before command callbacks and reopens at the root", async () => {
  let newSessionCalls = 0;
  let compactCalls = 0;
  const callbackFocus: Array<Element | null> = [];
  const callbackMenus: Array<Element | null> = [];
  const screen = await renderPwa(
    <MenuHarness
      onNewSession={() => { callbackFocus.push(document.activeElement); callbackMenus.push(document.querySelector(".pwa-session-actions-dropdown")); newSessionCalls += 1; }}
      onCompactSession={() => { callbackFocus.push(document.activeElement); callbackMenus.push(document.querySelector(".pwa-session-actions-dropdown")); compactCalls += 1; }}
    />,
  );
  const { trigger } = await openMenu(screen);
  await screen.getByRole("menuitem", { name: "New session" }).click();
  await expect.poll(() => newSessionCalls).toBe(1);
  await expect.element(screen.getByRole("menu", { name: "Session actions" })).not.toBeInTheDocument();

  await trigger.click();
  await screen.getByRole("menuitem", { name: "Compact context" }).click();
  await expect.poll(() => compactCalls).toBe(1);
  expect(callbackMenus).toEqual([null, null]);
  expect(callbackFocus).toEqual([trigger.element(), trigger.element()]);
  await expect.element(screen.getByRole("menu", { name: "Session actions" })).not.toBeInTheDocument();

  await trigger.click();
  await expect.element(screen.getByRole("menuitem", { name: "New session" })).toBeVisible();
});

test("keeps New session and Compact context disabled while working", async () => {
  const screen = await renderPwa(<MenuHarness isWorking />);
  await openMenu(screen);
  await expect.element(screen.getByRole("menuitem", { name: "New session" })).toBeDisabled();
  await expect.element(screen.getByRole("menuitem", { name: "Compact context" })).toBeDisabled();
});

test.each([{ isOnline: false }, { pendingAction: "model_set" as const }])("disables every command while offline or an action is pending: %j", async (props) => {
  const screen = await renderPwa(<MenuHarness {...props} />);
  await openMenu(screen);
  for (const name of ["New session", "Compact context"]) {
    await expect.element(screen.getByRole("menuitem", { name })).toBeDisabled();
  }
});

test("renders Retry and calls it after close", async () => {
  let retries = 0;
  const screen = await renderPwa(<MenuHarness onRetry={() => { retries += 1; }} />);
  await openMenu(screen);
  await expect.element(screen.getByRole("menuitem", { name: "Retry connection" })).toBeVisible();
  await screen.getByRole("menuitem", { name: "Retry connection" }).click();
  await expect.poll(() => retries).toBe(1);
  await expect.element(screen.getByRole("menu", { name: "Session actions" })).not.toBeInTheDocument();
});

test("closes outside without stealing valid focus and returns the trigger after Escape", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { trigger, menu } = await openMenu(screen);
  const outside = screen.getByRole("button", { name: "Outside focus" });
  await outside.click();
  await expect.element(menu).not.toBeInTheDocument();
  await settleOverlayFocus();
  await expect.element(outside).toHaveFocus();

  await trigger.click();
  const newSession = screen.getByRole("menuitem", { name: "New session" });
  newSession.element().focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});

test.each([[1280, 900], [390, 844], [390, 500], [756, 413]])("keeps the session menu themed and within %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const screen = await renderPwa(<div className="pwa-live-actions"><MenuHarness /></div>);
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  try {
    const { menu, trigger } = await openMenu(screen);
    await expect.poll(() => menu.element().getBoundingClientRect().right <= width).toBe(true);
    for (const scheme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      const dropdown = menu.element() as HTMLElement;
      const box = dropdown.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(height);
      expect(dropdown.scrollWidth).toBeLessThanOrEqual(dropdown.clientWidth);
      expect(dropdown.closest(".pwa-root")).not.toBeNull();
      expect(getComputedStyle(dropdown).zIndex).toBe("21");
      for (const item of dropdown.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
        expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: `../../../.vitest/screenshots/menu-session-${width}x${height}-${scheme}.png` });
    }
    await userEvent.keyboard("{Escape}");
    await settleOverlayFocus();
    await expect.element(trigger).toHaveFocus();
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("shows a read-only information area above the actions, and only the information area for history", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { menu } = await openMenu(screen);
  const info = menu.getByRole("group", { name: "Session details" });
  await expect.element(info).toBeVisible();
  await expect.element(info.getByText("/Users/pi/Code/pi-reach/packages/protocol", { exact: true })).toBeVisible();
  await expect.element(info.getByText("Studio Mac · Idle", { exact: true })).toBeVisible();
  const name = info.getByText(/^Release check with a very long session name/).element();
  expect(getComputedStyle(name).whiteSpace).not.toBe("nowrap");
  expect(info.element().compareDocumentPosition(menu.getByRole("menuitem", { name: /New session/ }).element()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await screen.unmount();

  const readOnly = await renderPwa(<MenuHarness readOnly />);
  const { menu: readOnlyMenu } = await openMenu(readOnly);
  await expect.element(readOnlyMenu.getByRole("group", { name: "Session details" })).toBeVisible();
  expect(readOnlyMenu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(0);
});
