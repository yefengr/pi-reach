import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { usePwaAppearance } from "./pwa-appearance";

function AppearanceHarness() {
  const { appearance, setAppearance } = usePwaAppearance();
  return <div>
    <output aria-label="Selected appearance">{appearance}</output>
    <button type="button" onClick={() => setAppearance("system")}>System</button>
    <button type="button" onClick={() => setAppearance("light")}>Light</button>
    <button type="button" onClick={() => setAppearance("dark")}>Dark</button>
  </div>;
}

let themeColorMetas: HTMLMetaElement[];

beforeEach(() => {
  window.localStorage.removeItem("pi-reach-appearance");
  document.documentElement.removeAttribute("data-mantine-color-scheme");
  themeColorMetas = ["light", "dark"].map((scheme) => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.media = `(prefers-color-scheme: ${scheme})`;
    meta.content = scheme === "light" ? "#FFFFFF" : "#1E1E1E";
    document.head.append(meta);
    return meta;
  });
});

afterEach(() => themeColorMetas.forEach((meta) => meta.remove()));

function expectThemeColor(color: string) {
  expect(themeColorMetas.map((meta) => meta.content)).toEqual([color, color]);
}

test("supports a persisted light/dark override and returning to System", async () => {
  const screen = await renderPwa(<AppearanceHarness />);
  // 手动切换经 View Transitions 交叉淡化，新外观在过渡回调里提交。
  const transition = vi.spyOn(document, "startViewTransition");
  await screen.getByRole("button", { name: "Dark" }).click();
  await expect.element(screen.getByRole("button", { name: "Dark" })).toBeVisible();
  await expect.poll(() => document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("dark");
  expect(transition).toHaveBeenCalledTimes(1);
  transition.mockRestore();
  expect(window.localStorage.getItem("pi-reach-appearance")).toBe("dark");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-bg").trim().toUpperCase()).toBe("#1E1E1E");
  expectThemeColor("#1E1E1E");

  await screen.getByRole("button", { name: "Light" }).click();
  await expect.poll(() => document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("light");
  expect(window.localStorage.getItem("pi-reach-appearance")).toBe("light");
  expectThemeColor("#FFFFFF");

  await screen.getByRole("button", { name: "System" }).click();
  await expect.poll(() => window.localStorage.getItem("pi-reach-appearance")).toBe("auto");
  expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("light");
  expect(window.localStorage.getItem("pi-reach-appearance")).toBe("auto");
  expectThemeColor("#FFFFFF");
  await screen.unmount();
});
