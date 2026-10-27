import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";
import { renderPwa } from "@/test/browser/render";
import { fileKey, type FileSourceDescriptor } from "@/lib/pwa/file-source";
import { PublishedFilesProvider, type PublishedFilesView, type PublishedFileViewState } from "./published-files-context";
import { SentAttachmentCards } from "./sent-attachment-cards";
import { UserMessage } from "./user-message";

const image: AttachmentDescriptor = { attachment_id: "image-1", file_name: "photo.png", mime_type: "image/png", byte_length: 2048, sha256: "a".repeat(64) };
const archive: AttachmentDescriptor = { attachment_id: "zip-1", file_name: "bundle.zip", mime_type: "application/zip", byte_length: 4096, sha256: "b".repeat(64) };
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
afterEach(async () => { await page.viewport(1280, 900); });

function Harness({ attachments, canFetch = true, initial = new Map<string, PublishedFileViewState>(), onRead, open }: {
  attachments: AttachmentDescriptor[]; canFetch?: boolean; initial?: Map<string, PublishedFileViewState>;
  onRead: (file: FileSourceDescriptor, trigger: HTMLButtonElement) => void; open: (file: FileSourceDescriptor, intent: string) => PublishedFileViewState;
}) {
  const [states, setStates] = useState(initial);
  const [scopeToken] = useState(() => ({}));
  const view: PublishedFilesView = {
    scopeToken, canFetch, active: false, getState: (id) => states.get(id),
    open: async (file, intent) => {
      const next = new Map(states);
      next.set(fileKey(file), open(file, intent));
      setStates(next);
      // 真实门面的 getState 读取 controller 的即时快照；点击时捕获的旧门面也要看到结果。
      states.set(fileKey(file), next.get(fileKey(file))!);
    },
    cancel: () => {}, pin: () => {}, unpin: () => {},
  };
  return <PublishedFilesProvider value={view}><div style={{ width: "min(680px, calc(100vw - 32px))", margin: "16px" }}><SentAttachmentCards attachments={attachments} onRead={onRead} /></div></PublishedFilesProvider>;
}

test("opens a previewable attachment in the reader after fetching its original", async () => {
  const onRead = vi.fn();
  const open = vi.fn(() => ({ phase: "ready" as const, receivedBytes: 2048, preview: { kind: "image" as const, width: 1, height: 1 }, url: PIXEL }));
  const screen = await renderPwa(<Harness attachments={[image]} onRead={onRead} open={open} />);
  await screen.getByRole("button", { name: "View photo.png" }).click();
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ attachment_id: "image-1", sha256: "a".repeat(64) }), "view");
  await vi.waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
  expect(onRead.mock.calls[0][0]).toMatchObject({ attachment_id: "image-1" });
  expect(onRead.mock.calls[0][1]).toBe(document.querySelector(".pwa-attachment-open"));
  await vi.waitFor(() => expect(screen.getByRole("link", { name: "Save photo.png" }).element().getAttribute("href")).toBe(PIXEL));
  await screen.unmount();
});

test.each([320, 1440])("keeps 58px cards with 44px targets and only downloads non-previewable files at %i", async (width) => {
  await page.viewport(width, 900);
  const open = vi.fn(() => ({ phase: "ready" as const, receivedBytes: 4096, preview: { kind: "none" as const }, url: "blob:zip" }));
  const screen = await renderPwa(<Harness attachments={[image, archive]} onRead={vi.fn()} open={open} />);
  const cards = [...document.querySelectorAll<HTMLElement>(".pwa-attachment-card")];
  for (const card of cards) {
    expect(Math.round(card.getBoundingClientRect().height)).toBe(58);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    for (const target of card.querySelectorAll<HTMLElement>("button, a")) {
      expect(Math.round(target.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
  }
  expect(cards[1].querySelector(".pwa-attachment-open")).toBeNull();
  await screen.getByRole("button", { name: "Download bundle.zip" }).click();
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ attachment_id: "zip-1" }), "download");
  await vi.waitFor(() => expect(screen.getByRole("link", { name: "Save bundle.zip" }).element().getAttribute("download")).toBe("bundle.zip"));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await screen.unmount();
});

test("shows the upgrade and changed-original failures in the status slot", async () => {
  const initial = new Map<string, PublishedFileViewState>([
    [fileKey({ ...image }), { phase: "error", receivedBytes: 0, error: "unsupported" }],
    [fileKey({ ...archive }), { phase: "error", receivedBytes: 0, error: "integrity_mismatch" }],
  ]);
  const screen = await renderPwa(<Harness attachments={[image, archive]} initial={initial} onRead={vi.fn()} open={vi.fn()} />);
  const alerts = [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent);
  expect(alerts).toEqual(["Upgrade the computer's extension to view originals.", "The original was changed on the computer and can't be fetched."]);
  expect(document.querySelectorAll('.pwa-attachment-card[data-status="failed"]')).toHaveLength(2);
  await screen.unmount();
});

test("keeps read-only cards for history and pending messages", async () => {
  const event = { kind: "user", event_id: "message-1", message_id: "message-1", event_seq: 1, session_id: "session", leaf_id: "leaf", group_id: "group",
    timestamp: 1, origin: "pwa", sender_ref: "sender", blocks: [] } as unknown as Parameters<typeof UserMessage>[0]["value"];
  const metadata = { version: 1 as const, client_request_id: "request", sender_ref: "sender", text: "", attachments: [image] };
  const screen = await renderPwa(<UserMessage value={event} metadata={metadata} entering={false} timelineKey="row" />);
  expect(document.querySelector(".pwa-attachment-card")).not.toBeNull();
  expect(document.querySelector(".pwa-attachment-card button, .pwa-attachment-card a")).toBeNull();
  await screen.unmount();
});
