import { useState } from "react";
import { finishCssTransitions } from "@/test/browser/motion";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useTimelineViewport, type TimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import { activityFollowSpace } from "@/lib/pwa/timeline-follow-motion";
import { resetTextSizeStateForTest, setTextSize, TEXT_SIZE_STORAGE_KEY } from "@/lib/ui/text-size";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageComposer } from "./message-composer";
import type { ComposerAttachmentItem } from "./attachment-cards";
import { MessageList } from "./message-list";
import { PwaAppShell } from "./pwa-app-shell";
import { PwaUiProvider } from "./pwa-ui-provider";
import { applyStandaloneRules } from "@/test/browser/standalone";

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
    // 附件行的高度随进出过渡，等过渡结束再断言稳定布局。
    attachment: async (value: ComposerAttachmentItem | null) => {
      flushSync(() => changeAttachment(value));
      await settle();
      await finishCssTransitions();
      await settle();
    },
    /** 只提交、不等待过渡，供逐帧采样。 */
    setAttachment: (value: ComposerAttachmentItem | null) => { flushSync(() => changeAttachment(value)); },
  };
}

const sixLineHeight = (input: HTMLElement) => {
  const style = getComputedStyle(input);
  return 6 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
};
const bottomGap = (list: HTMLElement) => list.scrollHeight - list.clientHeight - list.scrollTop;
const draftAttachment: ComposerAttachmentItem = { id: "attachment", fileName: "Attachment", byteLength: 1024, status: "draft" };
/** 附件行进出的过渡时长（collapse-in 400ms）加余量；采样窗口只覆盖一次过渡。 */
const GROW_SAMPLE_MS = 520;
async function sampleFrames(sample: () => void) {
  const start = performance.now();
  while (performance.now() - start < GROW_SAMPLE_MS) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    sample();
  }
}
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

