import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import type { TimelineViewItem } from "./timeline-runtime";
import { useTimelineViewport, type TimelineViewport } from "./use-timeline-viewport";
import { captureOwnSendLayout, OwnSendTransition, stageOwnSendInputSize } from "./own-send-transition";

type ViewportHarnessProps = {
  onViewport: (viewport: TimelineViewport) => void;
  items?: readonly TimelineViewItem[];
  enabled?: boolean;
  onItemsChange?: (setItems: (items: readonly TimelineViewItem[]) => void) => void;
  onEnabledChange?: (setEnabled: (enabled: boolean) => void) => void;
};

type RenderViewportOptions = Pick<ViewportHarnessProps, "items" | "enabled">;

function ViewportHarness({ onViewport, items: initialItems, enabled: initialEnabled, onItemsChange, onEnabledChange }: ViewportHarnessProps) {
  const [items, setItems] = useState<readonly TimelineViewItem[] | undefined>(initialItems);
  const [enabled, setEnabled] = useState(initialEnabled ?? true);
  const viewport = useTimelineViewport(items, enabled);

  useEffect(() => {
    onViewport(viewport);
    onItemsChange?.(setItems);
    onEnabledChange?.(setEnabled);
  }, [onEnabledChange, onItemsChange, onViewport, setItems, viewport]);

  return <div data-testid="message-list" />;
}

const renderedTimelineItem: TimelineViewItem = {
  kind: "event",
  event: {
    event_id: "rendered-item",
    session_id: "session-1",
    leaf_id: "generation-1",
    timestamp: 0,
    group_id: "group-1",
    kind: "assistant",
    status: "complete",
    blocks: [{ type: "text", text: "Rendered history" }],
  },
};

async function renderViewport(options: RenderViewportOptions = {}) {
  const viewportState = { current: null as TimelineViewport | null };
  let updateItems: ((items: readonly TimelineViewItem[]) => void) | null = null;
  let updateEnabled: ((enabled: boolean) => void) | null = null;
  const screen = await renderPwa(<ViewportHarness onViewport={(viewport) => { viewportState.current = viewport; }} onItemsChange={(setItems) => { updateItems = setItems; }} onEnabledChange={(setEnabled) => { updateEnabled = setEnabled; }} {...options} />);
  await vi.waitFor(() => expect(viewportState.current).not.toBeNull());

  const viewport = () => {
    const current = viewportState.current;
    if (!current) throw new Error("Timeline viewport did not mount.");
    return current;
  };
  const list = screen.getByTestId("message-list").element() as HTMLDivElement;
  viewport().messageListRef.current = list;
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 });
  const scrollTo = vi.fn();
  Object.defineProperty(list, "scrollTo", { configurable: true, value: scrollTo });

  const setItems = (items: readonly TimelineViewItem[]) => {
    if (!updateItems) throw new Error("Timeline item setter did not mount.");
    updateItems(items);
  };
  const setEnabled = (enabled: boolean) => {
    if (!updateEnabled) throw new Error("Timeline enabled setter did not mount.");
    updateEnabled(enabled);
  };

  return { screen, list, scrollTo, viewport, setItems, setEnabled };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("send capture is readonly and activation after autosize preserves its natural target", () => {
  const main = document.createElement("div");
  main.className = "pwa-main";
  main.innerHTML = '<div class="pwa-message-list"></div><div class="pwa-chat-footer"><div class="pwa-composer"><textarea class="pwa-composer-input" style="height:120px;max-height:160px"></textarea></div></div>';
  document.body.append(main);
  const list = main.querySelector<HTMLDivElement>(".pwa-message-list")!;
  const input = main.querySelector<HTMLTextAreaElement>("textarea")!;
  const footer = main.querySelector<HTMLElement>(".pwa-chat-footer")!;
  list.style.setProperty("--pwa-duration-message-in", "160ms");
  const capture = captureOwnSendLayout(list);
  try {
    expect(input.style.height).toBe("120px");
    expect(footer.style.height).toBe("");
    expect(stageOwnSendInputSize(input, { height: 44, maximum: 160, overflow: "hidden" })).toBe(false);
    // 真实成功回调可晚于 React 子 layout 的 autosize，不能再拍新起点。
    input.style.height = "44px";
    const first = new OwnSendTransition(capture);
    expect(input.style.height).toBe(`${capture.inputHeight}px`);
    const nextCapture = captureOwnSendLayout(list);
    first.finish(false);
    const next = new OwnSendTransition(nextCapture);
    expect(stageOwnSendInputSize(input, { height: 44, maximum: 160, overflow: "hidden" })).toBe(true);
    next.finish();
    expect(input.style.height).toBe("44px");
    expect(footer.style.height).toBe("");
    expect(stageOwnSendInputSize(input, { height: 44, maximum: 160, overflow: "hidden" })).toBe(false);
  } finally { main.remove(); }
});

