import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TIMELINE_GEOMETRY_EVENT, useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { resetTextSizeStateForTest, setTextSize, TEXT_SIZE_STORAGE_KEY } from "@/lib/ui/text-size";
import { observeKeyboardViewport } from "@/lib/pwa/use-keyboard-viewport";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageComposer } from "./message-composer";
import type { ComposerAttachmentItem } from "./attachment-cards";
import { MessageList } from "./message-list";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaUiProvider } from "./pwa-ui-provider";

const items: TimelineViewItem[] = Array.from({ length: 5 }, (_, index) => ({
  kind: "event", event: {
    session_id: "keyboard", leaf_id: "generation", event_id: `answer-${index}`, group_id: `answer-${index}`,
    timestamp: 1, kind: "assistant", status: "complete",
    blocks: [{ type: "text", text: Array.from({ length: 12 }, (_, paragraph) => `Answer ${index}, paragraph ${paragraph}: this text stays readable while the input and keyboard change height.`).join("\n\n") }],
  },
}));

class ViewportMock extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
  change(values: Partial<Pick<ViewportMock, "height" | "offsetTop" | "scale">>, event = "resize") {
    Object.assign(this, values);
    this.dispatchEvent(new Event(event));
  }
}

async function settle() {
  for (let frame = 0; frame < 6; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

async function renderWorkspace(initialDraft = "", sendAccepted = false) {
  let changeDraft!: (text: string) => void;
  let changeAttachment!: (value: ComposerAttachmentItem | null) => void;
  let timeline!: TimelineViewport;
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const [attachment, setAttachment] = useState<ComposerAttachmentItem | null>(null);
    changeDraft = setDraft;
    changeAttachment = setAttachment;
    timeline = useTimelineViewport(items);
    return <PwaAppShell runtimeNotice={null}><div className="pwa-root">
      <div className="pwa-layout">
        <div className="pwa-desktop-navigation"><aside className="pwa-sidebar">Sessions</aside></div>
        <main className="pwa-main">
          <header className="pwa-title-bar">Pi Reach</header>
          <MessageList items={items} hasEarlier={false} listRef={timeline.messageListRef} bottomSentinelRef={timeline.bottomSentinelRef} onScroll={timeline.handleScroll} />
          <div className="pwa-chat-footer"><MessageComposer
            attachments={attachment ? [attachment] : []} canAttach sendingAttachments={false} isOnline isWorking={false} stopping={false}
            draft={draft} onDraftChange={setDraft} onSend={() => {
              if (!sendAccepted) return;
              const capture = timeline.captureOwnSend();
              timeline.followOwnSend(capture);
              setDraft("");
            }} onStop={() => {}} onAddFiles={() => {}} onRemoveAttachment={() => setAttachment(null)} onRetryAttachment={() => {}}
            commandModels={[]} commandCurrentModel={null} commandCurrentModelFallback={null} commandThinking="off" commandPendingAction={null}
            onNewSession={() => {}} onCompactSession={() => {}} onSetModel={() => {}} onSetThinking={() => {}} onCommandsOpen={() => {}}
          /></div>
        </main>
      </div>
    </div></PwaAppShell>;
  }
  const screen = await render(<PwaUiProvider><Harness /></PwaUiProvider>);
  await settle();
  const input = screen.getByPlaceholder("Message your agent…").element() as HTMLTextAreaElement;
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const shell = document.querySelector<HTMLElement>(".pwa-app-shell")!;
  return {
    screen, input, list, shell, timeline: () => timeline,
    draft: async (text: string) => { flushSync(() => changeDraft(text)); await settle(); },
    attachment: async (value: ComposerAttachmentItem | null) => { flushSync(() => changeAttachment(value)); await settle(); },
  };
}

const sixLineHeight = (input: HTMLElement) => {
  const style = getComputedStyle(input);
  return 6 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
};
const bottomGap = (list: HTMLElement) => list.scrollHeight - list.clientHeight - list.scrollTop;
const offset = (node: Element, list: Element) => node.getBoundingClientRect().top - list.getBoundingClientRect().top;

afterEach(async () => {
  vi.unstubAllGlobals();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  window.localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
  resetTextSizeStateForTest();
  await page.viewport(1280, 900);
});

test.each([390, 767, 768, 1440])("grows through six visual lines, scrolls the seventh and shrinks on delete at %ipx", async width => {
  await page.viewport(width, 900);
  const view = await renderWorkspace();
  expect(view.input.getBoundingClientRect().height).toBe(44);
  await view.draft(Array.from({ length: 6 }, (_, index) => `Line ${index}`).join("\n"));
  expect(Math.abs(view.input.getBoundingClientRect().height - sixLineHeight(view.input))).toBeLessThan(1);
  expect(view.input.scrollHeight - view.input.clientHeight).toBeLessThanOrEqual(1);
  await view.draft("Line\n".repeat(8));
  expect(view.input.scrollHeight).toBeGreaterThan(view.input.clientHeight);
  expect(getComputedStyle(view.input).overflowY).toBe("auto");
  expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  await view.draft("Short");
  expect(view.input.getBoundingClientRect().height).toBe(44);
  expect(getComputedStyle(view.input).overflowY).toBe("hidden");
  await view.screen.unmount();
});

test("recalculates visual wrapping on width changes and includes an attachment in the space budget", async () => {
  await page.viewport(1440, 900);
  const view = await renderWorkspace("Visual wrapping without newline characters. ".repeat(6));
  const wideHeight = view.input.getBoundingClientRect().height;
  await page.viewport(390, 900);
  await settle();
  expect(view.input.getBoundingClientRect().height).toBeGreaterThan(wideHeight);
  expect(view.input.getBoundingClientRect().height).toBeLessThanOrEqual(sixLineHeight(view.input));
  await page.viewport(390, 420);
  await view.attachment({ id: "attachment", fileName: "Attachment", byteLength: 1024, status: "draft" });
  expect(view.input.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(view.input.getBoundingClientRect().height).toBeLessThan(sixLineHeight(view.input));
  expect(view.list.clientHeight).toBeGreaterThanOrEqual(40);
  expect(document.querySelector("[data-composer-budget='conflict']")).toBeNull();
  expect(view.screen.getByRole("button", { name: "Send message", exact: true }).element().getBoundingClientRect().bottom).toBeLessThanOrEqual(420);
  await view.attachment(null);
  await page.viewport(1440, 900);
  await settle();
  expect(Math.abs(view.input.getBoundingClientRect().height - wideHeight)).toBeLessThan(1);
  await view.screen.unmount();
});

test.each([[390, 844, 310], [844, 390, 260], [768, 1024, 440]])("keeps the keyboard above the fold and follows output at %ix%i", async (width, height, keyboardHeight) => {
  await page.viewport(width, height);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace("Draft line\n".repeat(8));
  view.input.focus({ preventScroll: true });
  viewport.change({ height: keyboardHeight, offsetTop: 12 });
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
  expect(view.shell.getBoundingClientRect().top).toBe(12);
  expect(view.shell.getBoundingClientRect().height).toBe(keyboardHeight);
  expect(view.input.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(view.list.clientHeight).toBeGreaterThanOrEqual(40);
  expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  const send = view.screen.getByRole("button", { name: "Send message", exact: true }).element();
  expect(send.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(send.getBoundingClientRect().bottom).toBeLessThanOrEqual(keyboardHeight + 12);
  viewport.change({ offsetTop: 24 }, "scroll");
  await settle();
  expect(view.shell.getBoundingClientRect().top).toBe(24);
  view.input.blur();
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
  viewport.change({ height, offsetTop: 0 });
  await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  await settle();
  expect(view.shell.getBoundingClientRect().height).toBe(height);
  expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  await view.screen.unmount();
});

test("tightens the composer bottom under the keyboard and restores the safe area after closing", async () => {
  await page.viewport(390, 844);
  // 无头 Chromium 的 env(safe-area-inset-bottom) 恒为 0，用根节点变量模拟 Home 指示条安全区。
  document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  const paddingBottom = () => parseFloat(getComputedStyle(composer).paddingBottom);
  try {
    expect(paddingBottom()).toBe(34);
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 330 });
    await settle();
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect(paddingBottom()).toBe(8);
    view.input.blur();
    viewport.change({ height: 844 });
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(paddingBottom()).toBe(34);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    await view.screen.unmount();
  }
});

test("locks the document to the visible height under the keyboard so iOS has no scroll to animate back", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const root = document.documentElement;
  // 无头 Chromium 不会为聚焦滚动文档；模拟 iOS 已把文档滚到底的读数，确认补偿时立即复位。
  const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(404);
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    expect(root.hasAttribute("data-pwa-keyboard")).toBe(true);
    expect(Math.round(root.getBoundingClientRect().height)).toBe(470);
    expect(Math.round(document.body.getBoundingClientRect().height)).toBe(470);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: window.scrollX, behavior: "instant" });
    scrollY.mockReturnValue(0);
    view.input.blur();
    viewport.change({ height: 844 });
    await expect.poll(() => root.hasAttribute("data-pwa-keyboard")).toBe(false);
    expect(root.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("");
  } finally {
    scrollY.mockRestore();
    scrollTo.mockRestore();
    await view.screen.unmount();
  }
  expect(root.hasAttribute("data-pwa-keyboard")).toBe(false);
});

