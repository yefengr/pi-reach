import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { AttachmentCards, type ComposerAttachmentItem } from "./attachment-cards";

const file: ComposerAttachmentItem = { id: "file", fileName: "Very long original file name ".repeat(8) + ".txt", byteLength: 2048, status: "draft" };
afterEach(async () => { document.documentElement.removeAttribute("data-mantine-color-scheme"); await page.viewport(1280, 900); });

test.each([320, 390, 1440].flatMap(width => ["light", "dark"].map(theme => ({ width, theme }))))("keeps compact cards and 44px actions at $width in $theme", async ({ width, theme }) => {
  await page.viewport(width, 900);
  const remove = vi.fn();
  const retry = vi.fn();
  const screen = await renderPwa(<div style={{ width: "min(680px, calc(100vw - 32px))", margin: "16px" }}><AttachmentCards items={[file, { ...file, id: "failed", fileName: "failed.txt", status: "failed", errorText: "Disk full" }, { ...file, id: "upload", fileName: "upload.txt", status: "uploading", receivedBytes: 1024 }, { ...file, id: "ready", fileName: "ready.txt", status: "complete" }]} onRemove={remove} onRetry={retry} /></div>);
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  const list = document.querySelector<HTMLElement>(".pwa-attachment-list")!;
  const cards = [...list.querySelectorAll<HTMLElement>(".pwa-attachment-card")];
  for (const card of cards) {
    expect(Math.round(card.getBoundingClientRect().height)).toBe(58);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    for (const button of card.querySelectorAll("button")) {
      expect(Math.round(button.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
  }
  expect(Math.round(cards[0].getBoundingClientRect().top) === Math.round(cards[1].getBoundingClientRect().top)).toBe(width >= 768);
  expect(cards[0].querySelector(".pwa-attachment-name")!.getAttribute("title")).toBe(file.fileName);
  expect(document.querySelectorAll(".pwa-attachment-progress")).toHaveLength(1);
  expect(document.querySelector('[data-status="complete"] button')).toBeNull();
  expect(document.querySelector('[data-status="complete"] .pwa-attachment-status')).toBeNull();
  expect(document.querySelector('[data-status="failed"] .pwa-attachment-progress')).toBeNull();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await screen.getByRole("button", { name: "Retry failed.txt" }).click();
  expect(retry).toHaveBeenCalledWith("failed");
  await screen.unmount();
});

test("collapse removes hidden keyboard targets and keeps focus on the toggle", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ ...file, id: `${index}`, fileName: `${index}.txt` }));
  const screen = await renderPwa(<AttachmentCards items={items} onRemove={() => {}} collapsible />);
  expect(document.querySelectorAll(".pwa-attachment-actions button")).toHaveLength(2);
  const toggle = document.querySelector<HTMLButtonElement>(".pwa-attachment-toggle")!;
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.querySelectorAll(".pwa-attachment-actions button")).toHaveLength(5);
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(toggle);
  expect(document.querySelectorAll(".pwa-attachment-actions button")).toHaveLength(2);
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement?.closest(".pwa-attachment-actions")).toBeNull();
  await screen.unmount();
});

test("readonly thumbnails have filename alternatives and fall back after decoding fails", async () => {
  const screen = await renderPwa(<AttachmentCards items={[{ ...file, fileName: "photo.jpg", preview: { mime_type: "image/jpeg", data: "YQ==", byte_length: 1, width: 1, height: 1 } }]} />);
  await expect.poll(() => document.querySelector(".pwa-attachment-file") !== null).toBe(true);
  expect(document.querySelector(".pwa-attachment-cards button")).toBeNull();
  expect(document.querySelector(".pwa-attachment-name")?.textContent).toBe("photo.jpg");
  await screen.unmount();
});
