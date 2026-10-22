import { useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { TimelineRuntime, type TimelinePending, type TimelineRuntimeChange, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import { MessageList } from "./message-list";
import { isQueuedMessage, QueuedMessagesPanel } from "./queued-messages-panel";
import { MessageComposer } from "./message-composer";

const noop = () => {};
const composer: ComponentProps<typeof MessageComposer> = {
  enterSends: true, attachments: [], canAttach: true, sendingAttachments: false,
  isOnline: true, isWorking: false, stopping: false, draft: "", onDraftChange: noop,
  onSend: noop, onStop: noop, onAddFiles: noop, onRemoveAttachment: noop, onRetryAttachment: noop,
  commandModels: [], commandCurrentModel: null, commandCurrentModelFallback: null,
  commandThinking: "off", commandPendingAction: null, onNewSession: noop, onCompactSession: noop,
  onSetModel: noop, onSetThinking: noop, onCommandsOpen: noop,
};
const history = { kind: "event", event: {
  event_id: "history", session_id: "send-session", leaf_id: "leaf", group_id: "old", timestamp: 0,
  kind: "assistant", status: "complete", blocks: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `Earlier paragraph ${i}.`).join("\n\n") }],
} } satisfies TimelineViewItem;
const pending = (id = "local"): TimelinePending => ({ kind: "pending", id, clientRequestId: id, requestId: id, text: "New message", createdAt: 1, delivery: "pending" });
function formal(value: TimelinePending): TimelineViewItem {
  value.messageId = `message-${value.id}`;
  return { kind: "event", event: { event_id: value.messageId, session_id: "send-session", leaf_id: "leaf", group_id: "new", timestamp: 1, kind: "user", origin: "pwa", sender_ref: "local-sender", status: "committed", delivery: "normal", message_id: value.messageId, blocks: [{ type: "text", text: value.text }] } };
}
const gap = (list: HTMLElement) => Math.round(list.scrollHeight - list.clientHeight - list.scrollTop);
const top = (node: Element) => Math.round(node.getBoundingClientRect().top);
async function frames(count = 3) { for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
async function harness({ width = 390, compact = false, working = false, draft = "New message", live = true, initial = [history] }: { width?: number; compact?: boolean; working?: boolean; draft?: string; live?: boolean; initial?: TimelineViewItem[] } = {}) {
  await page.viewport(width, 844);
  let viewport!: TimelineViewport;
  let update!: (items: TimelineViewItem[]) => void;
  let setLive!: (live: boolean) => void;
  let send!: () => void;
  let sent!: TimelinePending;
  function Harness() {
    const [items, setItems] = useState(initial);
    const [text, setText] = useState(draft);
    const [online, setOnline] = useState(live);
    setLive = setOnline;
    viewport = useTimelineViewport(items);
    update = setItems;
    send = () => {
      sent = { ...pending(), text };
      viewport.followOwnSend();
      setItems([...items, sent]);
      setText("");
    };
    return <div className="pwa-app-shell"><main className="pwa-main" data-composer-budget={compact ? "constrained" : undefined} style={{ display: "flex", flexDirection: "column", width: "100vw", height: compact ? 280 : 650, flex: "none" }}>
      <MessageList items={items} isLive={online} running={working} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onRetryUnknown={noop} onCancelQueued={noop} />
      <div className="pwa-chat-footer"><MessageComposer {...composer} draft={text} onDraftChange={setText} onSend={send} /></div>
    </main></div>;
  }
  const screen = await renderPwa(<Harness />);
  await frames();
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  return { screen, list, viewport: () => viewport, sent: () => sent,
    live: (value: boolean) => flushSync(() => setLive(value)),
    send: () => flushSync(() => send()), update: (items: TimelineViewItem[]) => flushSync(() => update(items)),
    read: async () => { list.scrollTop -= 300; flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true }))); await frames(); },
  };
}
afterEach(async () => {
  document.documentElement.removeAttribute("data-pwa-text-size");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

test.each([390, 1280])("tail pending confirmation preserves extent and old body at %ipx", async width => {
  const value = pending();
  const h = await harness({ width });
  try {
    h.update([history, value]);
    await frames();
    const before = { height: h.list.scrollHeight, top: top(h.list.querySelector(".pwa-message.assistant")!) };
    h.update([history, formal(value)]);
    await frames();
    expect(h.list.scrollHeight).toBe(before.height);
    expect(top(h.list.querySelector(".pwa-message.assistant")!)).toBe(before.top);
  } finally { await h.screen.unmount(); }
});

test.each([390, 1280])("own send follows before a frame, clears multiline Composer and remains interruptible at %ipx", async width => {
  const h = await harness({ width, draft: "Line one\nLine two\nLine three\nLine four\nLine five" });
  try {
    await h.read();
    expect(h.viewport().followingOutput).toBe(false);
    h.send();
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(h.viewport().followingOutput).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!.value).toBe("");
    h.update([history, h.sent(), { ...history, event: { ...history.event, event_id: "reply", blocks: [{ type: "text", text: "First reply" }] } }]);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    await frames();
    await h.read();
    expect(h.viewport().followingOutput).toBe(false);
    const before = h.list.scrollTop;
    h.update([history, h.sent(), { ...history, event: { ...history.event, event_id: "reply", blocks: [{ type: "text", text: "First reply\n\nMore output" }] } }]);
    await frames();
    expect(Math.round(h.list.scrollTop)).toBe(Math.round(before));
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("compact xlarge tail sending status remains visible with Working=%s", async working => {
  document.documentElement.dataset.pwaTextSize = "xlarge";
  const value = pending();
  const h = await harness({ compact: true, working });
  try {
    h.update([history, value]);
    const bubble = h.list.querySelector(".pwa-message.user")!;
    const animation = bubble.getAnimations()[0];
    expect(animation).toBeDefined();
    animation.pause();
    animation.currentTime = 0;
    const frame = h.list.querySelector<HTMLElement>(".pwa-user-bubble-frame")!;
    expect(getComputedStyle(frame).overflowY).toBe("clip");
    const status = h.list.querySelector<HTMLElement>(".pwa-delivery-status")!;
    expect(getComputedStyle(status).position).toBe("absolute");
    for (const time of [0, 80, 160]) {
      animation.currentTime = time;
      expect(top(status)).toBeGreaterThanOrEqual(Math.round(frame.getBoundingClientRect().bottom));
    }
    animation.finish();
    expect(Math.round(status.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(h.list.getBoundingClientRect().bottom));
    const workingRow = h.list.querySelector(".pwa-thinking-status");
    if (workingRow) {
      const range = document.createRange(); range.selectNodeContents(workingRow);
      expect(Math.round(range.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(status.getBoundingClientRect().left));
    }
    const height = h.list.scrollHeight;
    h.update([history, formal(value)]);
    await frames();
    expect(h.list.scrollHeight).toBe(height);
  } finally { await h.screen.unmount(); }
});

test("the first send from an empty session animates without replaying initial pending history", async () => {
  const h = await harness({ initial: [] });
  try {
    h.send();
    const bubble = h.list.querySelector(".pwa-message.user")!;
    expect(bubble.getAnimations()).toHaveLength(1);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    const animation = bubble.getAnimations()[0];
    h.update([formal(h.sent())]);
    expect(h.list.querySelector(".pwa-message.user")).toBe(bubble);
    expect(bubble.getAnimations()[0]).toBe(animation);
  } finally { await h.screen.unmount(); }
  const restored = await harness({ initial: [pending("restored")] });
  try {
    expect(restored.list.querySelector(".pwa-message.user")!.getAnimations()).toHaveLength(0);
  } finally { await restored.screen.unmount(); }
});

const queueScope: TimelineScope = { deviceId: "d", endpointId: "e", runtimeInstanceId: "r", sessionId: "send-session", leafId: "leaf", selfSenderRef: "local-sender", channelId: "c" };
const emptyChannel: { current: PeerChannel | null } = { current: null };
type QueueFrame = Extract<ServerFrame, { type: "queued_message_state" }>;
function queueSnapshot(id: string, text: string, editable: boolean): QueueFrame {
  return { protocol_version: 2, type: "queued_message_state", session_id: "send-session", leaf_id: "leaf", snapshot_id: `queue-${id}-${String(editable)}`, chunk_index: 0, final: true, items: [{ id, text, sender_ref: "local-sender", editable, created_at: 1 }] };
}
function startedFrame(id: string, text: string): Extract<ServerFrame, { type: "user_message_started" }> {
  return { protocol_version: 2, type: "user_message_started", target_channel_id: "c", in_reply_to: "send", session_id: "send-session", leaf_id: "leaf", message: { id, group_id: `group-${id}`, blocks: [{ type: "text", text }], origin: "pwa", sender_ref: "local-sender", delivery: "normal" } };
}
function formalEvent(id: string, text: string): Parameters<TimelineRuntime["commit"]>[0] {
  return { event_id: id, message_id: id, event_seq: 2, session_id: "send-session", leaf_id: "leaf", group_id: `group-${id}`, timestamp: 2, kind: "user", blocks: [{ type: "text", text }], origin: "pwa", sender_ref: "local-sender", delivery: "normal", status: "committed" };
}

/** 真实 Runtime + 真实组件：验证本地发送到正式消息之间气泡和布局不重建。 */
async function runtimeHarness({ width = 390 } = {}) {
  await page.viewport(width, 844);
  const runtime = new TimelineRuntime();
  runtime.setScope(queueScope);
  // 历史也必须经由 Runtime 的正式事件进入，才能在发送过程中真实保留在列表里。
  const seeded = runtime.commit({ ...history.event, event_seq: 1 });
  expect(seeded.items).toHaveLength(1);
  let apply!: (change: TimelineRuntimeChange) => void;
  let viewport!: TimelineViewport;
  function Harness() {
    const [items, setItems] = useState<TimelineViewItem[]>(seeded.items);
    apply = (change) => flushSync(() => setItems(change.items));
    viewport = useTimelineViewport(items);
    return <div className="pwa-app-shell"><main className="pwa-main" style={{ display: "flex", flexDirection: "column", width: "100vw", height: 650, flex: "none" }}>
      <MessageList items={items.filter((item) => !isQueuedMessage(item))} isLive hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onRetryUnknown={noop} />
      <div className="pwa-chat-footer"><MessageComposer {...composer} queuedMessages={<QueuedMessagesPanel items={items} isOnline runtimeRef={{ current: runtime }} channelRef={emptyChannel} applyChange={(change) => setItems(change.items)} onError={noop} />} /></div>
    </main></div>;
  }
  const screen = await renderPwa(<Harness />);
  await frames();
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  return { screen, list,
    send: (text: string) => { const sent = runtime.sendUser(text, undefined, { clientRequestId: "local", requestId: "send" }); viewport.followOwnSend(); if (sent) apply(sent.change); },
    receive: (frame: ServerFrame) => apply(runtime.receive(frame)),
    commit: (event: Parameters<TimelineRuntime["commit"]>[0]) => apply(runtime.commit(event)),
  };
}

test.each([[390, false], [1280, false], [390, true]] as const)("keeps one sent bubble without reflow while it drains from the queue at %ipx (reduced=%s)", async (width, reduced) => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  const h = await runtimeHarness({ width });
  try {
    h.send("New message");
    // 发送后立即捕获并暂停入口动画：真实帧继续推进，但 120/160ms 动画不会在多次采样中自然结束并退出 getAnimations。
    const bubble = h.list.querySelector(".pwa-message.user")!;
    const animation = bubble.getAnimations()[0];
    expect(animation).toBeDefined();
    expect(animation.effect!.getTiming().duration).toBe(reduced ? 120 : 160);
    animation.pause();
    await frames();
    expect(document.querySelector(".pwa-queued-messages")).toBeNull();
    const old = h.list.querySelector(".pwa-message.assistant")!;
    const composerCard = document.querySelector<HTMLElement>(".pwa-composer-card")!;
    const statusText = h.list.querySelector<HTMLElement>(".pwa-delivery-status")!.textContent;
    expect(statusText).toBeTruthy();
    const stable = { height: Math.round(h.list.scrollHeight), client: Math.round(h.list.clientHeight), oldTop: top(old), composerTop: Math.round(composerCard.getBoundingClientRect().top) };
    const assertStable = (label: string) => {
      expect(document.querySelector(".pwa-message.user"), label).toBe(bubble);
      expect(document.querySelector(".pwa-queued-messages"), label).toBeNull();
      expect(gap(h.list), label).toBeLessThanOrEqual(1);
      expect(Math.round(h.list.scrollHeight), label).toBe(stable.height);
      expect(Math.round(h.list.clientHeight), label).toBe(stable.client);
      expect(top(old), label).toBe(stable.oldTop);
      expect(Math.round(composerCard.getBoundingClientRect().top), label).toBe(stable.composerTop);
      expect(bubble.getAnimations()[0], label).toBe(animation);
    };
    assertStable("local pending");
    h.receive(queueSnapshot("local", "New message", false));
    await frames();
    assertStable("in flight");
    // 在途阶段不出现可操作的排队条，发送中状态仍保持在上一个气泡里。
    expect(h.list.querySelector<HTMLElement>(".pwa-delivery-status")!.textContent).toBe(statusText);
    h.receive(startedFrame("message-local", "New message"));
    await frames();
    assertStable("started");
    h.commit(formalEvent("message-local", "New message"));
    await frames();
    assertStable("formal");
    // 正式消息接管后就地隐藏发送状态，旧正文位置和列表 extent 不变。
    expect(h.list.querySelector(".pwa-delivery-status")).toBeNull();
    animation.play();
    await animation.finished;
    expect(bubble.getAnimations().filter((value) => value.playState === "running")).toHaveLength(0);
  } finally { await h.screen.unmount(); }
});

test("an editable queue item enters the conversation once it starts draining", async () => {
  const h = await runtimeHarness();
  try {
    h.receive(queueSnapshot("queued-one", "Queued original", true));
    await frames();
    expect(document.querySelector(".pwa-queued-messages")).not.toBeNull();
    expect(h.list.textContent).not.toContain("Queued original");
    h.receive(queueSnapshot("queued-one", "Queued original", false));
    await frames();
    expect(document.querySelector(".pwa-queued-messages")).toBeNull();
    expect(h.list.textContent).toContain("Queued original");
    // 在途时不再提供取消按钮，改显发送中状态。
    const status = h.list.querySelector<HTMLElement>(".pwa-delivery-status")!;
    expect(status.textContent).toBeTruthy();
    expect(status.querySelector("button")).toBeNull();
  } finally { await h.screen.unmount(); }
});

test("non-tail and unknown/queued statuses stay in flow without covering subsequent messages", async () => {
  const a = pending("a"), b = pending("b");
  const h = await harness();
  try {
    h.update([history, a, b]);
    const statuses = h.list.querySelectorAll<HTMLElement>(".pwa-delivery-status");
    expect(getComputedStyle(statuses[0]).position).toBe("static");
    expect(getComputedStyle(statuses[1]).position).toBe("absolute");
    expect(Math.round(statuses[0].getBoundingClientRect().bottom)).toBeLessThanOrEqual(top(h.list.querySelectorAll(".pwa-message.user")[1]));
    for (const value of [{ ...b, delivery: "unknown_delivery" as const }, { ...b, delivery: "accepted" as const, cancelable: true }]) {
      h.update([history, value]);
      const status = h.list.querySelector<HTMLElement>(".pwa-delivery-status")!;
      expect(getComputedStyle(status).position).toBe("static");
      expect(status.querySelector("button")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("only new local bubbles animate once through receipt and formal handoff; reduced=%s", async reduced => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  const old = formal(pending("old"));
  const h = await harness({ initial: [history, old] });
  try {
    expect(h.list.querySelector(".pwa-message.user")!.getAnimations()).toHaveLength(0);
    h.send();
    const bubble = h.list.querySelectorAll(".pwa-message.user")[1];
    const animation = bubble.getAnimations()[0];
    expect(animation).toBeDefined();
    expect(animation.effect!.getTiming().duration).toBe(reduced ? 120 : 160);
    const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
    expect(keyframes[0].opacity).toBe("0");
    expect(keyframes[0].transform).toBe(reduced ? "translateY(0px)" : "translateY(6px)");
    h.sent().delivery = "received";
    h.update([history, old, h.sent()]);
    expect(h.list.querySelectorAll(".pwa-message.user")[1]).toBe(bubble);
    h.update([history, old, formal(h.sent())]);
    expect(h.list.querySelectorAll(".pwa-message.user")[1]).toBe(bubble);
    expect(bubble.getAnimations()[0]).toBe(animation);
    await animation.finished;
    h.update([history, old, formal(h.sent())]);
    expect(bubble.getAnimations().filter(value => value.playState === "running")).toHaveLength(0);
    h.live(false);
    await frames();
    expect(h.list.querySelectorAll(".pwa-message.user")[1]).toBe(bubble);
    h.live(true);
    expect(bubble.getAnimations().filter(value => value.playState === "running")).toHaveLength(0);
  } finally { await h.screen.unmount(); }
});
