import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import { QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS, TimelineRuntime, type TimelineRuntimeChange, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageComposer } from "./message-composer";
import { QueuedMessagesPanel } from "./queued-messages-panel";
import { QueuedMessages, type QueuedMessageView } from "./queued-messages";
import "@/app/queued-messages.css";

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const queueScope: TimelineScope = { deviceId: "d", endpointId: "e", runtimeInstanceId: "r", sessionId: "s", leafId: "g", selfSenderRef: "owner", channelId: "c" };
type QueueFrame = Extract<ServerFrame, { type: "queued_message_state" }>;
const runtimeQueueItem: QueueFrame["items"][number] = { id: "q", text: "Timer queue item", sender_ref: "owner", editable: true, created_at: 1 };
function runtimeSnapshot(items: QueueFrame["items"]): QueueFrame {
  return { protocol_version: 2, type: "queued_message_state", session_id: "s", leaf_id: "g", snapshot_id: "snapshot", chunk_index: 0, final: true, items };
}
function panelRuntime() {
  const runtime = new TimelineRuntime();
  runtime.setScope(queueScope);
  runtime.sendUser(runtimeQueueItem.text, undefined, { clientRequestId: runtimeQueueItem.id, requestId: "send" });
  runtime.receive(runtimeSnapshot([runtimeQueueItem]));
  return runtime;
}
function QueuePanelHarness({ runtime, onSend, isOnline = true }: { runtime: TimelineRuntime; onSend: () => boolean; isOnline?: boolean }) {
  const [items, setItems] = useState<TimelineViewItem[]>(() => runtime.pendingItems);
  const runtimeRef = useRef(runtime);
  const channelRef = useRef<PeerChannel | null>({ send: onSend } as unknown as PeerChannel);
  const applyChange = (change: TimelineRuntimeChange) => setItems(change.items);
  return <QueuedMessagesPanel items={items} isOnline={isOnline} runtimeRef={runtimeRef} channelRef={channelRef} applyChange={applyChange} onError={() => {}} />;
}

function queuedItem(overrides: Partial<QueuedMessageView> = {}): QueuedMessageView {
  return {
    id: "queued-1",
    text: "First queued message with a preview",
    status: "Waiting for the current task",
    canManage: true,
    ...overrides,
  };
}

function QueueComposerHarness({ items }: { items: QueuedMessageView[] }) {
  const [draft, setDraft] = useState("Keep the composer ready");
  return <div style={{ position: "fixed", right: 0, bottom: 0, left: 0 }}>
    <MessageComposer
      attachment={null}
      canAttachImage={false}
      sendingImage={false}
      isOnline
      isWorking={false}
      stopping={false}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => {}}
      onStop={() => {}}
      onSetAttachment={() => {}}
      onClearAttachment={() => {}}
      commandModels={[]}
      commandCurrentModel={null}
      commandCurrentModelFallback={null}
      commandThinking="off"
      commandPendingAction={null}
      onNewSession={() => {}}
      onCompactSession={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onCommandsOpen={() => {}}
      queuedMessages={<QueuedMessages items={items} isOnline onInsert={() => {}} onCancel={() => {}} onDismissNotice={() => {}} />}
    />
  </div>;
}

afterEach(async () => { await page.viewport(1280, 900); });

test("returns no queue markup for an empty queue", async () => {
  await renderPwa(<QueuedMessages items={[]} isOnline onInsert={() => {}} onCancel={() => {}} />);
  expect(document.querySelector(".pwa-queued-messages")).toBeNull();
});

