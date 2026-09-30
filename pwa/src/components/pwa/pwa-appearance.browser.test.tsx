import { beforeEach, expect, test } from "vitest";
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

beforeEach(() => {
  window.localStorage.removeItem("pi-reach-appearance");
  document.documentElement.removeAttribute("data-mantine-color-scheme");
});

test("supports a persisted light/dark override and returning to System", async () => {
  const screen = await renderPwa(<AppearanceHarness />);
  await screen.getByRole("button", { name: "Dark" }).click();
  await expect.element(screen.getByRole("button", { name: "Dark" })).toBeVisible();
  expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("dark");
  expect(window.localStorage.getItem("pi-reach-appearance")).toBe("dark");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-bg").trim().toUpperCase()).toBe("#202325");

  await screen.getByRole("button", { name: "Light" }).click();
  expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("light");
  expect(window.localStorage.getItem("pi-reach-appearance")).toBe("light");

  await screen.getByRole("button", { name: "System" }).click();
  expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("light");
  expect(window.localStorage.getItem("pi-reach-appearance")).toBe("auto");
  await screen.unmount();
});