test("keeps the mobile Composer clear of the home indicator in a standalone app without a reported safe area", async () => {
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  const bottom = () => getComputedStyle(composer).paddingBottom;
  // 浏览器标签页沿用 16；主屏 PWA 不设 viewport-fit=cover，系统不报告底部安全区，移动布局下限为 24。
  expect(bottom()).toBe("16px");
  const standalone = applyStandaloneRules();
  try {
    expect(bottom()).toBe("24px");
    // 系统报告的安全区更大时仍取安全区，不叠加。
    document.documentElement.style.setProperty("--pwa-safe-bottom", "34px");
    expect(bottom()).toBe("34px");
    document.documentElement.style.removeProperty("--pwa-safe-bottom");
    // 桌面布局不变。
    await page.viewport(1280, 844);
    await expect.poll(bottom).toBe("16px");
  } finally {
    standalone.remove();
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

test("floats the Composer over the list: the list keeps its height and its bottom padding follows the footer", async () => {
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
  const sentinel = document.querySelector<HTMLElement>(".pwa-bottom-sentinel")!;
  const listHeight = Math.round(view.list.clientHeight);
  const padding = () => Math.round(parseFloat(getComputedStyle(view.list).paddingBottom));
  const check = (label: string) => {
    // 列表高度不随输入区变化；底部留白 = 尾部留白 88 + 输入区高度；跟随时最新内容停在输入区上沿之上。
    expect(Math.round(view.list.clientHeight), label).toBe(listHeight);
    expect(padding(), label).toBe(88 + Math.round(footer.getBoundingClientRect().height));
    // 自然尾部留白的测量依赖滚动避让与底部留白同值。
    expect(Math.round(parseFloat(getComputedStyle(view.list).scrollPaddingBottom)), label).toBe(padding());
    expect(bottomGap(view.list), label).toBeLessThanOrEqual(1);
    expect(Math.round(sentinel.getBoundingClientRect().bottom), label).toBeLessThanOrEqual(Math.round(footer.getBoundingClientRect().top));
    // 被输入区盖住的留白不能用来容纳内容增长。
    expect(activityFollowSpace(view.list as HTMLDivElement).tailSpace, label).toBe(80);
  };
  check("empty");
  await view.attachment({ id: "attachment", fileName: "Attachment", byteLength: 1024, status: "draft" });
  check("attachment");
  await view.draft("Line\n".repeat(5));
  check("draft");
  await view.attachment(null);
  await view.draft("");
  check("restored");
  await view.screen.unmount();
});

test("keeps the reading position while the floating Composer grows over the list", async () => {
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const paragraph = view.screen.getByText(/^Answer 3, paragraph 9:/).element();
  view.list.scrollTop += offset(paragraph, view.list) - 120;
  view.list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await settle();
  expect(view.timeline().followingOutput).toBe(false);
  const initial = { offset: Math.round(offset(paragraph, view.list)), top: Math.round(view.list.scrollTop) };
  await view.attachment({ id: "attachment", fileName: "Attachment", byteLength: 1024, status: "draft" });
  await view.draft("Line\n".repeat(5));
  // 回看时输入区增高只盖住列表底部，正在读的内容与滚动位置都不动。
  expect(Math.round(offset(paragraph, view.list))).toBe(initial.offset);
  expect(Math.round(view.list.scrollTop)).toBe(initial.top);
  expect(view.timeline().followingOutput).toBe(false);
  await view.screen.unmount();
});

test("grows and shrinks the attachment row smoothly while following, keeping the latest content above the Composer", async () => {
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
  const sentinel = document.querySelector<HTMLElement>(".pwa-bottom-sentinel")!;
  const footerHeight = () => Math.round(footer.getBoundingClientRect().height);
  const run = async (value: ComposerAttachmentItem | null) => {
    const heights: number[] = [];
    let covered = 0;
    view.setAttachment(value);
    await sampleFrames(() => {
      heights.push(footerHeight());
      // 输入区浮在列表之上：跟随时最新内容每一帧都停在输入区上沿以上。
      if (Math.round(sentinel.getBoundingClientRect().bottom) > Math.round(footer.getBoundingClientRect().top)) covered += 1;
    });
    return { heights, covered };
  };
  const collapsed = footerHeight();
  const grow = await run(draftAttachment);
  const expanded = grow.heights.at(-1)!;
  expect(expanded).toBeGreaterThan(collapsed + 40);
  // 高度经过中间值逐帧增长，而不是一次到位。
  expect(grow.heights.some(height => height > collapsed + 2 && height < expanded - 2)).toBe(true);
  expect(grow.covered).toBe(0);
  expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  const shrink = await run(null);
  expect(shrink.heights.at(-1)).toBe(collapsed);
  expect(shrink.heights.some(height => height > collapsed + 2 && height < expanded - 2)).toBe(true);
  expect(shrink.covered).toBe(0);
  expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  expect(view.timeline().followingOutput).toBe(true);
  await view.screen.unmount();
});

test("keeps the reading position on every frame while the attachment row grows over the list", async () => {
  await page.viewport(390, 844);
  const view = await renderWorkspace();
  const paragraph = view.screen.getByText(/^Answer 3, paragraph 9:/).element();
  view.list.scrollTop += offset(paragraph, view.list) - 120;
  view.list.dispatchEvent(new Event("scroll", { bubbles: true }));
  await settle();
  expect(view.timeline().followingOutput).toBe(false);
  const initial = Math.round(offset(paragraph, view.list));
  const moved: number[] = [];
  view.setAttachment(draftAttachment);
  await sampleFrames(() => {
    const current = Math.round(offset(paragraph, view.list));
    if (current !== initial) moved.push(current);
  });
  expect(moved).toEqual([]);
  expect(view.timeline().followingOutput).toBe(false);
  await view.screen.unmount();
});

test("changes the attachment row height at once with reduced motion", async () => {
  await page.viewport(390, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const view = await renderWorkspace();
  try {
    const footer = document.querySelector<HTMLElement>(".pwa-chat-footer")!;
    const slot = () => document.querySelector<HTMLElement>(".pwa-attachment-tiles-slot");
    view.setAttachment(draftAttachment);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    // 减少动态效果只保留透明度淡化，尺寸不过渡。
    expect(getComputedStyle(slot()!).transitionProperty).not.toContain("grid-template-rows");
    const expanded = Math.round(footer.getBoundingClientRect().height);
    await settle();
    expect(Math.round(footer.getBoundingClientRect().height)).toBe(expanded);
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
    await view.screen.unmount();
  }
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

test("keeps the mobile Composer bottom gap on focus without a touch screen", async () => {
  // 窄桌面窗口聚焦时没有软键盘，留白保持不变。
  await page.viewport(390, 844);
  await expect.poll(() => matchMedia("(any-pointer: coarse), (hover: none)").matches).toBe(false);
  const view = await renderWorkspace();
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  try {
    view.input.focus({ preventScroll: true });
    await finishCssTransitions();
    expect(getComputedStyle(composer).paddingBottom).toBe("16px");
  } finally {
    await view.screen.unmount();
  }
});

// Linux 无头 Chromium 关闭触控模拟后无法恢复 pointer／hover 媒体特性，触控用例放在文件末尾，避免影响其他用例。
test("drops the mobile Composer bottom gap while the input is focused on a touch device", async () => {
  await page.viewport(390, 844);
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await expect.poll(() => matchMedia("(any-pointer: coarse)").matches).toBe(true);
  const view = await renderWorkspace();
  const composer = document.querySelector<HTMLElement>(".pwa-composer")!;
  const bottom = () => getComputedStyle(composer).paddingBottom;
  const seconds = (token: string) => `${parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) / 1000}s`;
  const standalone = applyStandaloneRules();
  try {
    // 触屏移动布局的留白带过渡，切到主屏 PWA 的 24 也要等过渡结束。
    await finishCssTransitions();
    expect(bottom()).toBe("24px");
    const card = composer.querySelector<HTMLElement>(".pwa-composer-card")!;
    const shadow = () => getComputedStyle(card).boxShadow;
    const fullShadow = shadow();
    // 软键盘与辅助栏贴住底边，聚焦期间不再为 Home 指示条留白；收起按输入区内增减的高度过渡，
    // 并等 iOS 整页上推基本结束（延迟 collapse-out）再开始，收起键盘时不延迟。
    view.input.focus({ preventScroll: true });
    expect(getComputedStyle(composer).transitionProperty).toBe("padding-bottom");
    expect(getComputedStyle(composer).transitionDuration).toBe(seconds("--pwa-duration-collapse-in"));
    expect(getComputedStyle(composer).transitionDelay).toBe(seconds("--pwa-duration-collapse-out"));
    expect(getComputedStyle(card).transitionDelay).toBe(`0s, ${seconds("--pwa-duration-collapse-out")}`);
    await finishCssTransitions();
    expect(bottom()).toBe("0px");
    // 卡片底边即可见区域底边，投影会被截断，只留接触层。
    expect(shadow()).not.toBe(fullShadow);
    expect(shadow()).toBe("rgba(0, 0, 0, 0.12) 0px 1px 2px 0px");
    await settle();
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
    view.input.blur();
    expect(getComputedStyle(composer).transitionDuration).toBe(seconds("--pwa-duration-collapse-out"));
    expect(getComputedStyle(composer).transitionDelay).toBe("0s");
    await finishCssTransitions();
    expect(bottom()).toBe("24px");
    expect(shadow()).toBe(fullShadow);
    await settle();
    expect(bottomGap(view.list)).toBeLessThanOrEqual(1);
    // 桌面布局不受影响。
    await page.viewport(1280, 844);
    view.input.focus({ preventScroll: true });
    await expect.poll(bottom).toBe("16px");
    view.input.blur();
  } finally {
    standalone.remove();
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await view.screen.unmount();
  }
});
