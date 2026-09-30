import type { Page } from "playwright/test";
import { test, expect } from "./fixtures/pwa";

const APPEARANCE_STORAGE_KEY = "pi-reach-appearance";
const PAIRING_HEADING = "No computers paired yet";
const APPEARANCE_SEEDED_MARKER = "pi-reach-e2e-appearance-seeded";

test.use({ serviceWorkers: "block" });

test("restores the saved appearance before application JavaScript loads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript((key) => localStorage.setItem(key, "dark"), APPEARANCE_STORAGE_KEY);
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/app");

  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  await expect(page.locator("#root")).toBeEmpty();
});

type AppearanceScenario = {
  name: string;
  systemColorScheme: "light" | "dark";
  storedValue: "auto" | "light" | "dark" | null;
  expectedColorScheme: "light" | "dark";
};

const appearanceScenarios: AppearanceScenario[] = [
  {
    name: "uses the light system scheme without a saved preference",
    systemColorScheme: "light",
    storedValue: null,
    expectedColorScheme: "light",
  },
  {
    name: "uses the dark system scheme without a saved preference",
    systemColorScheme: "dark",
    storedValue: null,
    expectedColorScheme: "dark",
  },
  {
    name: "uses the light system scheme with a saved auto preference",
    systemColorScheme: "light",
    storedValue: "auto",
    expectedColorScheme: "light",
  },
  {
    name: "uses the dark system scheme with a saved auto preference",
    systemColorScheme: "dark",
    storedValue: "auto",
    expectedColorScheme: "dark",
  },
  {
    name: "keeps a saved light preference over the dark system scheme",
    systemColorScheme: "dark",
    storedValue: "light",
    expectedColorScheme: "light",
  },
  {
    name: "keeps a saved dark preference over the light system scheme",
    systemColorScheme: "light",
    storedValue: "dark",
    expectedColorScheme: "dark",
  },
];

async function expectAppearanceReady(
  page: Page,
  scenario: AppearanceScenario,
) {
  await expect(page.getByRole("heading", { name: PAIRING_HEADING })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scenario.expectedColorScheme);
  await expect.poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey), APPEARANCE_STORAGE_KEY))
    .toBe(scenario.storedValue);
}

for (const scenario of appearanceScenarios) {
  test(scenario.name, async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.emulateMedia({ colorScheme: scenario.systemColorScheme });
    await page.addInitScript(({ storageKey, storedValue, seededMarker }) => {
      if (window.sessionStorage.getItem(seededMarker) === "true") return;
      if (storedValue === null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, storedValue);
      window.sessionStorage.setItem(seededMarker, "true");
    }, {
      storageKey: APPEARANCE_STORAGE_KEY,
      storedValue: scenario.storedValue,
      seededMarker: APPEARANCE_SEEDED_MARKER,
    });

    await page.goto("/app");
    await expectAppearanceReady(page, scenario);
    await page.reload();
    await expectAppearanceReady(page, scenario);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
