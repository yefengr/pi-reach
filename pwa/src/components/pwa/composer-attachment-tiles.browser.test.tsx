import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
import type { ComposerAttachmentItem } from "./attachment-cards";
import { ComposerAttachmentTiles } from "./composer-attachment-tiles";

const file: ComposerAttachmentItem = { id: "file", fileName: "notes.txt", byteLength: 2048, status: "draft" };
const many = Array.from({ length: 10 }, (_, index) => ({ ...file, id: `file-${index}`, fileName: `file-${index}.log` }));

function Card({ children }: { children: ReactNode }) {
  return <div className="pwa-composer-card" style={{ width: 340, margin: 40 }}>{children}</div>;
}

test("keeps every tile on one scrolling row without folding, so each remove stays reachable by keyboard", async () => {
  await page.viewport(390, 844);
  const onRemove = vi.fn();
  const screen = await renderPwa(<Card><ComposerAttachmentTiles items={many} onRemove={onRemove} /></Card>);
  try {
    const row = document.querySelector<HTMLElement>(".pwa-attachment-tiles")!;
    const tiles = [...row.querySelectorAll<HTMLElement>(".pwa-attachment-tile")];
    expect(tiles).toHaveLength(10);
    expect(new Set(tiles.map(tile => Math.round(tile.getBoundingClientRect().top))).size).toBe(1);
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
    expect(getComputedStyle(row).overflowX).toBe("auto");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const removes = [...row.querySelectorAll<HTMLButtonElement>(".pwa-attachment-tile-remove")];
    expect(removes).toHaveLength(10);
    removes[9]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRemove).toHaveBeenCalledWith("file-9");
    // 聚焦到行尾的角标时滚动区跟随，角标没有被滚动容器裁切。
    const last = removes[9]!.getBoundingClientRect();
    expect(last.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 0.5);
  } finally {
    await screen.unmount();
  }
});

test("shows the file name in a tooltip on hover and keyboard focus", async () => {
  const screen = await renderPwa(<Card><ComposerAttachmentTiles items={[file, { ...file, id: "paused", fileName: "paused.bin", status: "paused", receivedBytes: 1024 }]} onRemove={() => {}} /></Card>);
  try {
    await userEvent.hover(screen.getByRole("group", { name: "notes.txt" }));
    await expect.element(page.getByRole("tooltip")).toHaveTextContent("notes.txt");
    await userEvent.unhover(screen.getByRole("group", { name: "notes.txt" }));
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
    // 聚焦进入方块内的角标同样弹出，状态短词一并给出。
    screen.getByRole("button", { name: "Cancel paused.bin" }).element().focus();
    await expect.element(page.getByRole("tooltip")).toHaveTextContent("paused.bin · Paused");
  } finally {
    await screen.unmount();
  }
});

