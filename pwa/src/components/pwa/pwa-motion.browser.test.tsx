import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { ToolReader } from "./tool-reader";
import { PwaOperationNotifications } from "./pwa-operation-notifications";
import { createOperationNotificationController } from "@/lib/pwa/operation-notifications";
import type { ToolValue } from "./tool-presentation";

const tool: ToolValue = {
  event_id: "motion", session_id: "session", leaf_id: "generation", group_id: "group", timestamp: 0,
  kind: "tool", tool_call_id: "call", tool: "read", args: { path: "notes.txt" }, status: "complete", truncated: false,
  result: "First line\nSecond line",
};
const enterEase = "cubic-bezier(0, 0, 0, 1)";
const exitEase = "cubic-bezier(0.3, 0, 1, 1)";
const standardEase = "cubic-bezier(0.2, 0, 0, 1)";
const duration = (node: Element) => parseFloat(getComputedStyle(node).transitionDuration) * 1000;
const setMotion = (reduce: boolean) => cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });

function expectNoShift(node: Element) {
  const transform = getComputedStyle(node).transform;
  const matrix = new DOMMatrix(transform === "none" ? undefined : transform);
  expect(matrix.m41).toBe(0);
  expect(matrix.m42).toBe(0);
}

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

test.each([390, 1440].flatMap(width => [false, true].map(reduce => ({ width, reduce }))))("uses token timing, exit easing and stationary reduced motion for Modal/Reader at $width (reduce=$reduce)", async ({ width, reduce }) => {
  await page.viewport(width, 844);
  await setMotion(reduce);
  let setOpened!: (value: "modal" | "reader" | null) => void;
  function Harness() {
    const [opened, update] = useState<"modal" | "reader" | null>(null);
    setOpened = update;
    return <>
      <ConfirmActionDialog action={opened === "modal" ? { kind: "new-session" } : null} pending={false} error={null} onClose={() => update(null)} onConfirm={() => {}} />
      <ToolReader value={tool} opened={opened === "reader"} onClose={() => update(null)} />
    </>;
  }
  const screen = await renderPwa(<Harness />);
  try {
    for (const [kind, selector, enter, exit] of [["modal", ".pwa-confirm-dialog", 180, 140], ["reader", ".pwa-tool-reader[role='dialog']", 240, 200]] as const) {
      flushSync(() => setOpened(kind));
      await expect.poll(() => document.querySelector(selector)).not.toBeNull();
      const card = document.querySelector<HTMLElement>(selector)!;
      await expect.poll(() => getComputedStyle(card).opacity).toBe("1");
      expect(duration(card), card.outerHTML.slice(0, 800)).toBe(reduce ? 120 : enter);
      expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : enterEase);
      const overlay = document.querySelector<HTMLElement>(kind === "modal" ? ".mantine-Modal-overlay" : ".mantine-Drawer-overlay")!;
      expect(duration(overlay)).toBe(reduce ? 120 : enter);
      if (kind === "reader") {
        const command = card.querySelector<HTMLElement>(".pwa-tool-reader-command")!;
        expect(getComputedStyle(command).fontSize).toBe("12.5px");
        expect(getComputedStyle(command).lineHeight).toBe("19.375px");
      }
      flushSync(() => setOpened(null));
      await expect.poll(() => card.style.opacity).toBe("0");
      expect(duration(card)).toBe(reduce ? 120 : exit);
      expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : exitEase);
      expect(getComputedStyle(overlay).transitionTimingFunction).toBe(reduce ? standardEase : exitEase);
      if (reduce) expectNoShift(card);
      await expect.poll(() => document.querySelector(selector)).toBeNull();
    }
  } finally { await screen.unmount(); }
});

test.each([false, true])("uses token timing and distinct Toast exit easing (reduce=%s)", async reduce => {
  await setMotion(reduce);
  const controller = createOperationNotificationController();
  const screen = await renderPwa(<PwaOperationNotifications controller={controller} />);
  try {
    controller.show("model_set-error");
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).not.toBeNull();
    const card = document.querySelector<HTMLElement>(".pwa-operation-notification")!;
    await expect.poll(() => getComputedStyle(card).opacity).toBe("1");
    expect(duration(card)).toBe(reduce ? 120 : 180);
    expect(getComputedStyle(card).fontSize).toBe("14px");
    expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : enterEase);
    (screen.getByRole("button", { name: "Dismiss operation notification" }).element() as HTMLElement).click();
    await expect.poll(() => card.style.getPropertyValue("--notifications-state-opacity")).toBe("0");
    expect(getComputedStyle(card).transitionTimingFunction).toBe(reduce ? standardEase : exitEase);
    expect(duration(card)).toBe(reduce ? 120 : 180);
    if (reduce) expectNoShift(card);
    await expect.poll(() => document.querySelector(".pwa-operation-notification")).toBeNull();
  } finally { await screen.unmount(); }
});
