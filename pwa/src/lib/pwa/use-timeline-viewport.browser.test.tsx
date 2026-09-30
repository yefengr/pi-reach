import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { renderPwa } from "@/test/browser/render";
import type { TimelineViewItem } from "./timeline-runtime";
import { useTimelineViewport, type TimelineViewport } from "./use-timeline-viewport";

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

test("coalesces rendered items and realtime output into one follow frame", async () => {
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
    viewport().receiveRealtimeOutput("after-interruption");
    await vi.waitFor(() => expect(viewport().unreadOutput).toBe(1));
    expect(scrollTo).toHaveBeenCalledTimes(1);
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
