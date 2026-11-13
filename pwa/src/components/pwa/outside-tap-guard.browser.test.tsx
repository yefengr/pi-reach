import { useState } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Menu } from "@mantine/core";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touchDrag, touchOrigin, touchTap } from "@/test/browser/swipe";
import { SessionActionsMenu } from "./session-actions-menu";

const info = { name: "Release check", cwd: "/Users/pi/Code/pi-reach", computer: "Studio Mac", status: "Idle" };
let presses = 0;
let picks = 0;

function Harness() {
  const [, setCount] = useState(0);
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 160 }}>
    <SessionActionsMenu info={info} />
    <Menu withinPortal portalProps={{ target: ".pwa-root" }} position="bottom-end">
      <Menu.Target><button type="button">Open menu</button></Menu.Target>
      <Menu.Dropdown><Menu.Item onClick={() => { picks += 1; }}>Pick</Menu.Item></Menu.Dropdown>
    </Menu>
    <button type="button" style={{ minHeight: 44 }} onClick={() => { presses += 1; setCount((count) => count + 1); }}>Outside action</button>
    <textarea aria-label="Outside field" />
  </div>;
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const visible = (element: HTMLElement | null) => !!element && !element.closest("[inert]") && element.getClientRects().length > 0;

async function mount() {
  const screen = await renderPwa(<Harness />);
  const trigger = screen.getByRole("button", { name: "Session details" });
  const outside = screen.getByRole("button", { name: "Outside action" });
  return { screen, trigger, outside };
}
async function openInfo(trigger: Awaited<ReturnType<typeof mount>>["trigger"]) {
  await touchTap(touchOrigin(trigger.element()));
  await expect.poll(() => visible(dialog())).toBe(true);
}

beforeEach(async () => {
  presses = 0;
  picks = 0;
  await page.viewport(390, 844);
  await enableTouch();
});
afterEach(async () => {
  await resetTouch();
  await page.viewport(1280, 900);
});

test("a touch tap outside an open popover only closes it, and the next tap reaches the control", async () => {
  const { trigger, outside } = await mount();
  await openInfo(trigger);
  await touchTap(touchOrigin(outside.element()));
  await expect.poll(() => visible(dialog())).toBe(false);
  expect(presses).toBe(0);
  await touchTap(touchOrigin(outside.element()));
  await expect.poll(() => presses).toBe(1);
});

test("a swallowed tap does not move focus into a field outside the popover", async () => {
  const { screen, trigger } = await mount();
  await openInfo(trigger);
  const field = screen.getByRole("textbox", { name: "Outside field" }).element();
  await touchTap(touchOrigin(field));
  await expect.poll(() => visible(dialog())).toBe(false);
  expect(document.activeElement).not.toBe(field);
});

test("tapping the popover's own trigger closes it and leaves later taps alone", async () => {
  const { trigger, outside } = await mount();
  await openInfo(trigger);
  await touchTap(touchOrigin(trigger.element()));
  await expect.poll(() => visible(dialog())).toBe(false);
  await touchTap(touchOrigin(outside.element()));
  await expect.poll(() => presses).toBe(1);
});

test("taps inside the open menu still activate its items", async () => {
  const { screen, outside } = await mount();
  await touchTap(touchOrigin(screen.getByRole("button", { name: "Open menu" }).element()));
  const item = screen.getByRole("menuitem", { name: "Pick" });
  await expect.element(item).toBeVisible();
  await touchTap(touchOrigin(item.element()));
  await expect.poll(() => picks).toBe(1);
  await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
  await touchTap(touchOrigin(outside.element()));
  await expect.poll(() => presses).toBe(1);
});

test("a scroll gesture outside the popover closes it without eating the following tap", async () => {
  const { trigger, outside } = await mount();
  await openInfo(trigger);
  await touchDrag(touchOrigin(outside.element()), 0, -120);
  await expect.poll(() => visible(dialog())).toBe(false);
  expect(presses).toBe(0);
  await touchTap(touchOrigin(outside.element()));
  await expect.poll(() => presses).toBe(1);
});

test("a mouse click outside still closes the popover and activates the control", async () => {
  await resetTouch();
  const { trigger, outside } = await mount();
  await trigger.click();
  await expect.poll(() => visible(dialog())).toBe(true);
  await userEvent.click(outside);
  await expect.poll(() => visible(dialog())).toBe(false);
  expect(presses).toBe(1);
});