test("follows realtime output at the bottom without unread output", async () => {
  const { screen, scrollTo, viewport } = await renderViewport();
  try {
    viewport().receiveRealtimeOutput("group-1");

    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" }));
    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("deduplicates unread output after scrolling away without auto-scrolling", async () => {
  const { screen, scrollTo, viewport } = await renderViewport();
  try {
    viewport().handleScroll(false);
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(false));

    viewport().receiveRealtimeOutput("group-1");
    viewport().receiveRealtimeOutput("group-1");

    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));
    expect(scrollTo).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

test("resumes following and clears unread output when returning to the bottom or resetting", async () => {
  const { screen, viewport } = await renderViewport();
  try {
    viewport().handleScroll(false);
    viewport().receiveRealtimeOutput("group-1");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));

    viewport().handleScroll(true);
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(true));
    expect(viewport().unreadOutput).toBe(0);

    viewport().handleScroll(false);
    viewport().receiveRealtimeOutput("group-2");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));

    viewport().reset();
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(true));
    expect(viewport().unreadOutput).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("scrolls smoothly to Latest before resetting output following", async () => {
  const { screen, scrollTo, viewport } = await renderViewport();
  try {
    viewport().handleScroll(false);
    viewport().receiveRealtimeOutput("group-1");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));

    viewport().showLatest();

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(true));
    expect(viewport().unreadOutput).toBe(0);
  } finally {
    await screen.unmount();
  }
});

test("does not follow rendered items when timeline viewport tracking is disabled", async () => {
  const { screen, scrollTo, setItems } = await renderViewport({ enabled: false });
  try {
    flushSync(() => setItems([renderedTimelineItem]));

    expect(scrollTo).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

test("expanding details pauses following without showing Latest until actual scrolling or unread output", async () => {
  const { screen, scrollTo, setItems, viewport } = await renderViewport();
  try {
    flushSync(() => {
      viewport().setReadingDetails(true);
      setItems([renderedTimelineItem]);
    });

    expect(viewport().followingOutput).toBe(true);
    expect(viewport().unreadOutput).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();

    viewport().setReadingDetails(false);
    expect(viewport().followingOutput).toBe(true);
    viewport().setReadingDetails(true);
    viewport().handleScroll(false);
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(false));
    viewport().receiveRealtimeOutput("group-1");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));
  } finally {
    await screen.unmount();
  }
});

test("a history prepend keeps the existing visible element at the same viewport offset", async () => {
  const { screen, list, viewport, setItems, scrollTo } = await renderViewport();
  try {
    const article = document.createElement("article");
    article.dataset.viewportRow = "history-anchor";
    list.append(article);
    let position = 100;
    vi.spyOn(article, "getBoundingClientRect").mockImplementation(() => ({ top: position, bottom: position + 20 } as DOMRect));
    Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 0 });
    flushSync(() => viewport().prepareHistoryPrepend());
    position = 600;
    flushSync(() => setItems([renderedTimelineItem]));
    expect(list.scrollTop).toBe(500);
    expect(viewport().followingOutput).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

test("loading history into an empty viewport stays at its beginning", async () => {
  const { screen, list, viewport, setItems, scrollTo } = await renderViewport();
  try {
    flushSync(() => { viewport().prepareHistoryPrepend(); setItems([renderedTimelineItem]); });
    expect(list.scrollTop).toBe(0);
    expect(viewport().followingOutput).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  } finally { await screen.unmount(); }
});

test("positions rendered items before a frame and coalesces later realtime output", async () => {
  const frames: FrameRequestCallback[] = [];
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback);
    return 31;
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const { screen, scrollTo, viewport, setItems } = await renderViewport();
  try {
    flushSync(() => setItems([renderedTimelineItem]));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // 浏览器已抵达同步目标；随后实时通知无需再滚动。
    Object.defineProperty(viewport().messageListRef.current!, "scrollTop", { configurable: true, value: 1000 });
    viewport().receiveRealtimeOutput("group-1");
    viewport().receiveRealtimeOutput("group-1");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    frames[0](0);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  } finally {
    await screen.unmount();
  }
});