test("opening commits complete layout before reading or resetting window scroll", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  // 本用例只查同步提交顺序；真实收起动效由下方逐帧用例覆盖。
  view.shell.style.setProperty("--pwa-duration-keyboard", "0ms");
  const other = document.createElement("textarea");
  other.style.position = "fixed";
  document.body.append(other);
  const snapshot = () => {
    const shell = getComputedStyle(view.shell);
    const list = getComputedStyle(view.list);
    return [Math.round(document.documentElement.getBoundingClientRect().height),
      Math.round(document.body.getBoundingClientRect().height), shell.position,
      Math.round(view.shell.getBoundingClientRect().top), Math.round(view.shell.getBoundingClientRect().height),
      view.shell.dataset.compactHeight ?? null, parseFloat(list.paddingTop), parseFloat(list.paddingBottom)];
  };
  const reads: ReturnType<typeof snapshot>[] = [];
  const resets: ReturnType<typeof snapshot>[] = [];
  const notifications: ReturnType<typeof snapshot>[] = [];
  const scrollY = vi.spyOn(window, "scrollY", "get").mockImplementation(() => { reads.push(snapshot()); return 404; });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => { resets.push(snapshot()); });
  const geometry = () => { notifications.push(snapshot()); expect(resets.length).toBeGreaterThan(0); };
  view.list.addEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
  const check = (expected: ReturnType<typeof snapshot>) => {
    expect.soft(reads.length).toBeGreaterThan(0);
    expect.soft(resets.length).toBe(reads.length);
    for (const value of [...reads, ...resets, ...notifications]) expect.soft(value).toEqual(expected);
    expect.soft(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: window.scrollX, behavior: "instant" });
    reads.length = resets.length = notifications.length = 0;
  };
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470, offsetTop: 12 });
    check([470, 470, "fixed", 12, 470, "short", 8, 8]);
    await settle();
    reads.length = resets.length = notifications.length = 0;
    viewport.change({ height: 430, offsetTop: 24 });
    check([430, 430, "fixed", 24, 430, "very-short", 8, 8]);
    viewport.change({ height: 620, offsetTop: 8 });
    check([844, 844, "fixed", 8, 620, null, 24, 88]);
    // 已补偿时的新焦点仍写最新VV锁值；不等下一帧，也不消费旧文档交还标记。
    viewport.height = 610;
    other.focus({ preventScroll: true });
    check([610, 610, "fixed", 8, 620, null, 24, 88]);
  } finally {
    view.list.removeEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
    scrollY.mockRestore();
    scrollTo.mockRestore();
    other.remove();
    await view.screen.unmount();
  }
});

