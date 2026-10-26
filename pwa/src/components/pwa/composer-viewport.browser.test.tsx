import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { resetTextSizeStateForTest, setTextSize, TEXT_SIZE_STORAGE_KEY } from "@/lib/ui/text-size";
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

async function renderWorkspace(initialDraft = "") {
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
            draft={draft} onDraftChange={setDraft} onSend={() => {}} onStop={() => {}} onAddFiles={() => {}} onRemoveAttachment={() => setAttachment(null)} onRetryAttachment={() => {}}
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

test.each([[390, 844, 310], [844, 390, 260], [768, 1024, 440]])("leaves a visual-viewport-only keyboard to the browser at %ix%i", async (width, height, keyboardHeight) => {
  await page.viewport(width, height);
  // 无头 Chromium 的 env(safe-area-inset-bottom) 恒为 0，用根节点变量模拟 Home 指示条安全区。
  document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
  const viewport = new ViewportMock();
  vi.stubGlobal("visualViewport", viewport);
  const scrollTo = vi.spyOn(window, "scrollTo");
  const view = await renderWorkspace("Draft line\n".repeat(8));
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  try {
    const before = { rect: view.shell.getBoundingClientRect().toJSON(), compact: view.shell.dataset.compactHeight, padding: getComputedStyle(composer).paddingBottom };
    view.input.focus({ preventScroll: true });
    viewport.change({ height: keyboardHeight, offsetTop: 12 });
    viewport.change({ offsetTop: 24 }, "scroll");
    await settle();
    // 原生方案：外壳、密度、安全区与窗口滚动都不因键盘改变，位移由浏览器负责。
    expect(view.shell.getBoundingClientRect().toJSON()).toEqual(before.rect);
    expect(view.shell.dataset.compactHeight).toBe(before.compact);
    expect(getComputedStyle(composer).paddingBottom).toBe(before.padding);
    expect(view.shell.getAttribute("style")).toBeNull();
    expect(document.documentElement.hasAttribute("data-pwa-keyboard")).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
    view.input.blur();
    viewport.change({ height, offsetTop: 0 });
    await settle();
    expect(view.shell.getBoundingClientRect().toJSON()).toEqual(before.rect);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally {
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    await view.screen.unmount();
  }
});

test("applies short-window density from the real shell size and keeps following output", async () => {
  vi.stubGlobal("visualViewport", undefined);
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const density = () => [view.shell.dataset.compactHeight ?? null, view.shell.hasAttribute("data-wide-compact")];
  expect(density()).toEqual([null, false]);
  for (const [width, height, expected] of [[390, 500, ["short", false]], [390, 420, ["very-short", false]], [844, 420, ["very-short", true]], [390, 844, [null, false]]] as const) {
    await page.viewport(width, height);
    await settle();
    expect(density(), `${width}x${height}`).toEqual(expected);
    expect(view.shell.getBoundingClientRect().height).toBe(height);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  }
  await view.screen.unmount();
  expect(density()).toEqual([null, false]);
});

test("keeps a real timeline paragraph anchored through draft and rotation changes", async () => {
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const paragraph = view.screen.getByText(/^Answer 2, paragraph 3:/).element();
  view.list.scrollTop += offset(paragraph, view.list) - 2;
  view.list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await settle();
  expect(view.timeline().followingOutput).toBe(false);
  const initial = offset(paragraph, view.list);
  view.input.focus({ preventScroll: true });
  await view.draft("Large draft\n".repeat(10));
  expect(Math.abs(offset(paragraph, view.list) - initial)).toBeLessThanOrEqual(1);
  await page.viewport(844, 390);
  await settle();
  expect(Math.abs(offset(paragraph, view.list) - initial)).toBeLessThanOrEqual(1);
  expect(view.timeline().followingOutput).toBe(false);
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
