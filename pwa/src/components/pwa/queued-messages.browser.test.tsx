import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { finishCssTransitions } from "@/test/browser/motion";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
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
      attachments={[]}
      canAttach={false}
      sendingAttachments={false}
      isOnline
      isWorking={false}
      stopping={false}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => {}}
      onStop={() => {}}
      onAddFiles={() => {}}
      onRemoveAttachment={() => {}}
      onRetryAttachment={() => {}}
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
  const cancel = screen.getByRole("button", { name: "Edit queued message 1: First queued message with a preview" });

  await expect.element(screen.getByRole("heading", { name: "Queued messages" })).toBeVisible();
  // 计数芯片只供视觉，读屏从折叠按钮内的隐藏文字读到条数。
  await expect.element(screen.getByText("3 queued messages")).toBeInTheDocument();
  await expect.element(screen.getByText("Waiting for the current task")).toBeVisible();
  expect(document.querySelector(".pwa-queued-message-status svg")).toBeNull();
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
  // 正在处理或他人发送的条目没有可用操作，直接不显示按钮，避免看起来可点。
  const rows = [...document.querySelectorAll<HTMLElement>(".pwa-queued-message")];
  expect(rows.map((row) => row.querySelectorAll(".pwa-queued-message-actions button").length)).toEqual([2, 0, 0]);
  expect(rows.map((row) => row.querySelector(".pwa-queued-message-index")?.textContent)).toEqual(["1", "2", "3"]);
  await screen.unmount();

  const offline = await renderPwa(<QueuedMessages items={[queuedItem({ text: "Offline queued message" })]} isOnline={false} onInsert={onInsert} onCancel={onCancel} />);
  await expect.element(offline.getByRole("button", { name: "Insert into conversation — queued message 1: Offline queued message" })).toBeDisabled();
  await expect.element(offline.getByRole("button", { name: "Edit queued message 1: Offline queued message" })).toBeDisabled();
  expect(document.querySelector(".pwa-queued-message-index")).toBeNull();
});

test("queue panel shows pending attachments only as a paperclip count", async () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(queueScope);
  runtime.sendUserWithAttachments("Original queue text", [
    { attachment_id: "file", file_name: "queued-notes.txt", mime_type: "text/plain", byte_length: 1024, sha256: "a".repeat(64) },
    { attachment_id: "file-2", file_name: "queued-log.txt", mime_type: "text/plain", byte_length: 2048, sha256: "b".repeat(64) },
  ], { clientRequestId: "q", requestId: "send" });
  runtime.receive(runtimeSnapshot([{ ...runtimeQueueItem, text: "Original queue text" }]));
  const screen = await renderPwa(<QueuePanelHarness runtime={runtime} onSend={() => true} />);
  const count = document.querySelector<HTMLElement>(".pwa-queued-message-attachments")!;
  await expect.element(screen.getByText("2 attachments")).toBeInTheDocument();
  expect(count.title).toBe("2 attachments");
  expect(count.querySelector(".lucide-paperclip")).not.toBeNull();
  // 抽屉一行放不下附件卡片，文件名不在排队行里展开。
  expect(document.querySelector(".pwa-queued-messages .pwa-attachment-cards")).toBeNull();
  expect(screen.container.textContent).not.toContain("queued-notes.txt");
  await expect.element(screen.getByRole("button", { name: /^Edit queued message/ })).toBeEnabled();
  await screen.unmount();
});