test.each([
  { bypass: false, reset: true }, { bypass: true, reset: true },
  { bypass: false, reset: false }, { bypass: true, reset: false },
])("offset handoff resamples after window processing: bypass=$bypass reset=$reset", async ({ bypass, reset }) => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const root = document.documentElement;
  // 只模拟standalone自然文档高度与CSS实验门控，不模拟WebKit原生反馈。
  const style = document.createElement("style");
  style.textContent = "html:has(.pwa-root), body:has(.pwa-root) { height: 874px; }";
  const experiment = document.createElement("div");
  if (bypass) {
    experiment.className = "pwa-viewport-debug";
    experiment.setAttribute("data-document-lock-bypass", "");
  }
  document.head.append(style);
  document.body.append(experiment);
  view.input.focus({ preventScroll: true });
  const snapshot = () => [Math.round(root.getBoundingClientRect().height),
    Math.round(document.body.getBoundingClientRect().height), getComputedStyle(view.shell).position,
    Math.round(view.shell.getBoundingClientRect().top), Math.round(view.shell.getBoundingClientRect().height),
    view.shell.dataset.compactHeight, parseFloat(getComputedStyle(view.list).paddingBottom)];
  const reads: ReturnType<typeof snapshot>[] = [];
  const notifications: number[] = [];
  const reports: number[] = [];
  const scrollY = vi.spyOn(window, "scrollY", "get").mockImplementation(() => {
    reads.push(snapshot());
    // scrollY为零时也可能在提交布局后改变原生offset；不发送后续事件。
    if (!reset) viewport.offsetTop = 0;
    return reset ? 404 : 0;
  });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => { viewport.offsetTop = 0; });
  const geometry = () => { notifications.push(Math.round(view.shell.getBoundingClientRect().top)); };
  view.list.addEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
  const unobserve = observeKeyboardViewport(view.shell, () => { reports.push(Math.round(view.shell.getBoundingClientRect().top)); });
  try {
    viewport.change({ height: 470, offsetTop: 342 });
    expect.soft(reads).toEqual([[bypass ? 874 : 470, bypass ? 874 : 470, "fixed", 342, 470, "short", 8]]);
    expect.soft(scrollTo).toHaveBeenCalledTimes(reset ? 1 : 0);
    if (reset) expect.soft(scrollTo).toHaveBeenCalledWith({ top: 0, left: window.scrollX, behavior: "instant" });
    expect.soft(root.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("470px");
    expect.soft(viewport.offsetTop).toBe(0);
    expect.soft(view.shell.style.getPropertyValue("--pwa-viewport-top")).toBe("0px");
    expect.soft(Math.round(view.shell.getBoundingClientRect().top)).toBe(0);
    expect.soft(notifications).toEqual([0]);
    expect.soft(reports).toEqual([0]);
  } finally {
    unobserve();
    view.list.removeEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
    scrollY.mockRestore();
    scrollTo.mockRestore();
    experiment.remove();
    style.remove();
    await view.screen.unmount();
  }
});

