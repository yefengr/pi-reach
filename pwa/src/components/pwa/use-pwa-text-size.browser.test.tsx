import { afterEach, beforeEach, expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { resetTextSizeStateForTest, TEXT_SIZE_STORAGE_KEY } from "@/lib/ui/text-size";
import { usePwaTextSize } from "./use-pwa-text-size";

function Harness() {
  const { textSize, setTextSize } = usePwaTextSize();
  return <div>
    <output aria-label="Text size">{textSize}</output>
    <button type="button" onClick={() => setTextSize("standard")}>Standard</button>
    <button type="button" onClick={() => setTextSize("large")}>Large</button>
    <button type="button" onClick={() => setTextSize("xlarge")}>Extra large</button>
  </div>;
}

beforeEach(() => {
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  resetTextSizeStateForTest();
});

afterEach(() => {
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  resetTextSizeStateForTest();
});

test("applies and persists a text size tier immediately", async () => {
  const screen = await renderPwa(<Harness />);
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-text-body").trim()).toBe("16px");

  await screen.getByRole("button", { name: "Large", exact: true }).click();
  expect(document.querySelector("output")?.textContent).toBe("large");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("large");
  expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-text-body").trim()).toBe("18px");

  await screen.getByRole("button", { name: "Extra large" }).click();
  expect(document.querySelector("output")?.textContent).toBe("xlarge");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("xlarge");
  expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("xlarge");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-text-body").trim()).toBe("20px");
  await screen.unmount();
});

test("restores a stored tier and falls back from invalid values", async () => {
  window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "xlarge");
  resetTextSizeStateForTest();
  let screen = await renderPwa(<Harness />);
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("xlarge");
  expect(document.querySelector("output")?.textContent).toBe("xlarge");
  await screen.unmount();

  window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "small");
  resetTextSizeStateForTest();
  screen = await renderPwa(<Harness />);
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");
  expect(document.querySelector("output")?.textContent).toBe("standard");
  await screen.unmount();
});
