import { useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { TimelineRuntime, type TimelinePending, type TimelineRuntimeChange, type TimelineScope, type TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import { MessageList } from "./message-list";
import { isQueuedMessage, QueuedMessagesPanel } from "./queued-messages-panel";
import { MessageComposer } from "./message-composer";
import { PwaMessageActions } from "./pwa-app-actions";

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
async function harness({ width = 390, compact = false, working = false, draft = "New message", live = true, initial = [history], attachment = false, height }: { width?: number; compact?: boolean; working?: boolean; draft?: string; live?: boolean; initial?: TimelineViewItem[]; attachment?: boolean; height?: number } = {}) {
  await page.viewport(width, 844);
  let viewport!: TimelineViewport;
  let update!: (items: TimelineViewItem[]) => void;
  let setLive!: (live: boolean) => void;
  let setWorking!: (value: boolean) => void;
  let editDraft!: (text: string) => void;
  let send!: () => void;
  let sent!: TimelinePending;
  function Harness() {
    const [items, setItems] = useState(initial);
    const [text, setText] = useState(draft);
    const [online, setOnline] = useState(live);
    const [running, updateWorking] = useState(working);
    setWorking = updateWorking;
    const [files, setFiles] = useState<ComponentProps<typeof MessageComposer>["attachments"]>(attachment ? [{ id: "file", fileName: "send-note.txt", byteLength: 12, status: "complete" }] : []);
    setLive = setOnline;
    editDraft = setText;
    viewport = useTimelineViewport(items);
    update = setItems;
    send = () => {
      sent = { ...pending(), text };
      viewport.followOwnSend();
      setItems([...items, sent]);
      setText("");
      setFiles([]);
    };
    return <div className="pwa-app-shell"><main className="pwa-main" data-composer-budget={compact ? "constrained" : undefined} style={{ display: "flex", flexDirection: "column", width: "100vw", height: height ?? (compact ? 280 : 650), flex: "none" }}>
      <MessageList items={items} isLive={online} running={running} hasEarlier={false} listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef} onScroll={viewport.handleScroll} onRetryUnknown={noop} onCancelQueued={noop} />
      <div className="pwa-chat-footer"><PwaMessageActions show={!viewport.followingOutput} showLatest={!viewport.followingOutput} showRetry={false} unreadOutput={viewport.unreadOutput} onRetry={noop} onLatest={viewport.showLatest} /><MessageComposer {...composer} attachments={files} draft={text} onDraftChange={setText} onSend={send} /></div>
    </main></div>;
  }
  const screen = await renderPwa(<Harness />);
  await frames();
  const list = document.querySelector<HTMLDivElement>(".pwa-message-list")!;
  return { screen, list, viewport: () => viewport, sent: () => sent,
    live: (value: boolean) => flushSync(() => setLive(value)),
    work: (value: boolean, items?: TimelineViewItem[]) => flushSync(() => { setWorking(value); if (items) update(items); }),
    edit: (value: string) => flushSync(() => { document.querySelector(".pwa-composer-input")!.dispatchEvent(new Event("input", { bubbles: true })); editDraft(value); }),
    send: () => flushSync(() => send()), update: (items: TimelineViewItem[]) => flushSync(() => update(items)),
    read: async () => { list.scrollTop -= 300; flushSync(() => list.dispatchEvent(new Event("scroll", { bubbles: true }))); await frames(); },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
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

function layoutClock() {
  let now = 1000;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++nextId, callback); return nextId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { callbacks.delete(id); });
  return {
    step: (elapsed: number) => { now = 1000 + elapsed; const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(now); },
    pending: () => callbacks.size,
    snapshot: () => [...callbacks.values()],
  };
}

test.each([390, 1280].flatMap(width => [false, true].map(attachment => ({ width, attachment }))))("own send coordinates multiline shrink and scroll on one 160ms clock at $width (attachment=$attachment)", async ({ width, attachment }) => {
  const h = await harness({ width, attachment, draft: "Line one\nLine two\nLine three\nLine four\nLine five" });
  try {
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
    const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
    const old = h.list.querySelector(".pwa-message.assistant")!;
    const before = { input: input.getBoundingClientRect().height, scroll: h.list.scrollTop, footer: footer.getBoundingClientRect().height, old: top(old) };
    const clock = layoutClock();
    h.send();
    expect(input.value).toBe("");
    expect(input.getBoundingClientRect().height).toBe(before.input);
    expect(Math.round(h.list.scrollTop)).toBe(Math.round(before.scroll));
    expect(footer.getBoundingClientRect().height).toBe(before.footer);
    expect(top(old)).toBe(before.old);
    expect(gap(h.list)).toBeGreaterThan(1);
    const samples: { input: number; scroll: number }[] = [];
    for (const time of [0, 40, 80, 120, 160]) {
      clock.step(time);
      samples.push({ input: input.getBoundingClientRect().height, scroll: h.list.scrollTop });
    }
    expect(samples[1].input).toBeLessThan(before.input);
    expect(samples[1].input).toBeGreaterThan(samples.at(-1)!.input);
    expect(samples[1].scroll).toBeGreaterThan(before.scroll);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].input).toBeLessThanOrEqual(samples[i - 1].input);
      expect(samples[i].scroll).toBeGreaterThanOrEqual(samples[i - 1].scroll - 1);
    }
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(h.viewport().followingOutput).toBe(true);
    clock.step(200);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("late Working follows continuously regardless of simultaneous receipt (receipt=%s)", async receipt => {
  const h = await harness();
  try {
    h.send();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".pwa-chat-footer")!.style.height).toBe(""));
    await frames();
    const clock = layoutClock();
    const before = h.list.scrollTop;
    h.work(true, receipt ? [history, h.sent()] : undefined);
    expect(h.list.scrollTop).toBe(before);
    expect(gap(h.list)).toBeGreaterThan(1);
    clock.step(40);
    expect(h.list.scrollTop).toBeGreaterThan(before);
    expect(gap(h.list)).toBeGreaterThan(1);
    clock.step(160);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(h.viewport().followingOutput).toBe(true);
    clock.step(200);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("real frames remain monotonic through send release and late Working (attachment=%s)", async attachment => {
  const h = await harness({ attachment, draft: "One\nTwo\nThree\nFour" });
  try {
    const old = h.list.querySelector(".pwa-message.assistant")!;
    const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
    const context = getComputedStyle(footer).display;
    const samples: number[] = [];
    let latestFlashed = false;
    const observer = new MutationObserver(() => { latestFlashed ||= document.querySelector(".pwa-message-actions") !== null; });
    observer.observe(footer, { childList: true, subtree: true });
    try {
      h.send();
      const sampleUntilSettled = async () => {
        const deadline = performance.now() + 3000;
        let settledFrames = 0;
        while (settledFrames < 3 && performance.now() < deadline) {
          await frames(1);
          samples.push(top(old));
          expect(getComputedStyle(footer).display).toBe(context);
          settledFrames = footer.style.height === "" && gap(h.list) <= 1 ? settledFrames + 1 : 0;
        }
        expect(settledFrames).toBe(3);
      };
      await sampleUntilSettled();
      expect(footer.style.height).toBe("");
      h.work(true);
      await sampleUntilSettled();
      for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1);
      expect(latestFlashed).toBe(false);
      expect(h.viewport().followingOutput).toBe(true);
      expect(gap(h.list)).toBeLessThanOrEqual(1);
    } finally { observer.disconnect(); }
  } finally { await h.screen.unmount(); }
});