test.each([false, true])("offset handoff synchronously corrects compensated refocus: reset=%s", async reset => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  view.input.focus({ preventScroll: true });
  viewport.change({ height: 470, offsetTop: 12 });
  await settle();
  const other = document.createElement("textarea");
  other.style.position = "fixed";
  document.body.append(other);
  const scrollY = vi.spyOn(window, "scrollY", "get").mockImplementation(() => {
    if (!reset) viewport.offsetTop = 24;
    return reset ? 404 : 0;
  });
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => { viewport.offsetTop = 24; });
  try {
    viewport.height = 430;
    viewport.offsetTop = 342;
    other.focus({ preventScroll: true });
    expect.soft(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("430px");
    expect.soft(view.shell.style.getPropertyValue("--pwa-viewport-top")).toBe("24px");
    expect.soft(Math.round(view.shell.getBoundingClientRect().top)).toBe(24);
    expect.soft(Math.round(view.shell.getBoundingClientRect().height)).toBe(470);
    expect.soft(scrollTo).toHaveBeenCalledTimes(reset ? 1 : 0);
    scrollY.mockReturnValue(0);
    viewport.change({ height: 420, offsetTop: -12 });
    expect(view.shell.style.getPropertyValue("--pwa-viewport-top")).toBe("0px");
    expect(Math.round(view.shell.getBoundingClientRect().top)).toBe(0);
  } finally {
    scrollY.mockRestore();
    scrollTo.mockRestore();
    other.remove();
    await view.screen.unmount();
  }
});

test("opening reuses one connected natural-height probe across events cycles and rotation", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  view.shell.style.setProperty("--pwa-duration-keyboard", "0ms");
  const create = vi.spyOn(document, "createElement");
  const mutations = new MutationObserver(() => {});
  mutations.observe(view.shell, { childList: true });
  const probes = () => create.mock.results.flatMap(result => {
    const node = result.type === "return" ? result.value : null;
    return node instanceof HTMLElement && node.style.height === "var(--pwa-app-height)" ? [node] : [];
  });
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    for (let index = 0; index < 5; index += 1) viewport.change({ height: 470 });
    const first = probes()[0];
    expect.soft(probes()).toHaveLength(1);
    expect.soft(first?.isConnected).toBe(true);
    expect.soft(first?.getAttribute("aria-hidden")).toBe("true");
    expect.soft(first?.inert).toBe(true);
    expect.soft(first?.style.top).toBe("0px");
    const records = mutations.takeRecords();
    expect.soft(records.flatMap(record => [...record.addedNodes]).filter(node => node === first)).toHaveLength(1);
    expect.soft(records.flatMap(record => [...record.removedNodes]).filter(node => node === first)).toHaveLength(0);
    view.input.blur();
    viewport.change({ height: 844 });
    await settle();
    expect.soft(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await page.viewport(844, 390);
    viewport.change({ height: 270 });
    await settle();
    expect.soft(Math.round(first?.getBoundingClientRect().height ?? 0)).toBe(390);
    viewport.change({ height: 390 });
    expect.soft(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect.soft(probes()).toHaveLength(1);
    expect.soft(first?.isConnected).toBe(true);
    expect.soft(Math.round(view.shell.getBoundingClientRect().height)).toBe(390);
    await view.screen.unmount();
    expect.soft(first?.parentElement).toBeNull();
  } finally {
    create.mockRestore();
    mutations.disconnect();
    if (view.shell.isConnected) await view.screen.unmount();
  }
});

test.each([false, true])("opening emits one geometry per synchronous motion sample across density thresholds: reading=%s", async reading => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const paragraph = view.screen.getByText(/^Answer 2, paragraph 3:/).element();
  if (reading) {
    view.list.scrollTop += offset(paragraph, view.list) - 2;
    view.list.dispatchEvent(new Event("scroll", { bubbles: true }));
    await settle();
  }
  view.input.focus({ preventScroll: true });
  viewport.change({ height: 470 });
  await settle();
  const anchor = Math.round(offset(paragraph, view.list));
  const batches: { count: number; compact: string | undefined; height: number }[] = [];
  let batch: typeof batches[number] | null = null;
  const geometry = () => {
    if (!batch) {
      batch = { count: 0, compact: view.shell.dataset.compactHeight, height: Math.round(view.shell.getBoundingClientRect().height) };
      batches.push(batch);
      queueMicrotask(() => { batch = null; });
    }
    batch.count += 1;
  };
  view.list.addEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
  const frames: { height: number; gap: number; anchor: number }[] = [];
  try {
    viewport.change({ height: 812 });
    const start = performance.now();
    do {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      frames.push({ height: Math.round(view.shell.getBoundingClientRect().height), gap: Math.round(bottomGap(view.list)),
        anchor: Math.round(offset(paragraph, view.list)) });
    } while (performance.now() - start < 400);
    expect.soft(batches.length).toBeGreaterThan(2);
    expect.soft(batches.some(value => value.height <= 600 && value.compact === "short")).toBe(true);
    expect.soft(batches.some(value => value.height > 600 && value.compact === undefined)).toBe(true);
    expect.soft(Math.max(...batches.map(value => value.count))).toBe(1);
    expect.soft(frames.some(value => value.height > 470 && value.height < 812)).toBe(true);
    if (reading) expect.soft(Math.max(...frames.map(value => Math.abs(value.anchor - anchor)))).toBeLessThanOrEqual(1);
    else expect.soft(Math.max(...frames.map(value => Math.abs(value.gap)))).toBeLessThanOrEqual(1);
    expect(view.timeline().followingOutput).toBe(!reading);
  } finally {
    view.list.removeEventListener(TIMELINE_GEOMETRY_EVENT, geometry);
    await view.screen.unmount();
  }
});