test("renders parent-supplied status, previews, actions, and disabled states", async () => {
  const onInsert = vi.fn();
  const onCancel = vi.fn();
  const items = [
    queuedItem({ images: [{ data: imageData, mime: "image/png" }] }),
    queuedItem({ id: "queued-busy", text: "Busy queued message", status: "Applying change", busy: true }),
    queuedItem({ id: "queued-read-only", text: "Read-only queued message", status: "Held by another user", canManage: false }),
  ];
  const screen = await renderPwa(<QueuedMessages items={items} isOnline onInsert={onInsert} onCancel={onCancel} />);
  const insert = screen.getByRole("button", { name: "Insert into conversation — queued message 1: First queued message with a preview" });
  const cancel = screen.getByRole("button", { name: "Cancel queued message 1: First queued message with a preview" });

  await expect.element(screen.getByRole("heading", { name: "Queued messages" })).toBeVisible();
  await expect.element(screen.getByLabelText("3 queued messages")).toBeVisible();
  await expect.element(screen.getByText("Waiting for the current task")).toBeVisible();
  await expect.element(screen.getByText("First queued message with a preview")).toBeVisible();
  const image = screen.getByRole("img", { name: "Queued message 1 image 1" });
  expect(image.element().getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);

  await insert.click();
  await cancel.click();
  insert.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onInsert).toHaveBeenCalledWith("queued-1");
  expect(onInsert).toHaveBeenCalledTimes(2);
  expect(onCancel).toHaveBeenCalledWith("queued-1");
  await expect.element(screen.getByRole("button", { name: "Insert into conversation — queued message 2: Busy queued message" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel queued message 2: Busy queued message" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Insert into conversation — queued message 3: Read-only queued message" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel queued message 3: Read-only queued message" })).toBeDisabled();
  await screen.unmount();

  const offline = await renderPwa(<QueuedMessages items={[queuedItem({ text: "Offline queued message" })]} isOnline={false} onInsert={onInsert} onCancel={onCancel} />);
  await expect.element(offline.getByRole("button", { name: "Insert into conversation — queued message 1: Offline queued message" })).toBeDisabled();
  await expect.element(offline.getByRole("button", { name: "Cancel queued message 1: Offline queued message" })).toBeDisabled();
});

test("uses a scheduled timeout for an insertion notice and never sends when it is dismissed", async () => {
  const runtime = panelRuntime();
  const onSend = vi.fn(() => true);
  const screen = await renderPwa(<QueuePanelHarness runtime={runtime} onSend={onSend} />);
  vi.useFakeTimers();
  try {
    const insert = screen.getByRole("button", { name: /Insert into conversation/ });
    insert.element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.element(screen.getByText("Requesting insertion…", { exact: true })).toBeVisible();
    expect(onSend).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await expect.element(screen.getByText("Insertion status unconfirmed", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("May still be processed. Dismissing this notice does not cancel it.", { exact: true })).toBeVisible();
    await expect.element(insert).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: /Cancel queued message/ })).toBeDisabled();
    const dismiss = screen.getByRole("button", { name: /Dismiss notice/ });
    await expect.element(dismiss).toBeEnabled();
    await dismiss.click();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".pwa-queued-messages")).toBeNull();
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("expires an already overdue insertion when the panel mounts", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
  const runtime = panelRuntime();
  runtime.actOnQueued("q", "insert");
  vi.setSystemTime(new Date(QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS));
  const screen = await renderPwa(<QueuePanelHarness runtime={runtime} onSend={() => true} />);
  try {
    await expect.element(screen.getByText("Insertion status unconfirmed", { exact: true })).toBeVisible();
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("dismisses an unconfirmed insertion offline without sending", async () => {
  const runtime = panelRuntime();
  runtime.actOnQueued("q", "insert");
  runtime.markUnknownDelivery("q");
  const onSend = vi.fn(() => true);
  const screen = await renderPwa(<QueuePanelHarness runtime={runtime} onSend={onSend} isOnline={false} />);
  try {
    await expect.element(screen.getByText("Insertion status unconfirmed", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Insert into conversation/ })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: /Cancel queued message/ })).toBeDisabled();
    const dismiss = screen.getByRole("button", { name: /Dismiss notice/ });
    await expect.element(dismiss).toBeEnabled();
    await dismiss.click();
    expect(onSend).not.toHaveBeenCalled();
    expect(document.querySelector(".pwa-queued-messages")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

test.each([[1280, 900], [390, 844], [390, 500]])("keeps a scrolling queue above the Composer at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const items = Array.from({ length: 8 }, (_, index) => queuedItem({
    id: `queued-${index + 1}`,
    text: `Queued message ${index + 1}: ${"long preview text ".repeat(10)}`,
    status: index === 0 ? "Insertion status unconfirmed" : "Waiting for the current task",
    ...(index === 0 ? { notice: "May still be processed. Dismissing this notice does not cancel it.", dismissible: true, canManage: false } : {}),
  }));
  const screen = await renderPwa(<QueueComposerHarness items={items} />);
  try {
    const list = document.querySelector<HTMLElement>(".pwa-queued-message-list")!;
    const composer = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const textarea = screen.getByRole("textbox").element();
    const insert = screen.getByRole("button", { name: /Insert into conversation — queued message 1:/ }).element();
    const cancel = screen.getByRole("button", { name: /Cancel queued message 1:/ }).element();
    const dismiss = screen.getByRole("button", { name: /Dismiss notice — queued message 1:/ }).element();
    const composerBefore = composer.getBoundingClientRect();
    const textareaBox = textarea.getBoundingClientRect();

    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(list.getBoundingClientRect().height).toBeLessThanOrEqual(Math.min(220, height * 0.25) + 1);
    expect(textareaBox.height).toBeGreaterThanOrEqual(44);
    expect(textareaBox.top).toBeGreaterThanOrEqual(0);
    expect(textareaBox.bottom).toBeLessThanOrEqual(height);
    expect(insert.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(insert.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(cancel.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(cancel.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(dismiss.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(dismiss.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);

    list.scrollTop = list.scrollHeight;
    await expect.poll(() => list.scrollTop).toBeGreaterThan(0);
    const composerAfter = composer.getBoundingClientRect();
    expect(composerAfter.top).toBe(composerBefore.top);
    expect(composerAfter.bottom).toBe(composerBefore.bottom);

    if (width === 390 && height === 844) await page.screenshot({ path: "../../../.vitest/screenshots/queued-messages-390x844.png" });
  } finally {
    await screen.unmount();
  }
});

test("keeps a single queued message on one compact row with icon actions", async () => {
  const screen = await renderPwa(<QueuedMessages items={[queuedItem({ text: `Single queued message ${"that keeps going ".repeat(12)}` })]} isOnline onInsert={() => {}} onCancel={() => {}} />);
  try {
    // 只有一条时不显示标题与计数；正文单行省略，插入与取消都是 44px 图标按钮，取消不用危险色轮廓。
    await expect.element(screen.getByRole("heading", { name: "Queued messages" })).not.toBeInTheDocument();
    const row = document.querySelector<HTMLElement>(".pwa-queued-message")!;
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(46);
    const text = row.querySelector<HTMLElement>(".pwa-queued-message-text")!;
    expect(getComputedStyle(text).whiteSpace).toBe("nowrap");
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    const insert = screen.getByRole("button", { name: /^Insert into conversation/ }).element();
    const cancel = screen.getByRole("button", { name: /^Cancel queued message/ }).element();
    for (const action of [insert, cancel]) {
      expect(action.textContent).toBe("");
      expect(action.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    expect(cancel.getAttribute("data-variant")).not.toBe("outline");
  } finally {
    await screen.unmount();
  }
});
