import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PairingDialog } from "./pairing-dialog";

type MockReader = {
  decodeFromConstraints: ReturnType<typeof vi.fn>;
  decodeFromImageUrl: ReturnType<typeof vi.fn>;
};

const desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36";

const zxing = vi.hoisted(() => {
  const decodeFromConstraints = vi.fn();
  const decodeFromImageUrl = vi.fn();
  const BrowserQRCodeReader = vi.fn(function MockBrowserQRCodeReader(this: MockReader) {
    this.decodeFromConstraints = decodeFromConstraints;
    this.decodeFromImageUrl = decodeFromImageUrl;
  });

  return { BrowserQRCodeReader, decodeFromConstraints };
});

vi.mock("@zxing/browser", () => ({ BrowserQRCodeReader: zxing.BrowserQRCodeReader }));

beforeEach(() => {
  zxing.decodeFromConstraints.mockClear();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(desktopUserAgent);
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function PairingFocusHarness({ onClose, connecting = false, withinPortal = false }: { onClose: () => void; connecting?: boolean; withinPortal?: boolean }) {
  const [opened, setOpened] = useState(false);
  const [focusOrigin, setFocusOrigin] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return <>
    <button ref={triggerRef} type="button" onClick={(event) => { setFocusOrigin(event.currentTarget); setOpened(true); }}>Open pairing</button>
    <PairingDialog opened={opened} connecting={connecting} error={null} onSubmit={() => {}} onClearError={() => {}} onClose={() => { onClose(); setOpened(false); }} focusOrigin={focusOrigin} withinPortal={withinPortal} />
  </>;
}

test("desktop pairing submits the code from a standard form dialog without starting the camera", async () => {
  const onSubmit = vi.fn();
  const screen = await renderPwa(<PairingDialog opened connecting={false} error={null} onSubmit={onSubmit} onClearError={vi.fn()} onClose={vi.fn()} withinPortal={false} />);
  const input = screen.getByRole("textbox", { name: "Pairing code" });

  const dialog = screen.getByRole("dialog", { name: "Pair a computer" });
  await expect.element(dialog).toBeVisible();
  expect(dialog.element().getBoundingClientRect().width).toBeLessThanOrEqual(480);
  expect(getComputedStyle(dialog.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(document.querySelector<HTMLInputElement>(".pwa-file-input")?.hidden).toBe(true);
  await expect.element(screen.getByRole("button", { name: "Pair", exact: true })).toBeDisabled();
  await expect.element(input).toHaveFocus();
  expect(zxing.decodeFromConstraints).not.toHaveBeenCalled();

  await input.fill("K7MP");
  await screen.getByRole("button", { name: "Pair", exact: true }).click();
  expect(onSubmit).toHaveBeenCalledWith("K7MP");
  expect(zxing.decodeFromConstraints).not.toHaveBeenCalled();
});

const pairingViewports = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
  { width: 390, height: 500 },
  { width: 756, height: 413 },
];

test.each(pairingViewports.flatMap((viewport) => ["light", "dark"].map((scheme) => ({ ...viewport, scheme }))))(
  "keeps the connecting indicator visible and animating under reduced motion at $width x $height in $scheme",
  async ({ width, height, scheme }) => {
    await page.viewport(width, height);
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    const originalScheme = document.documentElement.getAttribute("data-mantine-color-scheme");
    const onClose = vi.fn();
    const screen = await renderPwa(<PairingFocusHarness onClose={onClose} connecting withinPortal />);
    try {
      document.documentElement.setAttribute("data-mantine-color-scheme", scheme);
      const trigger = screen.getByRole("button", { name: "Open pairing" });
      trigger.element().focus();
      await trigger.click();
      const dialog = screen.getByRole("dialog", { name: "Pair a computer" });
      await expect.element(dialog).toBeVisible();
      await expect.element(screen.getByText("Connecting to your computer…")).toBeVisible();
      const card = dialog.element() as HTMLElement;
      const loader = card.querySelector<HTMLElement>(".pwa-pairing-status .mantine-Loader-root")!;
      await expect.poll(() => Math.round(loader.getBoundingClientRect().width)).toBe(16);
      await expect.poll(() => Math.round(loader.getBoundingClientRect().height)).toBe(16);
      expect(loader.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(loader).animationName).toBe("none");
      expect(getComputedStyle(loader, "::after").animationName).not.toBe("none");
      expect(getComputedStyle(loader, "::after").borderTopColor).toBe(scheme === "dark" ? "rgb(223, 186, 119)" : "rgb(144, 97, 31)");
      expect(dialog.element().closest(".pwa-root")).not.toBeNull();
      expect(card.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      // 连接中保留表单但暂不可用，不启动摄像头。
      expect(dialog.element().querySelector("video")).toBeNull();
      await expect.element(screen.getByRole("textbox", { name: "Pairing code" })).toBeDisabled();
      expect(zxing.decodeFromConstraints).not.toHaveBeenCalled();

      await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      // 加载指示器表达状态，减少动态效果时照常运行。
      await expect.poll(() => getComputedStyle(loader, "::after").animationName).not.toBe("none");
      await expect.element(screen.getByText("Connecting to your computer…")).toBeVisible();
      await page.screenshot({ path: `../../../.vitest/screenshots/pairing-loader-${width}x${height}-${scheme}.png` });
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      await expect.element(trigger).toHaveFocus();
    } finally {
      await screen.unmount();
      await cdp().send("Emulation.setEmulatedMedia", { features: [] });
      if (originalScheme === null) document.documentElement.removeAttribute("data-mantine-color-scheme");
      else document.documentElement.setAttribute("data-mantine-color-scheme", originalScheme);
      await page.viewport(1280, 900);
    }
  },
);

test.each([390, 1280])("keeps pairing dialog margins and grouping at %ipx", async (width) => {
  await page.viewport(width, 844);
  await renderPwa(<PairingDialog opened connecting={false} error={null} onSubmit={vi.fn()} onClearError={vi.fn()} onClose={vi.fn()} withinPortal={false} />);
  const content = document.querySelector<HTMLElement>(".pwa-pairing-dialog")!;
  if (width < 768) await expect.poll(() => Math.round(content.getBoundingClientRect().left)).toBe(16);
  else await expect.poll(() => Math.round(content.getBoundingClientRect().width)).toBe(480);
  await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  const title = document.querySelector(".pwa-pairing-title")!.getBoundingClientRect();
  const description = document.querySelector(".pwa-pairing-description")!.getBoundingClientRect();
  const label = document.querySelector(".pwa-pairing-form label")!.getBoundingClientRect();
  const input = document.querySelector(".pwa-pairing-form input")!.getBoundingClientRect();
  // 标题与关闭按钮同一行居中，标题到说明约 19px；各分组间距保持 16–20px，标签紧贴输入框。
  for (const gap of [description.top - title.bottom, label.top - description.bottom].map(Math.round)) {
    expect(gap).toBeGreaterThanOrEqual(16);
    expect(gap).toBeLessThanOrEqual(20);
  }
  expect(Math.round(input.top - label.bottom)).toBeLessThanOrEqual(8);
  expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
});

test("Escape closes pairing and returns focus to its trigger", async () => {
  const onClose = vi.fn();
  const screen = await renderPwa(<PairingFocusHarness onClose={onClose} />);
  const trigger = screen.getByRole("button", { name: "Open pairing" });
  trigger.element().focus();
  await trigger.click();
  await expect.element(screen.getByRole("dialog", { name: "Pair a computer" })).toBeVisible();

  await userEvent.keyboard("{Escape}");

  await expect.poll(() => document.querySelector(".pwa-pairing-dialog")).toBeNull();
  expect(onClose).toHaveBeenCalledTimes(1);
  await expect.element(trigger).toHaveFocus();
});