test("applies the actual viewport and compact padding together without a delayed 96px content change", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const geometry = () => {
    const style = getComputedStyle(view.list);
    return {
      height: Math.round(view.shell.getBoundingClientRect().height), compact: view.shell.dataset.compactHeight ?? null,
      paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom), scrollHeight: view.list.scrollHeight,
    };
  };
  try {
    const before = geometry();
    expect([before.paddingTop, before.paddingBottom]).toEqual([24, 88]);
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    const first = geometry();
    // 固定消息且不发送；跨过旧250ms动画+32ms收尾，再模拟迟到的viewport scroll通知。
    await new Promise(resolve => setTimeout(resolve, 350));
    viewport.change({}, "scroll");
    await settle();
    const last = geometry();
    expect(last).toEqual({ height: 470, compact: "short", paddingTop: 8, paddingBottom: 8, scrollHeight: before.scrollHeight - 96 });
    expect(first).toEqual(last);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally {
    await view.screen.unmount();
  }
});

test("keeps the actual occluded viewport after blur and a long task until the viewport recovers", async () => {
  await page.viewport(390, 844);
  document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const height = () => Math.round(view.shell.getBoundingClientRect().height);
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await expect.poll(height).toBe(470);
    view.input.blur();
    void getComputedStyle(view.shell).height;
    const taskEnd = performance.now() + 50;
    while (performance.now() < taskEnd) { /* 模拟发送时的长任务，不能把失焦当成视口已经恢复。 */ }
    await settle();
    // 没有新的viewport事件时也不能被旧计时器解除补偿。
    await new Promise(resolve => setTimeout(resolve, 350));
    expect.soft(height()).toBe(470);
    expect.soft(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect.soft(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(true);
    expect.soft(parseFloat(getComputedStyle(composer).paddingBottom)).toBe(8);
    viewport.change({ height: 620, offsetTop: 8 });
    expect.soft(height()).toBe(470);
    await expect.poll(height).toBe(620);
    expect.soft(Math.round(view.shell.getBoundingClientRect().top)).toBe(8);
    expect.soft(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("844px");
    viewport.change({ height: 844, offsetTop: 0 });
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(height()).toBe(844);
    expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
    expect(parseFloat(getComputedStyle(composer).paddingBottom)).toBe(34);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    await view.screen.unmount();
  }
});

test("does not release at the layout height while the unobscured app viewport is taller", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  // standalone 初始包含块比 100lvh 短；退出不能把 clientHeight 当成完整可视高度。
  const layoutHeight = vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(812);
  const view = await renderWorkspace();
  const height = () => Math.round(view.shell.getBoundingClientRect().height);
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    view.input.blur();
    viewport.change({ height: 812 });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect.soft(height()).toBe(812);
    expect.soft(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect.soft(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(true);
    viewport.change({ height: 874 });
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(height()).toBe(874);
  } finally {
    layoutHeight.mockRestore();
    await view.screen.unmount();
  }
});

test("hands document height back on real growth without releasing a partial shell or re-locking on settle", async () => {
  await page.viewport(402, 874);
  document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const root = document.documentElement;
  const box = (element: Element) => Math.round(element.getBoundingClientRect().height);
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    // 仍聚焦时隐藏键盘也须交接；不依赖blur或clientHeight等于VV。
    viewport.change({ height: 812 });
    expect.soft(box(root)).toBe(874);
    expect.soft(box(document.body)).toBe(874);
    expect.soft(box(view.shell)).toBe(470);
    await new Promise(resolve => setTimeout(resolve, 350));
    viewport.change({}, "scroll");
    await settle();
    expect.soft(box(root)).toBe(874);
    expect.soft(root.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("874px");
    expect.soft(box(view.shell)).toBe(812);
    expect.soft(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect.soft(view.shell.hasAttribute("data-keyboard-restored")).toBe(false);
    expect.soft(parseFloat(getComputedStyle(document.querySelector(".pwa-composer")!).paddingBottom)).toBe(8);
    viewport.change({ height: 500 });
    expect.soft(box(root)).toBe(500);
    expect.soft(box(view.shell)).toBe(500);
    viewport.change({ height: 874 });
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(root.hasAttribute("data-pwa-keyboard")).toBe(false);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    await view.screen.unmount();
  }
});

test.each([[false, 812], [true, 812], [false, 601]] as const)("closes padding within the size handoff without an endpoint content step: reading=%s target=%s", async (reading, target) => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const paragraph = view.screen.getByText(/^Answer 2, paragraph 3:/).element();
  try {
    if (reading) {
      view.list.scrollTop += offset(paragraph, view.list) - 2;
      view.list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await settle();
    }
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    const initialAnchor = Math.round(offset(paragraph, view.list));
    view.input.blur();
    viewport.change({ height: target });
    const frames = [];
    const start = performance.now();
    do {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const style = getComputedStyle(view.list);
      frames.push({ height: Math.round(view.shell.getBoundingClientRect().height),
        padding: Math.round(parseFloat(style.paddingBottom)), scrollHeight: view.list.scrollHeight,
        paragraph: Math.round(offset(paragraph, view.list)), gap: Math.round(bottomGap(view.list)) });
    } while (performance.now() - start < 400);
    expect.soft(frames.some(frame => frame.height < target && frame.padding > 8 && frame.padding < 88)).toBe(true);
    const endpoints = frames.filter(frame => frame.height === target);
    expect.soft(endpoints.length).toBeGreaterThan(1);
    // 固定消息：shell已到终点后不得再增加96px内容或把正文向上搬80px。
    expect.soft(Math.max(...endpoints.map(frame => frame.scrollHeight)) - Math.min(...endpoints.map(frame => frame.scrollHeight))).toBeLessThanOrEqual(1);
    expect.soft(Math.max(...endpoints.map(frame => frame.paragraph)) - Math.min(...endpoints.map(frame => frame.paragraph))).toBeLessThanOrEqual(1);
    if (reading) expect.soft(Math.max(...frames.map(frame => Math.abs(frame.paragraph - initialAnchor)))).toBeLessThanOrEqual(1);
    else expect.soft(Math.max(...frames.map(frame => Math.abs(frame.gap)))).toBeLessThanOrEqual(1);
    expect(getComputedStyle(view.list).paddingBottom).toBe("88px");
    expect(view.timeline().followingOutput).toBe(!reading);
  } finally { await view.screen.unmount(); }
});

test("keeps constrained input budgets while closing and hands layout padding to the existing activity owner", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace("Draft line\n".repeat(8));
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 310 });
    await settle();
    expect(document.querySelector("[data-composer-budget]")).not.toBeNull();
    viewport.change({ height: 812 });
    await settle();
    // 临时补偿inline padding不能被CSS再次动画；自然scroll避让与自然padding共用插值。
    view.list.style.paddingBottom = "120px";
    expect(getComputedStyle(view.list).paddingBottom).toBe("120px");
    view.list.style.paddingBottom = "";
    const start = performance.now();
    while (performance.now() - start < 350) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const style = getComputedStyle(view.list);
      expect.soft(Math.round(parseFloat(style.scrollPaddingBottom))).toBe(Math.round(parseFloat(style.paddingBottom)));
      expect.soft(Math.round(view.input.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      expect.soft(view.list.clientHeight).toBeGreaterThanOrEqual(40);
    }
    expect(getComputedStyle(view.list).paddingBottom).toBe("88px");
    expect(Math.abs(view.input.getBoundingClientRect().height - sixLineHeight(view.input))).toBeLessThan(1);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally { await view.screen.unmount(); }
});

