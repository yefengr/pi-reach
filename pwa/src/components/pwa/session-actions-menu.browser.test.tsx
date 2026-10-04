import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { SessionActionsMenu, type SessionActionsMenuProps } from "./session-actions-menu";
import { PwaUiProvider } from "./pwa-ui-provider";

const directory = "/Users/pi/Code/pi-reach/packages/protocol";
const defaultInfo = { name: "Release check with a very long session name that wraps inside the information area", cwd: directory, computer: "Studio Mac", status: "Idle" };

function InfoHarness({ info = defaultInfo }: Partial<SessionActionsMenuProps>) {
  return <><SessionActionsMenu info={info} /><button type="button">Outside focus</button></>;
}

async function openInfo(screen: Awaited<ReturnType<typeof renderPwa>>) {
  const trigger = screen.getByRole("button", { name: "Session details" });
  await trigger.click();
  const dialog = screen.getByRole("dialog", { name: "Session details" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toHaveFocus();
  return { trigger, dialog };
}

const shortcutModifier = navigator.platform.includes("Mac") ? "Meta" : "Control";

test("opens a named non-modal information dialog with a 44px trigger and description", async () => {
  const screen = await renderPwa(<InfoHarness />);
  const { trigger, dialog } = await openInfo(screen);
  const box = trigger.element().getBoundingClientRect();
  expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  await expect.element(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await expect.element(trigger).toHaveAttribute("aria-controls", dialog.element().id);
  await expect.element(dialog).toHaveAttribute("aria-modal", "false");
  const describedIds = dialog.element().getAttribute("aria-describedby")!.split(" ");
  expect(describedIds.map((id) => document.getElementById(id)?.textContent).join(" ")).toBe(`${defaultInfo.name} Studio Mac · Idle`);
  expect(dialog.element().closest(".pwa-root")).not.toBeNull();
  expect(dialog.element().querySelector('[role="menu"], [role="menuitem"], [role="separator"]')).toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("shows full read-only information with a native selectable working directory", async () => {
  const screen = await renderPwa(<InfoHarness />);
  const { dialog } = await openInfo(screen);
  const name = dialog.getByText(defaultInfo.name, { exact: true });
  await expect.element(name).toBeVisible();
  expect(getComputedStyle(name.element()).whiteSpace).not.toBe("nowrap");
  await expect.element(dialog.getByText("Studio Mac · Idle", { exact: true })).toBeVisible();
  const path = dialog.getByRole("textbox", { name: "Working directory" });
  await expect.element(path).toHaveValue(directory);
  await expect.element(path).toHaveAttribute("readonly");
  await userEvent.tab();
  await expect.element(path).toHaveFocus();
  await userEvent.keyboard(`{${shortcutModifier}>}a{/${shortcutModifier}}`);
  const input = path.element() as HTMLTextAreaElement;
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(directory.length);
  // 用真实快捷键验证原生 copy 事件与选中内容，不用 Clipboard API mock 冒充系统复制。
  const copies: string[] = [];
  let prevented = false;
  input.addEventListener("copy", (event) => {
    copies.push(input.value.slice(input.selectionStart, input.selectionEnd));
    prevented = event.defaultPrevented;
  }, { once: true });
  await userEvent.keyboard(`{${shortcutModifier}>}c{/${shortcutModifier}}`);
  await expect.poll(() => copies).toEqual([directory]);
  expect(prevented).toBe(false);
  await userEvent.keyboard("must not edit{Backspace}");
  await expect.element(path).toHaveValue(directory);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test.each(["Enter", "Space", "ArrowDown", "ArrowUp"])("opens keyboard information access with %s and restores the trigger on Escape", async (key) => {
  const screen = await renderPwa(<InfoHarness />);
  const trigger = screen.getByRole("button", { name: "Session details" });
  trigger.element().focus();
  await userEvent.keyboard(key === "Space" ? " " : `{${key}}`);
  const dialog = screen.getByRole("dialog", { name: "Session details" });
  await expect.element(dialog).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

test("does not trap Tab or steal focus after an outside click", async () => {
  const screen = await renderPwa(<InfoHarness />);
  const { trigger, dialog } = await openInfo(screen);
  await userEvent.tab();
  await expect.element(dialog.getByRole("textbox", { name: "Working directory" })).toHaveFocus();
  await userEvent.tab();
  expect(dialog.element().contains(document.activeElement)).toBe(false);
  const outside = screen.getByRole("button", { name: "Outside focus" });
  await outside.click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(outside).toHaveFocus();
  await trigger.click();
  await expect.element(screen.getByRole("dialog", { name: "Session details" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});

test("keeps focused content through information updates and focuses a quickly reopened dialog", async () => {
  const screen = await renderPwa(<InfoHarness />);
  const { trigger, dialog } = await openInfo(screen);
  const path = dialog.getByRole("textbox", { name: "Working directory" });
  await userEvent.tab();
  await expect.element(path).toHaveFocus();
  await screen.rerender(<PwaUiProvider><div className="pwa-root"><InfoHarness info={{ ...defaultInfo, status: "Running" }} /></div></PwaUiProvider>);
  await expect.element(path).toHaveFocus();
  await expect.element(dialog.getByText("Studio Mac · Running", { exact: true })).toBeVisible();
  (trigger.element() as HTMLButtonElement).click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  (trigger.element() as HTMLButtonElement).click();
  await expect.element(dialog).toHaveFocus();
  await screen.unmount();
  await expect.poll(() => document.querySelector(".pwa-session-actions-dropdown")).toBeNull();
});

test("keeps saved history without a directory accessible and information-only", async () => {
  const screen = await renderPwa(<InfoHarness info={{ name: "Saved session note", cwd: null, computer: "Studio Mac", status: "Read only" }} />);
  const { dialog } = await openInfo(screen);
  await expect.element(dialog.getByText("Saved session note", { exact: true })).toBeVisible();
  await expect.element(dialog.getByText("Studio Mac · Read only", { exact: true })).toBeVisible();
  expect(dialog.element().querySelector("textarea,button,[role=menuitem]")).toBeNull();
});

test.each([[1280, 900], [390, 844], [390, 500], [756, 413]])("keeps themed information and the full directory within %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const screen = await renderPwa(<div className="pwa-live-actions"><InfoHarness /></div>);
  const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
  try {
    const { dialog, trigger } = await openInfo(screen);
    const path = dialog.getByRole("textbox", { name: "Working directory" }).element() as HTMLTextAreaElement;
    for (const scheme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      const dropdown = dialog.element() as HTMLElement;
      await expect.poll(() => Math.round(dropdown.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
      const box = dropdown.getBoundingClientRect();
      expect(Math.round(box.left)).toBeGreaterThanOrEqual(0);
      expect(Math.round(box.top)).toBeGreaterThanOrEqual(0);
      expect(Math.round(box.bottom)).toBeLessThanOrEqual(height);
      expect(dropdown.scrollWidth).toBeLessThanOrEqual(dropdown.clientWidth);
      expect(path.scrollHeight).toBeLessThanOrEqual(path.clientHeight + 1);
      expect(getComputedStyle(path).fontSize).toBe("16px");
      expect(getComputedStyle(dropdown).zIndex).toBe("21");
      expect(dropdown.querySelector("button,[role=menuitem]")).toBeNull();
      await page.screenshot({ path: `../../../.vitest/screenshots/session-info-${width}x${height}-${scheme}.png` });
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveFocus();
  } finally {
    if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
    else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});
