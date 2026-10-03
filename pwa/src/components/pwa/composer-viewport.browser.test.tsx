import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
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

afterEach(async () => { vi.unstubAllGlobals(); await page.viewport(1280, 900); });

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
  await settle();
  expect(view.shell.hasAttribute("data-keyboard-viewport")).toBe(false);
  expect(view.shell.getBoundingClientRect().height).toBe(height);
  expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  await view.screen.unmount();
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