test("records blur intent without moving early and discards stale intent before a delayed recovery", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const height = () => Math.round(view.shell.getBoundingClientRect().height);
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    view.input.blur();
    await settle();
    expect(height()).toBe(470);
    expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("470px");
    viewport.change({ height: 812 });
    const taskEnd = performance.now() + 50;
    while (performance.now() < taskEnd) { void getComputedStyle(view.shell).height; }
    expect(height()).toBe(470);
    await settle();
    const duration = parseFloat(getComputedStyle(view.shell).transitionDuration) * 1000;
    expect(duration).toBeGreaterThanOrEqual(125);
    expect(duration).toBeLessThan(250);
    await expect.poll(height).toBe(812);
    // 新焦点清理上一轮意图；长时间失焦不能让首次真实增长直接耗尽预算。
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    view.input.blur();
    await new Promise(resolve => setTimeout(resolve, 400));
    viewport.change({ height: 874 });
    expect(height()).toBe(470);
    await settle();
    expect(parseFloat(getComputedStyle(view.shell).transitionDuration) * 1000).toBe(250);
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  } finally { await view.screen.unmount(); }
});

test("redirects closing from its displayed height with a bounded remaining duration", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    viewport.change({ height: 812 });
    await settle();
    const before = view.shell.getBoundingClientRect().height;
    viewport.change({ height: 874 });
    expect(Math.abs(view.shell.getBoundingClientRect().height - before)).toBeLessThanOrEqual(1);
    const duration = parseFloat(getComputedStyle(view.shell).transitionDuration) * 1000;
    expect.soft(duration).toBeLessThan(250);
    expect.soft(duration).toBeGreaterThanOrEqual(125);
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally { await view.screen.unmount(); }
});

