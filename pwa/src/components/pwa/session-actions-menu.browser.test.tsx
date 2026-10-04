import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { SessionActionsMenu, type SessionActionsMenuProps } from "./session-actions-menu";

type MenuHarnessProps = Partial<SessionActionsMenuProps>;

function MenuHarness({
  info = { name: "Release check with a very long session name that wraps inside the information area", cwd: "/Users/pi/Code/pi-reach/packages/protocol", computer: "Studio Mac", status: "Idle" },
}: MenuHarnessProps) {
  return <>
    <SessionActionsMenu info={info} />
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

test("shows the full session information without commands or separators", async () => {
  const screen = await renderPwa(<MenuHarness />);
  const { menu } = await openMenu(screen);
  const info = menu.getByRole("group", { name: "Session details" });
  await expect.element(info).toBeVisible();
  await expect.element(info.getByText("/Users/pi/Code/pi-reach/packages/protocol", { exact: true })).toBeVisible();
  await expect.element(info.getByText("Studio Mac · Idle", { exact: true })).toBeVisible();
  const name = info.getByText(/^Release check with a very long session name/).element();
  expect(getComputedStyle(name).whiteSpace).not.toBe("nowrap");
  expect(menu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  expect(menu.element().querySelectorAll('[role="separator"]')).toHaveLength(0);
});

test.each(["ArrowDown", "ArrowUp"])("opens from the trigger with %s and returns focus after Escape", async (key) => {
  const screen = await renderPwa(<MenuHarness />);
  const trigger = screen.getByRole("button", { name: "Session actions" });
  trigger.element().focus();
  await userEvent.keyboard(`{${key}}`);
  const menu = screen.getByRole("menu", { name: "Session actions" });
  await expect.element(menu).toBeVisible();
  expect(menu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
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
  await expect.element(screen.getByRole("menu", { name: "Session actions" })).toBeVisible();
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
      expect(dropdown.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
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

test("shows only read-only information for saved history", async () => {
  const screen = await renderPwa(<MenuHarness info={{ name: "Saved session note", cwd: null, computer: "Studio Mac", status: "Read only" }} />);
  const { menu } = await openMenu(screen);
  const info = menu.getByRole("group", { name: "Session details" });
  await expect.element(info).toBeVisible();
  await expect.element(info.getByText("Saved session note", { exact: true })).toBeVisible();
  await expect.element(info.getByText("Studio Mac · Read only", { exact: true })).toBeVisible();
  expect(menu.element().querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  expect(menu.element().querySelectorAll('[role="separator"]')).toHaveLength(0);
});
