import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { setLanguagePreference } from "@/lib/i18n";
import { getLanguageState } from "@/lib/i18n/locale";
import type { ThinkingEntry } from "@/lib/pwa/timeline-presentation";
import type { ProcessStatus } from "./process-group-state";
import { ThinkingProcessRow } from "./thinking-process-row";
import "./process-group.css";

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

const entryOf = (text: string, streaming: boolean): ThinkingEntry => ({ kind: "thinking", key: "thinking", groupId: "group", text, streaming });

async function harness(initial: { status: ProcessStatus; text?: string; streaming?: boolean }) {
  let update!: (status: ProcessStatus, text?: string) => void;
  function Harness() {
    const [state, setState] = useState({ status: initial.status, text: initial.text ?? "**Stable title**\nReasoning." });
    update = (status, text = state.text) => flushSync(() => setState({ status, text }));
    // 明细行只在过程组内出现；容器提供与生产相同的样式作用域。
    return <article className="pwa-process-group"><ThinkingProcessRow entry={entryOf(state.text, initial.streaming ?? true)} status={state.status} onRead={() => {}} /></article>;
  }
  await renderPwa(<Harness />);
  const row = document.querySelector<HTMLElement>(".pwa-thinking-process-row")!;
  const slot = () => row.querySelector<HTMLElement>(".pwa-process-status-slot")!;
  const title = () => row.querySelector<HTMLElement>(".pwa-process-thinking-heading")!;
  const offset = () => Math.round(title().getBoundingClientRect().left - row.getBoundingClientRect().left);
  // 只看有限的呈现动画；运行图标自身的无限动画不属于槽位或标题位移。
  const motions = () => row.getAnimations({ subtree: true }).filter(animation =>
    Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity));
  return { update, row, slot, title, offset, motions };
}

const cases = [1280, 390].flatMap(width => ["no-preference", "reduce"].map(motion => ({ width, motion })));
test.each(cases)("thinking keeps a fixed status slot and never slides its title at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const view = await harness({ status: "neutral", streaming: false });
  const resting = view.offset();
  const slotWidth = Math.round(view.slot().getBoundingClientRect().width);
  expect(slotWidth).toBe(16);
  expect(resting).toBeGreaterThan(slotWidth);
  view.update("running");
  expect(view.offset()).toBe(resting);
  expect(Math.round(view.slot().getBoundingClientRect().width)).toBe(slotWidth);
  expect(view.motions()).toHaveLength(0);
  // 新的完整标题原位替换，不重播入场。
  view.update("running", "**Stable title**\nReasoning continues.\n**New title**");
  await expect.poll(() => view.title().textContent).toBe("New title");
  expect(view.offset()).toBe(resting);
  expect(view.motions()).toHaveLength(0);
  view.update("neutral");
  expect(view.offset()).toBe(resting);
  expect(Math.round(view.slot().getBoundingClientRect().width)).toBe(slotWidth);
  expect(view.motions()).toHaveLength(0);
});

test("thinking placeholders stay English in a Chinese interface without translating the model heading", async () => {
  const previous = getLanguageState().preference;
  setLanguagePreference("zh");
  try {
    const live = await harness({ status: "running", text: "" });
    expect(live.title().textContent).toBe("Thinking…");
    live.update("running", "模型原始思考第 1 行\n模型原始思考第 2 行");
    await expect.poll(() => live.title().textContent).toBe("模型原始思考第 1 行");
    live.update("unknown", "");
    expect(live.title().textContent).toBe("Thinking");
  } finally { setLanguagePreference(previous); }
});

test("a newly mounted live row starts at its resting position and quick state reversals do not move it", async () => {
  const view = await harness({ status: "running" });
  const resting = view.offset();
  expect(view.motions()).toHaveLength(0);
  view.update("neutral");
  view.update("running");
  view.update("neutral");
  expect(view.offset()).toBe(resting);
  expect(view.motions()).toHaveLength(0);
});