test("keeps the rendered starting height when the viewport reports the closing endpoint early", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const height = () => Math.round(view.shell.getBoundingClientRect().height);
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    view.input.blur();
    viewport.change({ height: 874 });
    // 事件当前任务不得从470瞬跳到874；真实键盘退场仍须录屏验收，不能由这个mock证明。
    expect.soft(height()).toBe(470);
    expect.soft(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect.soft(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(true);
    await settle();
    expect.soft(view.shell.hasAttribute("data-keyboard-closing")).toBe(true);
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(height()).toBe(874);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally {
    await view.screen.unmount();
  }
});

test("retains compensation across text focus transfers, rapid reopening and repeated viewport events", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const other = document.createElement("textarea");
  other.style.position = "fixed";
  document.body.append(other);
  const geometry = () => [Math.round(view.shell.getBoundingClientRect().height), Math.round(view.shell.getBoundingClientRect().top)];
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    other.focus({ preventScroll: true });
    await settle();
    expect(geometry()).toEqual([470, 0]);
    other.blur();
    await settle();
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 430, offsetTop: 12 });
    expect(geometry()).toEqual([430, 12]);
    expect(view.shell.dataset.compactHeight).toBe("very-short");
    for (let count = 0; count < 5; count += 1) {
      viewport.change({ height: 430 });
      viewport.change({ offsetTop: 12 }, "scroll");
    }
    await settle();
    expect(geometry()).toEqual([430, 12]);
    view.input.blur();
    viewport.change({ height: 844, offsetTop: 0 });
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    other.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    expect(geometry()).toEqual([470, 0]);
    expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("470px");
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally {
    other.remove();
    await view.screen.unmount();
  }
});

test.each([false, true])("cancels pending or active closing on refocus without a stale release: active=%s", async active => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    view.input.blur();
    viewport.change({ height: 844 });
    if (active) await settle();
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 430 });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(430);
    expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(false);
    expect(view.shell.hasAttribute("data-keyboard-restored")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("430px");
  } finally { await view.screen.unmount(); }
});

test("finishes closing despite duplicate events and non-text focus, including a seconds duration", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace("Send");
  view.shell.style.setProperty("--pwa-duration-keyboard", "0.25s");
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    // 隐藏系统键盘不一定使文本框失焦，仍须走收起保护。
    viewport.change({ height: 844 });
    await settle();
    expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(true);
    (view.screen.getByRole("button", { name: "Send message", exact: true }).element() as HTMLElement).focus();
    expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(true);
    const start = performance.now();
    while (performance.now() - start < 400) {
      viewport.change({ height: 844 });
      viewport.change({}, "scroll");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  } finally { await view.screen.unmount(); }
});

test("cancels closing when the keyboard grows again without a new focus event", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    viewport.change({ height: 844 });
    await settle();
    viewport.change({ height: 430 });
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(430);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(false);
  } finally { await view.screen.unmount(); }
});

test("uses the rotated app height rather than the old portrait endpoint", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    viewport.change({ height: 844 });
    await settle();
    await page.viewport(844, 390);
    viewport.change({ height: 270 });
    await settle();
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(270);
    viewport.change({ height: 390 });
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(390);
  } finally { await view.screen.unmount(); }
});

test("zero-duration closing still waits for the full unobscured viewport", async () => {
  await page.viewport(402, 874);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const layoutHeight = vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(812);
  const view = await renderWorkspace();
  // 模拟 reduced-motion 的时长token；普通用例仍运行真实250ms过渡。
  view.shell.style.setProperty("--pwa-duration-keyboard", "0ms");
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    view.input.blur();
    viewport.change({ height: 812 });
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(812);
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("874px");
    viewport.change({ height: 874 });
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  } finally { layoutHeight.mockRestore(); await view.screen.unmount(); }
});

test("uses the production reduced-motion rules without a closing size transition", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  try {
    expect(getComputedStyle(view.shell).getPropertyValue("--pwa-duration-keyboard").trim()).toBe("0ms");
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    view.input.blur();
    viewport.change({ height: 620 });
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(620);
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    expect(view.shell.getAnimations()).toHaveLength(0);
    expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("844px");
    viewport.change({ height: 844 });
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(view.shell.getAnimations()).toHaveLength(0);
  } finally { await view.screen.unmount(); }
});

