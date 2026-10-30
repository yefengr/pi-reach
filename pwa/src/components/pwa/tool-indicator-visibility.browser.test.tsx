import { useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

const scope = { session_id: "session", leaf_id: "leaf", group_id: "run" };
function running(id: string): TimelineViewItem {
  const partial: TimelinePartial = { ...scope, protocol_version: 2, type: "timeline_partial", kind: "tool", partial_id: `tool:${id}`, tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "running" };
  return { kind: "partial", createdAt: 0, partial };
}
function completed(id: string): TimelineViewItem {
  const event: TimelineEvent = { ...scope, event_id: `event:${id}`, timestamp: 1, kind: "tool", tool_call_id: id, tool: "read", args: { path: `${id}.ts` }, status: "complete", truncated: false, result: "ok" };
  return { kind: "event", event };
}

const head = () => document.querySelector<HTMLButtonElement>("button.pwa-process-head")!;
const headIcon = () => head().querySelector<SVGSVGElement>(".pwa-process-status-slot > svg");
/** Working 只在末尾活动区、界面静止后显示；组头不承载。 */
const workingShown = () => document.querySelector(".pwa-turn-activity[data-working], .pwa-process-working") !== null;
/** 界面静止超过空闲阈值后 Working 出现在末尾活动区。 */
const workingAfterIdle = () => expect.poll(() => document.querySelector(".pwa-turn-activity[data-working]")?.textContent).toBe("Working…");

/** 已绘制的具体运行图标：明细行的工具图标，或组头正显示成员时的状态图标；裁剪在折叠区外的不算。 */
function paintedSpinner(): boolean | null {
  let subpixelBoundary = false;
  const headMember = head() ? [headIcon()] : [];
  for (const svg of [...document.querySelectorAll<SVGSVGElement>(".pwa-process-details .pwa-tool-spinner"), ...headMember]) {
    if (!svg || !svg.classList.contains("pwa-spin") && !svg.classList.contains("pwa-tool-spinner")) continue;
    if (!svg.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const clip = svg.closest(".pwa-process-details")?.firstElementChild;
    if (!clip) return true;
    const icon = svg.getBoundingClientRect();
    const bounds = clip.getBoundingClientRect();
    const overlap = Math.min(icon.bottom, bounds.bottom) - Math.max(icon.top, bounds.top);
    // 亚像素刚跨过裁剪边界的帧不作精确几何断言；其余按整像素比较。
    if (overlap > 0 && Math.round(overlap) === 0) { subpixelBoundary = true; continue; }
    if (Math.round(overlap) > 0) return true;
  }
  return subpixelBoundary ? null : false;
}

function snapshot() {
  const details = document.querySelector(".pwa-process-details");
  return { spinner: paintedSpinner(), working: workingShown(),
    details: details !== null, opacity: details ? Number(getComputedStyle(details).opacity) : null,
    bottom: Math.round(document.querySelector(".pwa-bottom-sentinel")!.getBoundingClientRect().top) };
}

/** 一个采样窗口只覆盖一次过渡；反向也在同一窗口内采样，不累积长等待。 */
async function sampleTransition(action: () => void, reverse = false) {
  flushSync(action);
  const samples = [snapshot()];
  const start = performance.now();
  let frames = 0;
  await new Promise<void>(resolve => {
    const sample = () => {
      frames += 1;
      if (reverse && (frames === 2 || frames === 3)) flushSync(() => head().click());
      // 等该帧全部 rAF 回调提交完毕再取样，避免把绘制前尚待同步的中间态当成已绘制帧。
      window.setTimeout(() => {
        samples.push(snapshot());
        if (performance.now() - start >= 260) resolve();
        else requestAnimationFrame(sample);
      }, 0);
    };
    requestAnimationFrame(sample);
  });
  expect(samples.length).toBeGreaterThan(1);
  // 已绘制转动图标的帧不再显示 Working；没有转动图标时由空闲计时决定，过渡窗口内不要求立即出现。
  for (const sample of samples) if (sample.spinner === true) {
    expect(sample.working, JSON.stringify(sample)).toBe(false);
  }
  return samples;
}

async function renderTimeline(initial: TimelineViewItem[], style?: CSSProperties) {
  let update!: (items: TimelineViewItem[]) => void;
  function Harness() {
    const [items, setItems] = useState(initial);
    update = setItems;
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    return <main className="pwa-main" style={style}><MessageList items={items} running isLive hasEarlier={false} listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} /></main>;
  }
  await renderPwa(<Harness />);
  return (items: TimelineViewItem[]) => flushSync(() => update(items));
}

const cases = [1280, 390].flatMap(width => ["no-preference", "reduce"].map(motion => ({ width, motion })));
test.each(cases)("a painted spinner keeps Working hidden through collapse frames at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const update = await renderTimeline([running("a"), running("b")], { width: "100vw", height: "100vh" });
  update([running("a"), completed("b")]);
  const toggle = () => head().click();
  // 运行中的组默认展开；手动收起与再展开期间组头始终承担当前成员的运行提示。
  expect(head().getAttribute("aria-expanded")).toBe("true");
  expect(snapshot()).toMatchObject({ spinner: true, working: false });
  const icon = headIcon();
  const exiting = await sampleTransition(toggle);
  expect(exiting.at(-1)?.details).toBe(false);
  const entering = await sampleTransition(toggle);
  expect(entering.at(-1)).toMatchObject({ spinner: true, working: false, details: true });
  for (const frame of [...exiting, ...entering]) expect(frame).toMatchObject({ spinner: true, working: false });
  expect(headIcon()).toBe(icon);
  await sampleTransition(toggle, true);
  // 全部工具结束但本轮未收到 run_end：静止后在末尾活动区兜底，组头不承载，也不伪造结束。
  const finished = await sampleTransition(() => update([completed("a"), completed("b")]));
  expect(finished.at(-1)).toMatchObject({ spinner: false });
  await workingAfterIdle();
  expect(head().querySelector(".pwa-process-working")).toBeNull();
  const previous = [completed("a"), completed("b"), running("c")];
  update(previous);
  expect(snapshot()).toMatchObject({ spinner: true, working: false });
  const next: TimelineEvent = { ...scope, group_id: "next", event_id: "next-user", message_id: "next-user", timestamp: 2, kind: "user", status: "committed", origin: "pwa", sender_ref: "me", delivery: "normal", blocks: [{ type: "text", text: "Next turn" }] };
  update([...previous, { kind: "event", event: next }]);
  // 旧轮过程组的转动图标不能压制新轮的末尾兜底。
  expect(document.querySelector(".pwa-process-working")).toBeNull();
  await workingAfterIdle();
  update([{ kind: "event", event: next }]);
  expect(document.querySelector(".pwa-process-group")).toBeNull();
  expect(document.querySelector(".pwa-turn-activity")).not.toBeNull();
});

