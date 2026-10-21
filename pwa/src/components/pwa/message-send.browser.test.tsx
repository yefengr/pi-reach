import { useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelinePending, TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";
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