test("draws a 36px ring with the percentage for uploads and lets a failed tile retry", async () => {
  const onRetry = vi.fn();
  const screen = await renderPwa(<Card><ComposerAttachmentTiles items={[
    { ...file, id: "uploading", fileName: "uploading.txt", status: "uploading", receivedBytes: 1536 },
    { ...file, id: "failed", fileName: "failed.txt", status: "failed", errorText: "Disk full" },
  ]} onRemove={() => {}} onRetry={onRetry} /></Card>);
  try {
    const ring = screen.getByRole("progressbar", { name: "Upload progress for uploading.txt" });
    await expect.element(ring).toHaveAttribute("aria-valuenow", "75");
    const box = ring.element().getBoundingClientRect();
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([36, 36]);
    expect(ring.element().textContent).toBe("75");
    const retry = screen.getByRole("button", { name: "Retry failed.txt" });
    const retryBox = retry.element().getBoundingClientRect();
    expect(Math.round(retryBox.width)).toBeGreaterThanOrEqual(44);
    await retry.click();
    expect(onRetry).toHaveBeenCalledWith("failed");
    await expect.element(screen.getByRole("group", { name: "failed.txt，Disk full" })).toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

test("a new tile fades in; a removed tile fades out in place while the others take its space at once", async () => {
  const two = [{ ...file, id: "a", fileName: "a.txt" }, { ...file, id: "b", fileName: "b.txt" }];
  const tree = (items: ComposerAttachmentItem[]) => <PwaUiProvider><div className="pwa-root"><Card><ComposerAttachmentTiles items={items} onRemove={() => {}} /></Card></div></PwaUiProvider>;
  const screen = await renderPwa(<Card><ComposerAttachmentTiles items={two.slice(0, 1)} onRemove={() => {}} /></Card>);
  try {
    await screen.rerender(tree(two));
    const second = screen.getByRole("group", { name: "b.txt" }).element() as HTMLElement;
    expect(getComputedStyle(second).transitionProperty).toContain("opacity");
    await expect.poll(() => getComputedStyle(second).opacity).toBe("1");
    const secondLeft = Math.round(second.getBoundingClientRect().left);
    const first = document.querySelector<HTMLElement>('.pwa-attachment-tile[aria-label="a.txt"]')!;
    const firstLeft = Math.round(first.getBoundingClientRect().left);

    await screen.rerender(tree(two.slice(1)));
    // 离开的方块脱离布局、原位淡出，不可操作；后面的方块当场补位。
    expect(first.getAttribute("data-presence")).toBe("leaving");
    expect(first.hasAttribute("inert")).toBe(true);
    expect(getComputedStyle(first).position).toBe("absolute");
    expect(Math.round(first.getBoundingClientRect().left)).toBe(firstLeft);
    expect(Math.round(second.getBoundingClientRect().left)).toBeLessThan(secondLeft);
    await expect.poll(() => document.querySelector('.pwa-attachment-tile[data-presence="leaving"]')).toBeNull();

    // 移除最后一件：整行原位淡出，高度暂留到淡出结束后一次收回；附件行在卡片内部，没有可退回的背后。
    const row = document.querySelector<HTMLElement>(".pwa-attachment-tiles")!;
    const rowHeight = Math.round(row.getBoundingClientRect().height);
    await screen.rerender(tree([]));
    expect(row.getAttribute("data-presence")).toBe("leaving");
    expect(row.hasAttribute("inert")).toBe(true);
    expect(Math.round(row.getBoundingClientRect().height)).toBe(rowHeight);
    expect(getComputedStyle(second).transitionProperty).toContain("opacity");
    await expect.poll(() => document.querySelector(".pwa-attachment-tiles")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

test("attachments handed off with the message during the own-send transition leave at once and never take space again", async () => {
  const tree = (items: ComposerAttachmentItem[]) => <PwaUiProvider><div className="pwa-root"><div className="pwa-chat-footer" data-own-send=""><Card><ComposerAttachmentTiles items={items} onRemove={() => {}} /></Card></div></div></PwaUiProvider>;
  const screen = await renderPwa(<div className="pwa-chat-footer" data-own-send=""><Card><ComposerAttachmentTiles items={[file]} onRemove={() => {}} /></Card></div>);
  try {
    const card = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const withTiles = Math.round(card.getBoundingClientRect().height);
    await screen.rerender(tree([]));
    // 交接：附件改由气泡呈现，附件行立即不占位；要么已移除，要么在移除前隐藏。
    const row = document.querySelector<HTMLElement>(".pwa-attachment-tiles");
    if (row) expect(getComputedStyle(row).display).toBe("none");
    const settled = Math.round(card.getBoundingClientRect().height);
    expect(settled).toBeLessThan(withTiles);
    delete document.querySelector<HTMLElement>(".pwa-chat-footer")!.dataset.ownSend;
    expect(Math.round(card.getBoundingClientRect().height)).toBe(settled);
    await expect.poll(() => document.querySelector(".pwa-attachment-tiles")).toBeNull();
  } finally {
    await screen.unmount();
  }
});