test.each(cases)("a running heading keeps its status icon and layout while members change at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const update = await renderTimeline([running("a")]);
  // 手动收起后组头只占一行，成员增减不改变高度。
  flushSync(() => head().click());
  await expect.poll(() => document.querySelector(".pwa-process-details")).toBeNull();
  const spinner = headIcon()!;
  const spin = spinner.getAnimations()[0]!;
  const before = snapshot();
  expect(before).toMatchObject({ spinner: true, working: false });
  expect(spin).toBeDefined();
  const frames = await sampleTransition(() => update(["a", "b", "c", "d", "e"].map(running)));
  // 当前活动是最后开始且仍有效的成员；其余运行数量以 +N 表达，不排队轮播。
  expect(head().querySelector(".pwa-process-tool-detail")?.textContent).toBe("e.ts");
  expect(head().querySelector(".pwa-process-more")?.textContent).toBe("+4");
  expect(headIcon()).toBe(spinner);
  expect(spinner.getAnimations()[0]).toBe(spin);
  for (const frame of frames) expect(frame).toMatchObject({ spinner: true, working: false, bottom: before.bottom });
  update([running("a"), running("b"), running("c"), running("d"), completed("e")]);
  expect(head().querySelector(".pwa-process-tool-detail")?.textContent).toBe("d.ts");
  expect(snapshot()).toMatchObject({ spinner: true, working: false, bottom: before.bottom });
  expect(headIcon()).toBe(spinner);
  expect(spinner.getAnimations()[0]).toBe(spin);
  update(["a", "b", "c", "d", "e"].map(completed));
  // 活动区高度不变：Working 静止后淡入，不改变列表高度。
  expect(snapshot()).toMatchObject({ spinner: false, bottom: before.bottom });
  await workingAfterIdle();
  expect(snapshot().bottom).toBe(before.bottom);
});

test.each(cases)("a hidden member indicator no longer suppresses Working at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const update = await renderTimeline([running("a")]);
  flushSync(() => head().click());
  await expect.poll(() => document.querySelector(".pwa-process-details")).toBeNull();
  const status = headIcon()!.parentElement!;
  status.style.opacity = "0";
  update([running("a"), running("b")]);
  // 看不见的转动图标不算动作：静止后由末尾活动区兜底。
  expect(snapshot()).toMatchObject({ spinner: false });
  await workingAfterIdle();
  status.style.opacity = "1";
  update([completed("a"), running("b")]);
  expect(snapshot()).toMatchObject({ spinner: true, working: false });
});

test.each(cases)("completed to running heading suppresses Working immediately at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  const update = await renderTimeline([running("a")]);
  flushSync(() => head().click());
  await expect.poll(() => document.querySelector(".pwa-process-details")).toBeNull();
  const runningBottom = snapshot().bottom;
  update([completed("a")]);
  expect(snapshot()).toMatchObject({ spinner: false, bottom: runningBottom });
  await workingAfterIdle();
  const frames = await sampleTransition(() => update([completed("a"), ...["b", "c", "d", "e"].map(running)]));
  for (const frame of frames) expect(frame).toMatchObject({ spinner: true, working: false, bottom: runningBottom });
});