test("keeps accepted-send input contraction independent from closing and releases both layout owners", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace("Draft line\n".repeat(8), true);
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    await settle();
    view.input.blur();
    view.input.form!.requestSubmit();
    viewport.change({ height: 844 });
    // 强制样式计算并阻塞当前任务，收起保护仍须从下一绘制帧开始。
    const taskEnd = performance.now() + 50;
    while (performance.now() < taskEnd) { void getComputedStyle(view.shell).height; }
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(470);
    await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    await settle();
    expect(view.input.value).toBe("");
    expect(Math.round(view.input.getBoundingClientRect().height)).toBe(44);
    expect(document.querySelector<HTMLElement>(".pwa-chat-footer")!.style.height).toBe("");
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
    expect(view.timeline().followingOutput).toBe(true);
  } finally { await view.screen.unmount(); }
});

test.each([false, true])("cleans a pending or active closing and its callbacks on unmount: active=%s", async active => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  view.input.focus({ preventScroll: true });
  viewport.change({ height: 470 });
  await settle();
  view.input.blur();
  viewport.change({ height: 844 });
  if (active) await settle();
  await view.screen.unmount();
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(false);
  expect(view.shell.hasAttribute("data-keyboard-restored")).toBe(false);
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(view.shell.hasAttribute("data-compact-height")).toBe(false);
  expect(view.shell.style.getPropertyValue("--pwa-viewport-height")).toBe("");
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
});

test.each([{ scale: 2 }, { height: 0 }])("releases active compensation for zoom or an unusable viewport: %j", async values => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  try {
    view.input.focus({ preventScroll: true });
    viewport.change({ height: 470 });
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(true);
    viewport.change({ height: 844 });
    await settle();
    expect(view.shell.hasAttribute("data-keyboard-closing")).toBe(true);
    viewport.change(values);
    expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
    expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(844);
    expect(view.shell.getAnimations()).toHaveLength(0);
    viewport.change({ scale: 1, height: 470 });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(Math.round(view.shell.getBoundingClientRect().height)).toBe(470);
  } finally {
    await view.screen.unmount();
  }
});

test("cancels a pending viewport frame and releases document state on unmount", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  view.input.focus({ preventScroll: true });
  viewport.change({ height: 470 });
  viewport.change({ offsetTop: 12 }, "scroll");
  await view.screen.unmount();
  viewport.change({ height: 390 });
  document.dispatchEvent(new FocusEvent("focusin"));
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(view.shell.hasAttribute("data-compact-height")).toBe(false);
  expect(view.shell.style.getPropertyValue("--pwa-viewport-height")).toBe("");
  expect(view.shell.style.getPropertyValue("--pwa-viewport-top")).toBe("");
  expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--pwa-keyboard-document-height")).toBe("");
});

test("keeps a real timeline paragraph anchored through keyboard, draft and rotation changes", async () => {
  await page.viewport(390, 844);
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  const paragraph = view.screen.getByText(/^Answer 2, paragraph 3:/).element();
  view.list.scrollTop += offset(paragraph, view.list) - 2;
  view.list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await settle();
  expect(view.timeline().followingOutput).toBe(false);
  const initial = offset(paragraph, view.list);
  view.input.focus({ preventScroll: true });
  viewport.change({ height: 330 });
  await settle();
  await view.draft("Large draft\n".repeat(10));
  expect(Math.abs(offset(paragraph, view.list) - initial)).toBeLessThanOrEqual(1);
  await page.viewport(844, 390);
  viewport.change({ height: 270 });
  await settle();
  expect(Math.abs(offset(paragraph, view.list) - initial)).toBeLessThanOrEqual(1);
  expect(view.timeline().followingOutput).toBe(false);
  view.input.blur();
  viewport.change({ height: 390 });
  await expect.poll(() => view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  await settle();
  expect(Math.abs(offset(paragraph, view.list) - initial)).toBeLessThanOrEqual(1);
  expect(view.timeline().followingOutput).toBe(false);
  await view.screen.unmount();
  expect(view.shell.style.getPropertyValue("--pwa-viewport-height")).toBe("");
});

test("ignores non-input viewport changes, zoom and already-resized layout viewports", async () => {
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const view = await renderWorkspace();
  viewport.change({ height: 840 });
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  view.input.focus({ preventScroll: true });
  viewport.change({ height: 450, scale: 2 });
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  await page.viewport(1280, 500);
  viewport.change({ height: 500, scale: 1 });
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(view.shell.getBoundingClientRect().height).toBe(500);
  await view.screen.unmount();
});

test("falls back to dynamic viewport CSS without visualViewport", async () => {
  vi.stubGlobal("visualViewport", undefined);
  const view = await renderWorkspace();
  view.input.focus({ preventScroll: true });
  await page.viewport(390, 500);
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(view.shell.getBoundingClientRect().height).toBe(500);
  await view.screen.unmount();
});

test("grows the single-line Composer input with the extra-large text size", async () => {
  setTextSize("xlarge");
  const view = await renderWorkspace();
  const style = getComputedStyle(view.input);
  const minimum = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  expect(minimum).toBeGreaterThan(44);
  expect(view.input.getBoundingClientRect().height).toBeGreaterThanOrEqual(minimum - 0.5);
  await view.screen.unmount();
});