test("restores a reading anchor after observed geometry changes without resuming follow", async () => {
  let triggerResize: (() => void) | null = null;
  const disconnect = vi.fn();
  class StubResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      triggerResize = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {}
    unobserve() {}
    disconnect() { disconnect(); }
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);

  const { screen, list, viewport, setItems } = await renderViewport();
  try {
    Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 100 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
    const row = document.createElement("article");
    row.dataset.timelineKey = "answer-1";
    row.dataset.viewportRow = "answer-1";
    const paragraph = document.createElement("p");
    row.append(paragraph);
    list.append(row);
    let top = 40;
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => ({ top: top - 20, bottom: top + 200 } as DOMRect));
    vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(() => ({ top, bottom: top + 30 } as DOMRect));

    viewport().setReadingDetails(true);
    viewport().handleScroll(false);
    await vi.waitFor(() => expect(viewport().followingOutput).toBe(false));
    flushSync(() => setItems([renderedTimelineItem]));
    expect(triggerResize).not.toBeNull();

    top = 90;
    triggerResize!();
    expect(list.scrollTop).toBe(150);

    viewport().setReadingDetails(false);
    viewport().handleScroll(true);
    expect(viewport().followingOutput).toBe(false);
  } finally {
    await screen.unmount();
  }
  expect(disconnect).toHaveBeenCalled();
});

test("cancels pending follow frames on reset and disable", async () => {
  let nextFrame = 40;
  const requestAnimationFrame = vi.fn(() => nextFrame++);
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  const { screen, viewport, setEnabled } = await renderViewport();
  try {
    viewport().receiveRealtimeOutput("group-1");
    await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));
    viewport().reset();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(40);

    viewport().receiveRealtimeOutput("group-2");
    await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(2));
    flushSync(() => setEnabled(false));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
  } finally {
    await screen.unmount();
  }
});

test("Latest smooth scrolling owns the viewport until completion, then follows new output", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { screen, list, viewport, scrollTo } = await renderViewport();
  try {
    Object.defineProperties(list, { clientHeight: { configurable: true, value: 300 }, scrollTop: { configurable: true, writable: true, value: 100 } });
    flushSync(() => viewport().showLatest());
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1200 });
    viewport().receiveRealtimeOutput("during-smooth");
    frames.shift()!(0);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    list.scrollTop = 400;
    flushSync(() => viewport().handleScroll(false));
    expect(viewport().followingOutput).toBe(true);
    list.scrollTop = 700;
    flushSync(() => viewport().handleScroll(false));
    frames.shift()!(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "auto" });
    expect(viewport().followingOutput).toBe(true);
  } finally { await screen.unmount(); }
});

test("Latest still follows new output when content shrinks during its smooth scroll", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { screen, list, viewport, scrollTo } = await renderViewport();
  try {
    Object.defineProperties(list, { clientHeight: { configurable: true, value: 300 }, scrollTop: { configurable: true, writable: true, value: 100 } });
    flushSync(() => viewport().showLatest());
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 800 });
    list.scrollTop = 500;
    flushSync(() => viewport().handleScroll(true));
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1200 });
    viewport().receiveRealtimeOutput("after-shrink");
    frames.shift()!(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "auto" });
    expect(viewport().followingOutput).toBe(true);
  } finally { await screen.unmount(); }
});

