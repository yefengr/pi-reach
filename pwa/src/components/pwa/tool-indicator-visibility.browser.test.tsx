import { useRef, useState } from "react";
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

function paintedSpinner(): boolean | null {
  let subpixelBoundary = false;
  for (const svg of document.querySelectorAll<SVGSVGElement>(".pwa-tool-group .pwa-tool-spinner, .pwa-tool-group-summary > .pwa-spin")) {
    if (!svg.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const clip = svg.closest(".pwa-tool-group-details")?.firstElementChild;
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
  const details = document.querySelector(".pwa-tool-group-details");
  return { spinner: paintedSpinner(), working: document.querySelector(".pwa-thinking-status") !== null,
    details: details !== null, opacity: details ? Number(getComputedStyle(details).opacity) : null };
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
      if (reverse && (frames === 2 || frames === 3)) flushSync(() => document.querySelector<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head button")!.click());
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
  for (const sample of samples) if (sample.spinner !== null) {
    expect(sample.working, JSON.stringify(sample)).toBe(!sample.spinner);
  }
  return samples;
}

const cases = [1280, 390].flatMap(width => ["no-preference", "reduce"].map(motion => ({ width, motion })));
test.each(cases)("Working visibility follows painted collapse frames at $width px ($motion)", async ({ width, motion }) => {
  await page.viewport(width, 844);
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion }] });
  let update!: (items: TimelineViewItem[]) => void;
  function Harness() {
    const [items, setItems] = useState([running("a"), running("b")]);
    update = setItems;
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}><MessageList items={items} running isLive hasEarlier={false} listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} /></main>;
  }
  await renderPwa(<Harness />);
  flushSync(() => update([running("a"), completed("b")]));
  const toggle = () => document.querySelector<HTMLButtonElement>(".pwa-tool-group > .pwa-tool-head button")!.click();
  expect(snapshot()).toMatchObject({ spinner: false, working: true });
  const entering = await sampleTransition(toggle);
  expect(entering[0]).toMatchObject({ opacity: 0, working: true });
  expect(entering.at(-1)).toMatchObject({ spinner: true, working: false });
  const exiting = await sampleTransition(toggle);
  // 减少动态效果时高度立即归零，冻结图标已被裁剪，兜底必须立即回来。
  expect(exiting[0]).toMatchObject({ spinner: motion !== "reduce", working: motion === "reduce" });
  expect(exiting.at(-1)?.details).toBe(false);
  await sampleTransition(toggle, true);
  // 收起时先冻结运行图标，再收到正式完成事件：当前轮未结束，仍要等可见图标退出。
  const finished = await sampleTransition(() => {
    flushSync(toggle);
    update([completed("a"), completed("b")]);
  });
  expect(finished[0]).toMatchObject({ spinner: motion !== "reduce", working: motion === "reduce" });
  expect(finished.at(-1)).toMatchObject({ spinner: false, working: true, details: false });
  const previous = [completed("a"), completed("b"), running("c")];
  flushSync(() => update(previous));
  await sampleTransition(toggle);
  flushSync(toggle);
  const next: TimelineEvent = { ...scope, group_id: "next", event_id: "next-user", message_id: "next-user", timestamp: 2, kind: "user", status: "committed", origin: "pwa", sender_ref: "me", delivery: "normal", blocks: [{ type: "text", text: "Next turn" }] };
  flushSync(() => update([...previous, { kind: "event", event: next }]));
  // 旧轮退出图标还挂载着，也不能压制新轮的 Working。
  expect(document.querySelector(".pwa-tool-group-details .pwa-tool-spinner")).not.toBeNull();
  expect(document.querySelector(".pwa-thinking-status")?.textContent).toBe("Working…");
  flushSync(() => update([{ kind: "event", event: next }]));
  expect(document.querySelector(".pwa-tool-group")).toBeNull();
  expect(document.querySelector(".pwa-thinking-status")?.textContent).toBe("Working…");
});