test("uses a scheduled timeout for an insertion notice and never sends when it is dismissed", async () => {
  const runtime = panelRuntime();
  const onSend = vi.fn(() => true);
  const screen = await renderPwa(<QueuePanelHarness runtime={runtime} onSend={onSend} />);
  vi.useFakeTimers();
  try {
    const insert = screen.getByRole("button", { name: /Insert into conversation/ });
    expect(document.querySelector(".pwa-queued-message-status .lucide-clock")).not.toBeNull();
    insert.element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.element(screen.getByText("Inserting…", { exact: true })).toBeVisible();
    expect(document.querySelector(".pwa-queued-message-status .lucide-clock")).toBeNull();
    expect(document.querySelector(".pwa-queued-message-status[data-pending] .pwa-spin")).not.toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await expect.element(screen.getByText("Unconfirmed", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("May still be processed; dismissing won't withdraw it.", { exact: true })).toBeVisible();
    expect(document.querySelector(".pwa-queued-message-status .lucide-circle-alert")).not.toBeNull();
    // 未确认只保留关闭提示，不再显示插入与撤回。
    await expect.element(insert).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /Edit queued message/ })).not.toBeInTheDocument();
    const dismiss = screen.getByRole("button", { name: /Dismiss notice/ });
    await expect.element(dismiss).toBeEnabled();
    await dismiss.click();
    expect(onSend).toHaveBeenCalledTimes(1);
    // 抽屉清空后先滑回卡片背后（drawer-out）再移除，离开期间 inert、对读屏隐藏。
    expect(document.querySelector(".pwa-queued-messages")?.getAttribute("data-presence")).toBe("leaving");
    await expect.poll(() => document.querySelector(".pwa-queued-messages")).toBeNull();
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
    await expect.element(screen.getByText("Unconfirmed", { exact: true })).toBeVisible();
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
    await expect.element(screen.getByText("Unconfirmed", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Insert into conversation/ })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /Edit queued message/ })).not.toBeInTheDocument();
    const dismiss = screen.getByRole("button", { name: /Dismiss notice/ });
    await expect.element(dismiss).toBeEnabled();
    await dismiss.click();
    expect(onSend).not.toHaveBeenCalled();
    // 抽屉清空后先滑回卡片背后（drawer-out）再移除，离开期间 inert、对读屏隐藏。
    expect(document.querySelector(".pwa-queued-messages")?.getAttribute("data-presence")).toBe("leaving");
    await expect.poll(() => document.querySelector(".pwa-queued-messages")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

test.each([[1280, 900], [390, 844], [390, 500]])("keeps a scrolling queue above the Composer at %ix%i", async (width, height) => {
  await page.viewport(width, height);
  const items = Array.from({ length: 8 }, (_, index) => queuedItem({
    id: `queued-${index + 1}`,
    text: `Queued message ${index + 1}: ${"long preview text ".repeat(10)}`,
    status: index === 0 ? "Unconfirmed" : "Queued",
    ...(index === 0 ? { notice: "May still be processed; dismissing won't withdraw it.", attention: true, dismissible: true, canManage: false } : { waiting: true }),
  }));
  const screen = await renderPwa(<QueueComposerHarness items={items} />);
  try {
    // 所有条目都在固定最大高度的列表内滚动，不挤压输入区。
    const list = document.querySelector<HTMLElement>(".pwa-queued-message-list")!;
    const composer = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const textarea = screen.getByRole("textbox").element();
    const insert = screen.getByRole("button", { name: /Insert into conversation — queued message 2:/ }).element();
    const cancel = screen.getByRole("button", { name: /Edit queued message 2:/ }).element();
    const dismiss = screen.getByRole("button", { name: /Dismiss notice — queued message 1:/ }).element();
    const composerBefore = composer.getBoundingClientRect();
    const textareaBox = textarea.getBoundingClientRect();

    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    // 抽屉内容区上限 min(236px, 30dvh)：折叠态完整可见，展开后在抽屉内滚动。
    expect(list.getBoundingClientRect().height).toBeLessThanOrEqual(Math.min(236, height * 0.3) + 1);
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

test("hides an in-flight item from the waiting area while other-owner waiting items stay", async () => {
  const runtime = new TimelineRuntime();
  runtime.setScope(queueScope);
  runtime.sendUser("Local in flight", undefined, { clientRequestId: "q", requestId: "send" });
  runtime.receive(runtimeSnapshot([
    { id: "q", text: "Local in flight", sender_ref: "owner", editable: false, created_at: 1 },
    { id: "peer", text: "Peer waiting", sender_ref: "other", editable: true, created_at: 2 },
  ]));
  const screen = await renderPwa(<QueuePanelHarness runtime={runtime} onSend={() => true} />);
  try {
    const panel = document.querySelector<HTMLElement>(".pwa-queued-messages")!;
    // 在途项交给对话区；其他 Owner 的等待项只读但仍留在等待区。
    expect(panel.textContent).not.toContain("Local in flight");
    expect(panel.querySelectorAll(".pwa-queued-message")).toHaveLength(1);
    await expect.element(screen.getByText("Peer waiting", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

test("keeps a single queued message on one compact row with icon actions", async () => {
  const screen = await renderPwa(<QueuedMessages items={[queuedItem({ waiting: true, text: `Single queued message ${"that keeps going ".repeat(12)}` })]} isOnline onInsert={() => {}} onCancel={() => {}} />);
  try {
    // 只有一条时不显示标题与计数；正文单行省略，插入与取消都是 44px 图标按钮，取消不用危险色轮廓。
    await expect.element(screen.getByRole("heading", { name: "Queued messages" })).not.toBeInTheDocument();
    const row = document.querySelector<HTMLElement>(".pwa-queued-message")!;
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(46);
    const text = row.querySelector<HTMLElement>(".pwa-queued-message-text")!;
    expect(getComputedStyle(text).whiteSpace).toBe("nowrap");
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    const insert = screen.getByRole("button", { name: /^Insert into conversation/ }).element();
    const cancel = screen.getByRole("button", { name: /^Edit queued message/ }).element();
    for (const action of [insert, cancel]) {
      expect(action.textContent).toBe("");
      expect(action.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    expect(cancel.getAttribute("data-variant")).not.toBe("outline");
    // 插入是「立即发送」，撤回编辑把内容放回输入框；排队中只显示时钟，文字仅供读屏，时钟与正文垂直居中。
    expect(insert.querySelector(".lucide-arrow-up")).not.toBeNull();
    expect(cancel.querySelector(".lucide-pencil")).not.toBeNull();
    const clock = row.querySelector<SVGElement>(".pwa-queued-message-status .lucide-clock")!;
    const middle = (rect: DOMRect) => rect.top + rect.height / 2;
    expect(Math.round(clock.getBoundingClientRect().width)).toBe(16);
    expect(Math.abs(Math.round(middle(clock.getBoundingClientRect()) - middle(text.getBoundingClientRect())))).toBeLessThanOrEqual(1);
    expect(row.querySelector(".pwa-queued-message-status .pwa-sr-only")?.textContent).toBe("Waiting for the current task");
    expect(row.querySelector(".pwa-queued-message-index")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

test("queued rows share one panel with dividers and keep the message text at the same height with or without an icon", async () => {
  const screen = await renderPwa(<QueuedMessages items={[queuedItem({ waiting: true }), queuedItem({ id: "queued-2", status: "Sending…", pending: true })]} isOnline onInsert={() => {}} onCancel={() => {}} />);
  try {
    const panel = document.querySelector<HTMLElement>(".pwa-queued-messages")!;
    const list = panel.querySelector<HTMLElement>(".pwa-queued-message-list")!;
    const rows = [...list.querySelectorAll<HTMLElement>(".pwa-queued-message")];
    // 外框与行间分隔都是发丝线：抽屉外框取 edge，行间分隔取更淡的 separator；分隔画在伪元素上，左右各缩进 12，不碰外框。
    // 两条以上时标题在抽屉首行，首条与标题之间同样有分隔。
    const hairline = getComputedStyle(document.documentElement).getPropertyValue("--pwa-hairline").trim();
    expect(getComputedStyle(panel).borderTopWidth).toBe(hairline);
    expect(getComputedStyle(panel).borderTopLeftRadius).toBe("16px");
    expect(rows.map((row) => getComputedStyle(row).borderTopWidth)).toEqual(["0px", "0px"]);
    expect(rows.map((row) => getComputedStyle(row, "::before").borderTopWidth)).toEqual([hairline, hairline]);
    const divider = getComputedStyle(rows[1]!, "::before");
    expect([divider.left, divider.right]).toEqual(["12px", "12px"]);
    const probe = document.createElement("div");
    document.body.append(probe);
    const resolved = (token: string) => {
      probe.style.borderTop = `1px solid var(${token})`;
      return getComputedStyle(probe).borderTopColor;
    };
    const [separator, edge] = [resolved("--pwa-separator"), resolved("--pwa-edge")];
    probe.remove();
    expect(divider.borderTopColor).toBe(separator);
    expect(getComputedStyle(panel).borderTopColor).toBe(edge);
    expect(separator).not.toBe(edge);
    expect(rows.map((row) => getComputedStyle(row).borderRadius)).toEqual(["0px", "0px"]);
    const offsets = rows.map((row) => Math.round(row.querySelector<HTMLElement>(".pwa-queued-message-text")!.getBoundingClientRect().top - row.getBoundingClientRect().top));
    expect(Math.abs(offsets[0]! - offsets[1]!)).toBeLessThanOrEqual(1);
  } finally {
    await screen.unmount();
  }
});

test("lists every queued message without a show-more row and folds the whole list from the header", async () => {
  const items = Array.from({ length: 5 }, (_, index) => queuedItem({ id: `queued-${index + 1}`, text: `Folded message ${index + 1}` }));
  items[3] = { ...items[3]!, attention: true, status: "Unconfirmed", notice: "May still be processed; dismissing won't withdraw it.", dismissible: true, canManage: false };
  const screen = await renderPwa(<QueuedMessages items={items} isOnline onInsert={() => {}} onCancel={() => {}} />);
  // 折叠区常驻以过渡高度；折叠时 inert，读屏与键盘都到不了其中的条目。
  const reachable = () => [...document.querySelectorAll(".pwa-queued-message")].filter((row) => !row.closest("[inert]"));
  try {
    expect(reachable()).toHaveLength(5);
    await expect.element(screen.getByRole("button", { name: /more$/ })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /^Queued messages/ });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    const body = document.getElementById(toggle.element().getAttribute("aria-controls")!)!;
    expect(body.classList.contains("pwa-queued-messages-body")).toBe(true);
    expect(getComputedStyle(body).transitionProperty).toContain("grid-template-rows");
    expect(Math.round(toggle.element().getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    const open = Math.round(body.getBoundingClientRect().height);
    expect(open).toBeGreaterThan(0);
    expect(document.querySelector(".pwa-queued-messages-attention")).toBeNull();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    expect(reachable()).toHaveLength(0);
    await expect.poll(() => Math.round(body.getBoundingClientRect().height)).toBe(0);
    // 折叠后仍有需要关注的条目时，标题行给出告警，避免未确认被藏起来。
    expect(document.querySelector(".pwa-queued-messages-attention")).not.toBeNull();

    await toggle.click();
    expect(reachable()).toHaveLength(5);
    await expect.poll(() => Math.round(body.getBoundingClientRect().height)).toBe(open);
  } finally {
    await screen.unmount();
  }
});

test("tucks the queue drawer behind the Composer card, inset on both sides", async () => {
  await page.viewport(390, 844);
  const screen = await renderPwa(<QueueComposerHarness items={[queuedItem({ waiting: true })]} />);
  try {
    const element = document.querySelector<HTMLElement>(".pwa-queued-messages")!;
    // 出现时包裹层从 0 伸展，抽屉从卡片背后升起；等过渡结束再量静止几何。
    expect(getComputedStyle(element.parentElement!).transitionProperty).toContain("grid-template-rows");
    await finishCssTransitions();
    const drawer = element.getBoundingClientRect();
    const card = document.querySelector<HTMLElement>(".pwa-composer-card")!.getBoundingClientRect();
    // 下沿以一个 Composer 圆角高度压在卡片之后，左右各比卡片内缩 8；重叠处由卡片承接指针。
    expect(Math.round(drawer.bottom - card.top)).toBe(32);
    expect(Math.round(drawer.left - card.left)).toBe(8);
    expect(Math.round(card.right - drawer.right)).toBe(8);
    const hit = document.elementFromPoint(card.left + card.width / 2, card.top + 8);
    expect(hit?.closest(".pwa-composer-card")).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});
test("waits for the run to end before an insertion becomes unconfirmed", async () => {
  const runtime = panelRuntime();
  let setWorking!: (working: boolean) => void;
  function WorkingHarness() {
    const [working, updateWorking] = useState(true);
    useLayoutEffect(() => { setWorking = updateWorking; }, []);
    const [items, setItems] = useState<TimelineViewItem[]>(() => runtime.pendingItems);
    const runtimeRef = useRef(runtime);
    const channelRef = useRef<PeerChannel | null>({ send: () => true } as unknown as PeerChannel);
    return <QueuedMessagesPanel items={items} isOnline isWorking={working} runtimeRef={runtimeRef} channelRef={channelRef} applyChange={(change) => setItems(change.items)} onError={() => {}} />;
  }
  const screen = await renderPwa(<WorkingHarness />);
  vi.useFakeTimers();
  try {
    screen.getByRole("button", { name: /Insert into conversation/ }).element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.element(screen.getByText("Inserting…", { exact: true })).toBeVisible();
    // 运行中 steer 要等本轮边界才开始，长回复超过固定窗口也不能判定未确认。
    vi.advanceTimersByTime(QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS * 3);
    await Promise.resolve();
    await expect.element(screen.getByText("Inserting…", { exact: true })).toBeVisible();
    flushSync(() => setWorking(false));
    vi.advanceTimersByTime(QUEUED_INSERTION_CONFIRMATION_TIMEOUT_MS - 1);
    await Promise.resolve();
    await expect.element(screen.getByText("Inserting…", { exact: true })).toBeVisible();
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    await expect.element(screen.getByText("Unconfirmed", { exact: true })).toBeVisible();
  } finally {
    vi.useRealTimers();
    await screen.unmount();
  }
});

test("an emptied drawer sinks back behind the card while its space collapses, also during own send", async () => {
  await page.viewport(390, 844);
  const tree = (items: QueuedMessageView[]) => <div className="pwa-chat-footer" data-own-send=""><QueueComposerHarness items={items} /></div>;
  const screen = await renderPwa(tree([queuedItem({ waiting: true })]));
  try {
    const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
    // 桩把输入区固定在底部，量输入区表单本身的高度。
    const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
    const card = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const drawer = document.querySelector<HTMLElement>(".pwa-queued-messages")!;
    await finishCssTransitions();
    const withDrawer = Math.round(composer.getBoundingClientRect().height);
    const cardTop = Math.round(card.getBoundingClientRect().top);
    await screen.rerender(<PwaUiProvider><div className="pwa-root">{tree([])}</div></PwaUiProvider>);
    // 离开期间不脱离布局：包裹层逐帧收回高度，抽屉随之沉回卡片背后并淡出；本端发送过渡期间同样播放。
    expect(drawer.getAttribute("data-presence")).toBe("leaving");
    expect(getComputedStyle(drawer).position).not.toBe("absolute");
    const heights: number[] = [];
    const tops: number[] = [];
    while (drawer.isConnected) {
      heights.push(Math.round(composer.getBoundingClientRect().height));
      tops.push(Math.round(drawer.getBoundingClientRect().top));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    const settled = Math.round(composer.getBoundingClientRect().height);
    expect(settled).toBeLessThan(withDrawer);
    // 高度逐帧收回、不反弹，并经过中间值；抽屉上沿只向卡片方向移动。
    expect(heights.every((height, index) => index === 0 || height <= heights[index - 1])).toBe(true);
    expect(heights.some(height => height < withDrawer - 2 && height > settled + 2)).toBe(true);
    expect(tops.every((top, index) => index === 0 || top >= tops[index - 1])).toBe(true);
    // 输入区贴底，收回的是抽屉露出的部分，卡片本身不动。
    expect(Math.round(card.getBoundingClientRect().top)).toBe(cardTop);
    // 移除后标记撤销，也不会重新撑开输入区。
    delete footer.dataset.ownSend;
    expect(Math.round(composer.getBoundingClientRect().height)).toBe(settled);
  } finally {
    await screen.unmount();
  }
});

test("a row entering the drawer fades in; a leaving row fades out in place while the rest take its space at once", async () => {
  await page.viewport(390, 844);
  const three = [1, 2, 3].map((n) => queuedItem({ id: `row-${n}`, text: `Row ${n}`, waiting: true }));
  const tree = (items: QueuedMessageView[]) => <PwaUiProvider><div className="pwa-root"><QueuedMessages items={items} isOnline onInsert={() => {}} onCancel={() => {}} /></div></PwaUiProvider>;
  const screen = await renderPwa(<QueuedMessages items={three.slice(0, 2)} isOnline onInsert={() => {}} onCancel={() => {}} />);
  try {
    // 与抽屉同时出现的行随抽屉滑出，自身不再叠加一层淡入。
    expect([...document.querySelectorAll<HTMLElement>(".pwa-queued-message")].map((row) => getComputedStyle(row).opacity)).toEqual(["1", "1"]);
    await expect.poll(() => document.querySelector(".pwa-queued-messages")?.hasAttribute("data-entered")).toBe(true);
    await screen.rerender(tree(three));
    const added = [...document.querySelectorAll<HTMLElement>(".pwa-queued-message")].find((row) => row.textContent?.includes("Row 3"))!;
    expect(getComputedStyle(added).transitionProperty).toContain("opacity");
    // 抽屉在场后新加入的行单独淡入：起点透明，随后到 1。
    expect(Number(getComputedStyle(added).opacity)).toBeLessThan(1);
    await expect.poll(() => getComputedStyle(added).opacity).toBe("1");
    const list = document.querySelector<HTMLElement>(".pwa-queued-message-list")!;
    const full = Math.round(list.getBoundingClientRect().height);
    const third = Math.round(added.getBoundingClientRect().top);

    await screen.rerender(tree([three[0]!, three[2]!]));
    const leaving = document.querySelector<HTMLElement>('.pwa-queued-message[data-presence="leaving"]')!;
    expect(leaving.textContent).toContain("Row 2");
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(getComputedStyle(leaving).position).toBe("absolute");
    // 后面的行当场补位，列表高度一次收回。
    expect(Math.round(list.getBoundingClientRect().height)).toBeLessThan(full);
    expect(Math.round(added.getBoundingClientRect().top)).toBeLessThan(third);
    await expect.poll(() => document.querySelector('.pwa-queued-message[data-presence="leaving"]')).toBeNull();
    expect(document.querySelectorAll(".pwa-queued-message")).toHaveLength(2);
  } finally {
    await screen.unmount();
  }
});