test("scrolling upward cancels a pending follow frame and a Latest animation", async () => {
  const frames: FrameRequestCallback[] = [];
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const { screen, list, viewport, scrollTo } = await renderViewport();
  try {
    viewport().receiveRealtimeOutput("pending");
    flushSync(() => viewport().handleScroll(false));
    expect(cancel).toHaveBeenCalledWith(1);
    frames.shift()!(0);
    expect(scrollTo).not.toHaveBeenCalled();
    Object.defineProperties(list, { clientHeight: { configurable: true, value: 300 }, scrollTop: { configurable: true, writable: true, value: 100 } });
    flushSync(() => viewport().showLatest());
    list.scrollTop = 400;
    flushSync(() => viewport().handleScroll(false));
    list.scrollTop = 300;
    flushSync(() => viewport().handleScroll(false));
    expect(viewport().followingOutput).toBe(false);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: "auto" });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    viewport().receiveRealtimeOutput("after-interruption");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));
    frames.forEach((callback) => callback(200));
    expect(scrollTo).toHaveBeenCalledTimes(2);
  } finally { await screen.unmount(); }
});

test("cancels a pending follow animation frame on unmount", async () => {
  const requestAnimationFrame = vi.fn(() => 42);
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  const { screen, viewport } = await renderViewport();
  viewport().receiveRealtimeOutput("group-1");
  await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));

  await screen.unmount();

  expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
});

function trackingTimelineItem(id: string, text: string): TimelineViewItem {
  return {
    kind: "event",
    event: {
      event_id: id,
      session_id: "session-1",
      leaf_id: "generation-1",
      timestamp: 0,
      group_id: "group-1",
      kind: "assistant",
      status: "complete",
      blocks: [{ type: "text", text }],
    },
  };
}

function installTrackingResizeObserver() {
  const observed = new Set<Element>();
  const recordObserve = vi.fn((element: Element) => { observed.add(element); });
  const recordUnobserve = vi.fn((element: Element) => { observed.delete(element); });
  const recordDisconnect = vi.fn(() => { observed.clear(); });
  class TrackingResizeObserver {
    observe(element: Element) { recordObserve(element); }
    unobserve(element: Element) { recordUnobserve(element); }
    disconnect() { recordDisconnect(); }
  }
  vi.stubGlobal("ResizeObserver", TrackingResizeObserver);
  return { observed, recordObserve, recordUnobserve, recordDisconnect };
}

function appendRow(list: HTMLDivElement, label: string, className = "pwa-timeline-row"): HTMLElement {
  const row = document.createElement("article");
  row.className = className;
  row.dataset.viewportRow = label;
  row.textContent = label;
  list.append(row);
  return row;
}