test.each([40, 145])("Working arriving at %ims updates the send without an instantaneous jump or a new clock", async time => {
  const h = await harness();
  try {
    const clock = layoutClock();
    h.send(); clock.step(time);
    const before = h.list.scrollTop;
    h.work(true);
    expect(h.list.scrollTop).toBe(before);
    clock.step(160);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    clock.step(200);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test("Reduced Motion immediately settles Working geometry and keeps the status feedback", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const h = await harness();
  try {
    const clock = layoutClock();
    h.work(true);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    const status = h.list.querySelector<HTMLElement>(".pwa-thinking-status")!;
    expect(status.textContent).toBe("Working…");
    expect(getComputedStyle(status.querySelector("svg")!).opacity).toBe("1");
    expect(getComputedStyle(status.querySelector(".pwa-working-label")!).transform).toBe("none");
    h.work(false);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(h.list.style.paddingBottom).toBe("");
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test.each([40, 145, 160])("send handoff owns late programmatic scroll at %ims without flashing Latest", async time => {
  const h = await harness({ attachment: true, draft: "One\nTwo\nThree" });
  try {
    const clock = layoutClock();
    h.send(); clock.step(time);
    const before = h.list.scrollTop;
    flushSync(() => {
      h.list.scrollTop -= 80;
      h.list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(Math.round(h.list.scrollTop)).toBe(Math.round(before));
    expect(h.viewport().followingOutput).toBe(true);
    expect(document.querySelector(".pwa-message-actions")).toBeNull();
    clock.step(160); clock.step(200);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test.each(["wheel", "scrollbar"])("real %s interruption wins over the send handoff guard", async input => {
  const h = await harness();
  try {
    const clock = layoutClock();
    h.send(); clock.step(160);
    flushSync(() => {
      h.list.dispatchEvent(input === "wheel" ? new WheelEvent("wheel", { deltaY: -80 }) : new PointerEvent("pointerdown", { pointerType: "mouse" }));
      h.list.scrollTop -= 80;
      h.list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const top = h.list.scrollTop;
    clock.step(200);
    expect(h.list.scrollTop).toBe(top);
    expect(h.viewport().followingOutput).toBe(false);
    expect(document.querySelector(".pwa-message-actions")).not.toBeNull();
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("Working removal has no single-frame clamp and releases temporary space (receipt=%s)", async receipt => {
  const h = await harness({ working: true });
  try {
    const before = h.list.scrollTop;
    const clock = layoutClock();
    h.work(false, receipt ? [history] : undefined);
    expect(Math.round(h.list.scrollTop)).toBe(Math.round(before));
    clock.step(40);
    expect(h.list.scrollTop).toBeLessThan(before);
    clock.step(160); clock.step(200);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(h.list.style.paddingBottom).toBe("");
    expect(h.viewport().followingOutput).toBe(true);
  } finally { await h.screen.unmount(); }
});

test.each(["reset", "details", "resize", "unmount"])("%s cancels a Working transition and its stale callbacks", async action => {
  const h = await harness();
  let unmounted = false;
  try {
    const clock = layoutClock();
    h.work(true); clock.step(40);
    const stale = clock.snapshot();
    if (action === "unmount") { await h.screen.unmount(); unmounted = true; }
    else if (action === "reset") h.viewport().reset();
    else if (action === "details") h.viewport().setReadingDetails(true);
    else window.dispatchEvent(new Event("resize"));
    const before = h.list.scrollTop;
    for (const callback of stale) callback(1300);
    expect(h.list.scrollTop).toBe(before);
    expect(h.list.style.paddingBottom).toBe("");
  } finally { if (!unmounted) await h.screen.unmount(); }
});

test("Working after Latest completes starts at the actual bottom, not the old reading position", async () => {
  const h = await harness({ working: true });
  try {
    await h.read();
    const clock = layoutClock();
    const nativeScroll = h.list.scrollTo.bind(h.list);
    vi.spyOn(h.list, "scrollTo").mockImplementation((options?: ScrollToOptions | number) => {
      if (typeof options !== "object") return;
      if (options.behavior === "smooth") h.list.scrollTop = Math.min(options.top ?? 0, h.list.scrollHeight - h.list.clientHeight);
      else nativeScroll(options);
    });
    // 精确交付 smooth 完成事件，避免额外原生 scroll 偶然刷新起点而掩盖缺陷。
    flushSync(() => { h.viewport().showLatest(); h.viewport().handleScroll(true); });
    clock.step(0);
    const before = h.list.scrollTop;
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    h.work(false);
    expect(Math.round(h.list.scrollTop)).toBe(Math.round(before));
    clock.step(160); clock.step(200);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("same-commit scope reset and Working change discard old geometry (working=%s)", async working => {
  const h = await harness({ working });
  try {
    const clock = layoutClock();
    h.viewport().reset();
    h.work(!working, [{ ...history, event: { ...history.event, event_id: "other-scope", blocks: [{ type: "text", text: "Short history" }] } }]);
    expect(h.list.scrollTop).toBe(0);
    expect(h.list.style.paddingBottom).toBe("");
    clock.step(200);
    expect(gap(h.list)).toBe(0);
  } finally { await h.screen.unmount(); }
});

test("Working after reset to a short conversation cannot borrow the previous scroll position", async () => {
  const h = await harness();
  try {
    expect(h.list.scrollTop).toBeGreaterThan(0);
    h.viewport().reset();
    h.update([{ ...history, event: { ...history.event, event_id: "short", blocks: [{ type: "text", text: "Short history" }] } }]);
    const clock = layoutClock();
    h.work(true);
    expect(h.list.scrollTop).toBe(0);
    expect(h.list.style.paddingBottom).toBe("");
    clock.step(200);
    expect(gap(h.list)).toBe(0);
  } finally { await h.screen.unmount(); }
});

test("late Working preserves a reading anchor and does not take over Latest", async () => {
  const h = await harness();
  try {
    h.send();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".pwa-chat-footer")!.style.height).toBe(""));
    await h.read();
    const before = top(h.list.querySelector(".pwa-message.assistant")!);
    h.work(true);
    await frames(12);
    expect(top(h.list.querySelector(".pwa-message.assistant")!)).toBe(before);
    expect(h.viewport().followingOutput).toBe(false);
    h.viewport().showLatest();
    h.work(false);
    await vi.waitFor(() => expect(gap(h.list)).toBeLessThanOrEqual(1));
    expect(h.viewport().followingOutput).toBe(true);
  } finally { await h.screen.unmount(); }
});

test("own-send scroll is interruptible without a later frame reclaiming the reading position", async () => {
  const h = await harness({ draft: "Line one\nLine two\nLine three\nLine four\nLine five" });
  try {
    await h.read();
    expect(h.viewport().followingOutput).toBe(false);
    const clock = layoutClock();
    h.send();
    clock.step(40);
    flushSync(() => {
      h.list.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      h.list.scrollTop -= 100;
      h.list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(h.viewport().followingOutput).toBe(false);
    const before = top(h.list.querySelector(".pwa-message.assistant")!);
    clock.step(160);
    h.update([history, h.sent(), { ...history, event: { ...history.event, event_id: "reply", blocks: [{ type: "text", text: "First reply\n\nMore output" }] } }]);
    clock.step(250);
    expect(top(h.list.querySelector(".pwa-message.assistant")!)).toBe(before);
    expect(h.viewport().followingOutput).toBe(false);
  } finally { await h.screen.unmount(); }
});

test.each(["tap", "toward-latest", "read-earlier"])("touch %s only interrupts the send when moving toward earlier content", async action => {
  const h = await harness({ draft: "One\nTwo\nThree\nFour" });
  try {
    const clock = layoutClock();
    h.send(); clock.step(40);
    const touch = (type: string, y: number, end = false) => h.list.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: end ? [] : [new Touch({ identifier: 1, target: h.list, clientY: y })] }));
    flushSync(() => {
      touch("touchstart", 100);
      if (action !== "tap") touch("touchmove", action === "read-earlier" ? 120 : 80);
      touch("touchend", 100, true);
    });
    expect(h.viewport().followingOutput).toBe(action !== "read-earlier");
    clock.step(160);
    if (action !== "read-earlier") expect(gap(h.list)).toBeLessThanOrEqual(1);
  } finally { await h.screen.unmount(); }
});

test("Reduced Motion skips send layout motion while clearing the draft and restoring follow", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const h = await harness({ draft: "Line one\nLine two\nLine three\nLine four\nLine five" });
  try {
    await h.read();
    const clock = layoutClock();
    h.send();
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!.value).toBe("");
    expect(h.viewport().followingOutput).toBe(true);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test("short-screen attachment handoff uses natural chrome budget from its first commit", async () => {
  const h = await harness({ height: 400, attachment: true, draft: "One\nTwo\nThree\nFour\nFive" });
  try {
    const main = document.querySelector<HTMLElement>(".pwa-main")!;
    const old = h.list.querySelector(".pwa-message.assistant")!;
    const before = top(old);
    h.send();
    const firstBudget = main.dataset.composerBudget;
    expect(top(old)).toBe(before);
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".pwa-chat-footer")!.style.height).toBe(""));
    await frames();
    expect(main.dataset.composerBudget).toBe(firstBudget);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
  } finally { await h.screen.unmount(); }
});

test("enabling Reduced Motion mid-send settles and releases the old clock", async () => {
  const h = await harness({ draft: "One\nTwo\nThree\nFour" });
  try {
    const clock = layoutClock();
    h.send(); clock.step(40);
    const stale = clock.snapshot();
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".pwa-chat-footer")!.style.height).toBe(""));
    const before = h.list.scrollTop;
    for (const callback of stale) callback(1200);
    expect(h.list.scrollTop).toBe(before);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
  } finally { await h.screen.unmount(); }
});

test.each([false, true])("compact xlarge own send finishes without hiding status (Working=%s)", async working => {
  document.documentElement.dataset.pwaTextSize = "xlarge";
  const h = await harness({ compact: true, working, draft: "One\nTwo\nThree\nFour\nFive" });
  try {
    const before = h.list.scrollTop;
    const clock = layoutClock();
    h.send();
    expect(h.list.scrollTop).toBe(before);
    clock.step(160);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    const status = h.list.querySelector(".pwa-delivery-status")!;
    expect(Math.round(status.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(h.list.getBoundingClientRect().bottom));
    expect(document.querySelector<HTMLInputElement>(".pwa-composer-input")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  } finally { await h.screen.unmount(); }
});

test("receipts and output arriving inside a send update its target without restarting the clock", async () => {
  const h = await harness({ draft: "A new message" });
  try {
    const clock = layoutClock();
    h.send();
    clock.step(40);
    h.sent().delivery = "received";
    h.update([history, h.sent()]);
    clock.step(80);
    h.update([history, formal(h.sent()), { ...history, event: { ...history.event, event_id: "reply", blocks: [{ type: "text", text: "First reply" }] } }]);
    clock.step(160);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
    expect(document.querySelector(".pwa-chat-footer")!.getAttribute("style") ?? "").not.toContain("height");
    expect(h.viewport().followingOutput).toBe(true);
    clock.step(200);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); }
});

test.each(["reset", "details", "history", "resize", "hidden", "unmount"])("%s releases the send clock and ignores its cancelled callbacks", async action => {
  const h = await harness({ draft: "One\nTwo\nThree\nFour" });
  let unmounted = false;
  try {
    const clock = layoutClock();
    h.send(); clock.step(40);
    const stale = clock.snapshot();
    if (action === "unmount") { await h.screen.unmount(); unmounted = true; }
    else flushSync(() => {
      if (action === "reset") h.viewport().reset();
      else if (action === "details") h.viewport().setReadingDetails(true);
      else if (action === "resize") window.dispatchEvent(new Event("resize"));
      else if (action === "hidden") { vi.spyOn(document, "hidden", "get").mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange")); }
      else h.viewport().prepareHistoryPrepend();
    });
    const before = { scroll: h.list.scrollTop, height: h.list.clientHeight };
    for (const callback of stale) callback(1300);
    expect(h.list.scrollTop).toBe(before.scroll);
    expect(h.list.clientHeight).toBe(before.height);
    // resize 同时安排普通 autosize 重测，它不属于已取消的发送时钟。
    if (action === "resize") clock.step(300);
    expect(clock.pending()).toBe(0);
  } finally { if (!unmounted) await h.screen.unmount(); }
});

test("editing the next draft releases the old input-height owner before a second send", async () => {
  const h = await harness({ draft: "One\nTwo\nThree\nFour" });
  try {
    const input = document.querySelector<HTMLTextAreaElement>(".pwa-composer-input")!;
    const clock = layoutClock();
    h.send(); clock.step(40);
    const stale = clock.snapshot();
    h.edit("Next one\nNext two\nNext three\nNext four\nNext five");
    const height = input.getBoundingClientRect().height;
    expect(height).toBeGreaterThan(44);
    for (const callback of stale) callback(1080);
    expect(input.getBoundingClientRect().height).toBe(height);
    h.send();
    expect(input.getBoundingClientRect().height).toBe(height);
    clock.step(200);
    expect(input.getBoundingClientRect().height).toBe(44);
    expect(gap(h.list)).toBeLessThanOrEqual(1);
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
    await vi.waitFor(() => expect(gap(h.list)).toBeLessThanOrEqual(1));
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
