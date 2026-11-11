import { afterEach, beforeEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { installSystemTextSizeTracking, resetTextSizeStateForTest, setSystemBodyProbeForTest, TEXT_SIZE_STORAGE_KEY } from "@/lib/ui/text-size";
import { usePwaTextSize } from "./use-pwa-text-size";

function Harness() {
  const { textSize, preference, followsSystem, setTextSize } = usePwaTextSize();
  return <div>
    <output aria-label="Text size">{textSize}</output>
    <output aria-label="Preference">{preference}:{String(followsSystem)}</output>
    <button type="button" onClick={() => setTextSize("system")}>System</button>
    <button type="button" onClick={() => setTextSize("standard")}>Standard</button>
    <button type="button" onClick={() => setTextSize("large")}>Large</button>
    <button type="button" onClick={() => setTextSize("xlarge")}>Extra large</button>
  </div>;
}

beforeEach(() => {
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  resetTextSizeStateForTest();
});

afterEach(async () => {
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  setSystemBodyProbeForTest(null);
  resetTextSizeStateForTest();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp().send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
});

test("applies and persists a text size tier immediately", async () => {
  const screen = await renderPwa(<Harness />);
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-text-body").trim()).toBe("16px");

  await screen.getByRole("button", { name: "Large", exact: true }).click();
  expect(document.querySelector('output[aria-label="Text size"]')?.textContent).toBe("large");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("large");
  expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--pwa-text-body").trim()).toBe("18px");

  await screen.getByRole("button", { name: "Extra large" }).click();
  expect(document.querySelector('output[aria-label="Text size"]')?.textContent).toBe("xlarge");
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
  expect(document.querySelector('output[aria-label="Text size"]')?.textContent).toBe("xlarge");
  await screen.unmount();

  window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "small");
  resetTextSizeStateForTest();
  screen = await renderPwa(<Harness />);
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");
  expect(document.querySelector('output[aria-label="Text size"]')?.textContent).toBe("standard");
  await screen.unmount();
});

test("follows the system text size until a tier is chosen and re-reads it when the app becomes visible", async () => {
  let systemBody: number | null = 19;
  setSystemBodyProbeForTest(() => systemBody);
  const stopTracking = installSystemTextSizeTracking();
  const screen = await renderPwa(<Harness />);
  const preference = () => document.querySelector('output[aria-label="Preference"]')?.textContent;
  expect(preference()).toBe("system:true");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("large");
  // 跟随系统是默认值，不写入存储。
  expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBeNull();

  systemBody = 23;
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => document.documentElement.getAttribute("data-pwa-text-size")).toBe("xlarge");

  await screen.getByRole("button", { name: "Standard", exact: true }).click();
  expect(preference()).toBe("standard:true");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");

  await screen.getByRole("button", { name: "System", exact: true }).click();
  expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("system");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("xlarge");
  stopTracking();
  await screen.unmount();
});

test("resolves the system preference to standard where the system size is unreadable", async () => {
  window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "system");
  resetTextSizeStateForTest();
  const screen = await renderPwa(<Harness />);
  expect(document.querySelector('output[aria-label="Preference"]')?.textContent).toBe("system:false");
  expect(document.documentElement.getAttribute("data-pwa-text-size")).toBe("standard");
  await screen.unmount();
});

test("touch-first devices read from a larger base than desktop at every tier", async () => {
  const tokens = () => {
    const style = getComputedStyle(document.documentElement);
    return ["meta", "list", "body", "code", "title", "page", "heading", "subheading"].map(name => style.getPropertyValue(`--pwa-text-${name}`).trim()).join(" ");
  };
  const screen = await renderPwa(<Harness />);
  expect(matchMedia("(pointer: coarse)").matches).toBe(false);
  expect(tokens()).toBe("13px 14px 16px 14px 18px 24px 20px 18px");

  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp().send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await expect.poll(() => matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(tokens()).toBe("14px 16px 17px 14px 18px 28px 22px 20px");
  // 触控模拟下鼠标点击会被改写成触摸事件，这里直接切换根节点档位。
  document.documentElement.dataset.pwaTextSize = "large";
  expect(tokens()).toBe("15px 18px 19px 16px 20px 30px 24px 22px");
  document.documentElement.dataset.pwaTextSize = "xlarge";
  expect(tokens()).toBe("16px 20px 21px 18px 22px 32px 26px 24px");
  await screen.unmount();
});