test("keeps observed direct children without rescanning when items update in place", async () => {
  const { observed, recordObserve, recordUnobserve } = installTrackingResizeObserver();
  const { screen, list, setItems } = await renderViewport({ items: [renderedTimelineItem] });
  try {
    const rows = [appendRow(list, "first"), appendRow(list, "second"), appendRow(list, "third")];
    flushSync(() => setItems([trackingTimelineItem("first", "Initial content")]));
    expect(observed).toEqual(new Set([list, ...rows]));
    const observedCalls = recordObserve.mock.calls.length;
    const unobservedCalls = recordUnobserve.mock.calls.length;
    const matchesCalls = rows.map((row) => vi.spyOn(row, "matches"));

    for (const text of ["Second content", "Third content", "Fourth content"]) {
      flushSync(() => setItems([trackingTimelineItem("first", text)]));
    }

    expect(matchesCalls.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(0);
    expect(recordObserve.mock.calls.length).toBe(observedCalls);
    expect(recordUnobserve.mock.calls.length).toBe(unobservedCalls);
    expect(observed).toEqual(new Set([list, ...rows]));
  } finally {
    await screen.unmount();
  }
});

test("re-observes direct children when identities or roles change", async () => {
  const { observed, recordObserve, recordUnobserve } = installTrackingResizeObserver();
  const { screen, list, setItems } = await renderViewport();
  try {
    const first = appendRow(list, "first");
    const second = appendRow(list, "second");
    let version = 0;
    const bump = () => flushSync(() => setItems([trackingTimelineItem(`bump-${version}`, `content ${version += 1}`)]));

    bump();
    expect(observed).toEqual(new Set([list, first, second]));

    const replacement = appendRow(list, "replacement");
    list.replaceChild(replacement, second);
    bump();
    expect(recordUnobserve).toHaveBeenCalledWith(second);
    expect(observed).toEqual(new Set([list, first, replacement]));

    const inserted = appendRow(list, "inserted");
    bump();
    expect(recordObserve).toHaveBeenCalledWith(inserted);
    expect(observed.has(inserted)).toBe(true);

    list.removeChild(inserted);
    bump();
    expect(recordUnobserve).toHaveBeenCalledWith(inserted);
    expect(observed.has(inserted)).toBe(false);

    // 仅交换顺序不改变观察集合，但快照必须跟上，否则后续同长度替换会被漏掉。
    list.insertBefore(replacement, first);
    bump();
    expect(observed).toEqual(new Set([list, first, replacement]));

    first.className = "pwa-timeline-row pwa-earlier";
    bump();
    expect(recordUnobserve).toHaveBeenCalledWith(first);
    expect(observed.has(first)).toBe(false);

    first.className = "pwa-timeline-row";
    bump();
    expect(recordObserve).toHaveBeenCalledWith(first);
    expect(observed.has(first)).toBe(true);

    list.insertBefore(first, replacement);
    bump();
    const finalRow = appendRow(list, "final");
    list.replaceChild(finalRow, replacement);
    bump();
    expect(observed).toEqual(new Set([list, first, finalRow]));
  } finally {
    await screen.unmount();
  }
});

test("abandons the child snapshot for a new, disabled or empty list", async () => {
  const { observed, recordObserve, recordDisconnect } = installTrackingResizeObserver();
  const { screen, list, setItems, setEnabled, viewport } = await renderViewport();
  try {
    const row = appendRow(list, "row");
    let version = 0;
    const bump = () => flushSync(() => setItems([trackingTimelineItem(`bump-${version}`, `content ${version += 1}`)]));

    bump();
    expect(observed).toEqual(new Set([list, row]));

    flushSync(() => setEnabled(false));
    expect(observed.size).toBe(0);

    flushSync(() => setEnabled(true));
    expect(recordObserve).toHaveBeenCalledWith(list);
    expect(observed).toEqual(new Set([list, row]));

    const nextList = document.createElement("div");
    const nextRow = appendRow(nextList, "next");
    viewport().messageListRef.current = nextList;
    bump();
    expect(recordDisconnect).toHaveBeenCalled();
    expect(observed).toEqual(new Set([nextList, nextRow]));

    const emptyList = document.createElement("div");
    viewport().messageListRef.current = emptyList;
    bump();
    expect(observed).toEqual(new Set([emptyList]));
  } finally {
    await screen.unmount();
  }
});

test("replacing the list DOM with unchanged items rebinds observers and invalidates the old capture", async () => {
  const { observed } = installTrackingResizeObserver();
  const items = [renderedTimelineItem];
  let replace!: () => void;
  let viewport!: TimelineViewport;
  function Harness() {
    const [key, setKey] = useState(0);
    const viewportApi = useTimelineViewport(items);
    const { messageListRef } = viewportApi;
    useEffect(() => { replace = () => setKey(value => value + 1); viewport = viewportApi; }, [viewportApi]);
    return <div key={key} ref={messageListRef} />;
  }
  const screen = await renderPwa(<Harness />);
  try {
    const oldList = viewport.messageListRef.current!;
    const capture = viewport.captureOwnSend();
    expect(observed.has(oldList)).toBe(true);
    flushSync(replace);
    const newList = viewport.messageListRef.current!;
    expect(newList).not.toBe(oldList);
    expect(observed.has(oldList)).toBe(false);
    expect(observed.has(newList)).toBe(true);
    flushSync(() => { viewport.prepareHistoryPrepend(); viewport.followOwnSend(capture); });
    expect(viewport.followingOutput).toBe(false);
  } finally { await screen.unmount(); }
});

test("diagnostics sample actual numeric geometry only when enabled and clear on unbind", async () => {
  installTrackingResizeObserver();
  const { screen, list, viewport, setItems, setEnabled } = await renderViewport();
  const main = list.parentElement!;
  const wasMain = main.classList.contains("pwa-main");
  main.classList.add("pwa-main");
  const footer = document.createElement("div");
  footer.className = "pwa-chat-footer";
  footer.style.height = "72px";
  const input = document.createElement("textarea");
  input.className = "pwa-composer-input";
  input.style.height = "44px";
  footer.append(input);
  main.append(footer);
  list.style.cssText = "height:300px;width:400px;overflow:auto";
  try {
    viewport().reset();
    const control = window.__PI_REACH_VIEWPORT__!;
    control.disable();
    const inputMeasure = vi.spyOn(input, "getBoundingClientRect");
    flushSync(() => setItems([renderedTimelineItem]));
    expect(inputMeasure).not.toHaveBeenCalled();
    expect(control.read()).toEqual([]);

    control.enable();
    flushSync(() => setItems([renderedTimelineItem]));
    expect(inputMeasure).toHaveBeenCalled();
    const entry = control.read().findLast((value) => value.reason === "commit")!;
    expect(entry).toMatchObject({
      listClientHeight: list.clientHeight, listClientWidth: list.clientWidth,
      listScrollHeight: list.scrollHeight, listScrollWidth: list.scrollWidth,
      listTop: list.getBoundingClientRect().top, listHeight: list.getBoundingClientRect().height,
      inputTop: input.getBoundingClientRect().top, inputHeight: input.getBoundingClientRect().height,
      footerTop: footer.getBoundingClientRect().top, footerHeight: footer.getBoundingClientRect().height,
      visualViewportHeight: window.visualViewport?.height ?? null,
      visualViewportWidth: window.visualViewport?.width ?? null,
      visualViewportOffsetTop: window.visualViewport?.offsetTop ?? null,
      visualViewportOffsetLeft: window.visualViewport?.offsetLeft ?? null,
      visualViewportScale: window.visualViewport?.scale ?? null,
    });
    expect(entry.inputHeight).toBeGreaterThan(0);
    expect(entry.footerHeight).toBeGreaterThan(0);
    expect(Object.isFrozen(entry)).toBe(true);

    // 程序回执仍指向原位置；明确改变实际位置后才能模拟一次用户回看。
    Object.defineProperty(list, "scrollTop", { configurable: true, writable: true, value: 100 });
    flushSync(() => viewport().handleScroll(false));
    control.clear();
    list.dispatchEvent(new Event("pwa:timeline-geometry"));
    expect(control.read().at(-1)).toMatchObject({ reason: "geometry", following: false });
    window.dispatchEvent(new Event("resize"));
    expect(control.read().at(-1)?.reason).toBe("viewport-resize");
    flushSync(() => setEnabled(false));
    expect(control.read()).toEqual([]);
  } finally {
    footer.remove();
    if (!wasMain) main.classList.remove("pwa-main");
    await screen.unmount();
  }
});

test("reads list geometry once per synchronous follow, geometry event and Latest", async () => {
  installTrackingResizeObserver();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { screen, list, scrollTo, viewport, setItems } = await renderViewport();
  try {
    let height = 1000;
    let heightReads = 0;
    let clientReads = 0;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, get: () => { heightReads += 1; return height; } },
      clientHeight: { configurable: true, get: () => { clientReads += 1; return 400; } },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    flushSync(() => setItems([renderedTimelineItem]));

    expect(frames).toHaveLength(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "auto" });
    expect(heightReads).toBe(1);
    expect(clientReads).toBe(1);

    height = 1200;
    heightReads = 0;
    clientReads = 0;
    viewport().receiveRealtimeOutput("taller");
    frames.shift()!(0);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "auto" });
    expect(heightReads).toBe(1);
    expect(clientReads).toBe(1);

    height = 1600;
    heightReads = 0;
    clientReads = 0;
    list.dispatchEvent(new Event("pwa:timeline-geometry"));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1600, behavior: "auto" });
    expect(heightReads).toBe(1);
    expect(clientReads).toBe(1);

    height = 2000;
    heightReads = 0;
    clientReads = 0;
    flushSync(() => viewport().showLatest());
    expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ top: 2000 });
    expect(heightReads).toBe(1);
    expect(clientReads).toBe(1);
  } finally {
    await screen.unmount();
  }
});
