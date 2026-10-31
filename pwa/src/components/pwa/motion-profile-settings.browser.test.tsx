import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { Modal } from "@mantine/core";
import { renderPwa } from "@/test/browser/render";
import { applyStoredMotionProfile, MOTION_PROFILE_STORAGE_KEY, resetMotionProfileForTest } from "@/lib/ui/motion-profile";
import { MotionProfileSettings } from "./motion-profile-settings";

const root = () => document.documentElement;
const token = (name: string) => getComputedStyle(root()).getPropertyValue(name).trim();

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  localStorage.removeItem(MOTION_PROFILE_STORAGE_KEY);
  resetMotionProfileForTest();
});

test("motion style switches the content layer, persists locally and re-reads Mantine durations", async () => {
  function Probe() {
    const [opened, setOpened] = useState(false);
    return <><MotionProfileSettings /><button type="button" onClick={() => setOpened(true)}>Open probe</button><Modal opened={opened} onClose={() => setOpened(false)} title="Probe">body</Modal></>;
  }
  const screen = await renderPwa(<Probe />);
  const content = () => document.querySelector<HTMLElement>(".mantine-Modal-content")!;
  expect(page.getByRole("radio", { name: /iOS/ }).element()).toHaveProperty("checked", true);
  expect(token("--pwa-duration-message-in")).toBe("500ms");
  expect(token("--pwa-ease-content")).toMatch(/^linear\(0, /);

  await page.getByRole("radio", { name: /Relaxed/ }).click();
  expect(root().dataset.pwaMotion).toBe("symmetric");
  expect(localStorage.getItem(MOTION_PROFILE_STORAGE_KEY)).toBe("symmetric");
  expect(token("--pwa-duration-message-in")).toBe("300ms");
  expect(token("--pwa-ease-content")).toBe("cubic-bezier(0.2, 0, 0.2, 1)");
  // 操作反馈层不随风格变化。
  expect(token("--pwa-duration-press-in")).toBe("90ms");
  expect(token("--pwa-ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");

  await page.getByRole("radio", { name: /Decelerate/ }).click();
  expect(token("--pwa-ease-content")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  expect(token("--pwa-duration-modal-in")).toBe("280ms");
  // Provider 在风格切换后重读 Modal 时长。
  await page.getByRole("button", { name: "Open probe" }).click();
  await expect.poll(() => content()?.style.transitionDuration).toBe("280ms");

  // 系统减少动态效果优先于评估期风格。
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await expect.poll(() => token("--pwa-duration-message-in")).toBe("120ms");
  await screen.unmount();
});

test("stored motion style is restored before render and invalid values fall back to the spring default", () => {
  localStorage.setItem(MOTION_PROFILE_STORAGE_KEY, "decelerate");
  expect(applyStoredMotionProfile()).toBe("decelerate");
  expect(root().dataset.pwaMotion).toBe("decelerate");
  localStorage.setItem(MOTION_PROFILE_STORAGE_KEY, "bouncy");
  expect(applyStoredMotionProfile()).toBe("spring");
  expect(root().dataset.pwaMotion).toBe("spring");
});
