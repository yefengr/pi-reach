import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushSync } from "react-dom";
import { cdp, page } from "vitest/browser";
import type { ServerFrame } from "@/lib/pi-reach/protocol-v2/frames";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { TimelineViewportLayout } from "@/lib/pwa/timeline-viewport-layout";
import { TimelineViewportCoordinator } from "@/lib/pwa/timeline-viewport-coordinator";
import { ReplyContinuity } from "@/lib/pwa/timeline-viewport-continuity";
import { renderPwa } from "@/test/browser/render";
import { HANDOFF_SCOPE, installHandoffClock, renderHandoffHarness, type HandoffHarness } from "@/test/browser/timeline-handoff";

const FRAME_MS = 16;
const replayCases = [390, 1100].flatMap(width => [FRAME_MS, 33].map(frameMs => ({ width, frameMs })));
const STREAM_START_MS = 320;
const FORMAL_AT_MS = 800;
// 覆盖最长收尾窗口与滚动收敛，不依赖实际墙钟速度。
const SETTLED_AT_MS = 1920;
const PIXEL_TOLERANCE = 1;
const paragraphs = (prefix: string, count: number) => Array.from({ length: count }, (_, index) =>
  `${prefix} ${index}: A stable passage remains readable while the following content is displayed.`,
).join("\n\n");
const initialEvent: TimelineEvent = {
  event_id: "handoff-history", event_seq: 1, session_id: HANDOFF_SCOPE.sessionId,
  leaf_id: HANDOFF_SCOPE.leafId, group_id: "earlier-turn", timestamp: 1,
  kind: "assistant", status: "complete", blocks: [{ type: "text", text: paragraphs("Earlier", 18) }],
};
function partial(delta: string): ServerFrame {
  return { protocol_version: 2, type: "timeline_partial", session_id: HANDOFF_SCOPE.sessionId,
    leaf_id: HANDOFF_SCOPE.leafId, group_id: "handoff-turn", partial_id: "handoff-reply:assistant:0",
    kind: "assistant", status: "delta", delta };
}
function formal(text: string, advanceLeaf: boolean): TimelineEvent {
  return { event_id: "handoff-reply", event_seq: 2, session_id: HANDOFF_SCOPE.sessionId,
    leaf_id: advanceLeaf ? "handoff-reply-leaf" : HANDOFF_SCOPE.leafId,
    group_id: "handoff-turn", timestamp: 2, kind: "assistant", status: "complete",
    blocks: [{ type: "text", text }] };
}
function queue(editable: boolean): ServerFrame {
  return { protocol_version: 2, type: "queued_message_state", session_id: HANDOFF_SCOPE.sessionId,
    leaf_id: HANDOFF_SCOPE.leafId, snapshot_id: `handoff-queue-${String(editable)}`,
    chunk_index: 0, final: true, items: [{ id: "handoff-queued", text: "The queued follow-up",
      sender_ref: HANDOFF_SCOPE.selfSenderRef, editable, created_at: 1 }] };
}

/** 只记录有限几何与控制状态，不记录消息正文。每次操作清空诊断，避免环形容量截掉交接边界。 */
function recordHandoff(h: HandoffHarness) {
  const diagnostics = window.__PI_REACH_VIEWPORT__!;
  diagnostics.enable();
  const old = h.list.querySelector("article")!;
  const geometry = () => ({ top: Math.round(h.list.scrollTop), bottom: h.list.scrollHeight - h.list.clientHeight,
    client: h.list.clientHeight, height: h.list.scrollHeight, old: Math.round(old.getBoundingClientRect().top),
    header: Math.round(h.header.getBoundingClientRect().top), input: Math.round(h.input.getBoundingClientRect().top),
    footer: Math.round(h.footer.getBoundingClientRect().height),
    partial: h.timeline().items.some(item => item.kind === "partial"),
    queued: document.querySelector(".pwa-queued-messages") !== null,
  });
  type Geometry = ReturnType<typeof geometry>;
  type Write = { reason: string; mode: string; top: number; actual: number; requested: number | null };
  const samples: Array<{ phase: string; time: number; before: Geometry; after: Geometry; writes: Write[] }> = [];
  return {
    samples, geometry, close: () => diagnostics.disable(),
    capture(phase: string, time: number, run: () => void) {
      diagnostics.clear();
      const before = geometry();
      run();
      const sample = { phase, time, before, after: geometry(), writes: diagnostics.read()
        .filter(entry => entry.requested !== null)
        .map(({ reason, mode, top, actual, requested }) => ({ reason, mode, top: Math.round(top), actual: Math.round(actual),
          requested: requested === null ? null : Math.round(requested) })) };
      samples.push(sample);
      return sample;
    },
  };
}
type Clock = ReturnType<typeof installHandoffClock>;
type Recording = ReturnType<typeof recordHandoff>;

function prepareFinishingReply(h: HandoffHarness, clock: Clock, recording: Recording, frameMs = FRAME_MS) {
  for (let time = 0; time <= STREAM_START_MS; time += frameMs) clock.step(time);
  clock.step(STREAM_START_MS);
  const body = paragraphs("Reply", 12);
  const suffix = `\n\n${paragraphs("Tail", 5)}`;
  h.receive(partial(body));
  for (let time = STREAM_START_MS + frameMs; time <= FORMAL_AT_MS; time += frameMs) {
    recording.capture("stream", time, () => clock.step(time));
  }
  clock.step(FORMAL_AT_MS);
  // wire delta 只发送新增后缀；保留真实显示积压，不手工喂显示快照。
  h.receive(partial(suffix));
  expect(h.list.querySelector("article.partial")).not.toBeNull();
  expect(h.list.textContent).not.toContain("Tail 4");
  expect(h.timeline().followingNow()).toBe(true);
  return body + suffix;
}

function startQueuedFinish(h: HandoffHarness, clock: Clock, recording: Recording) {
  h.receive(queue(true));
  const text = prepareFinishingReply(h, clock, recording);
  const event = formal(text, true);
  h.commit(event);
  h.commit({ event_id: "handoff-run-end", event_seq: 3, session_id: HANDOFF_SCOPE.sessionId,
    leaf_id: event.leaf_id, group_id: "handoff-turn", timestamp: 3, kind: "run_end", status: "complete" });
  h.receive(queue(false));
  clock.step(FORMAL_AT_MS + FRAME_MS);
  clock.step(FORMAL_AT_MS + FRAME_MS * 2);
  expect(h.footer.style.height).not.toBe("");
  return event;
}

function assertSettled(h: HandoffHarness, clock: Clock, event: TimelineEvent) {
  expect(h.timeline().runtimeRef.current.formalEvents()).toContainEqual(event);
  expect(h.timeline().items.some(item => item.kind === "partial")).toBe(false);
  expect(h.list.textContent).toContain("Tail 4");
  expect(h.timeline().followingNow()).toBe(true);
  expect(h.footer.style.height).toBe("");
  expect(clock.pending()).toBe(0);
}

function synchronousJumps(samples: Recording["samples"]) {
  return samples.flatMap(sample => sample.writes
    .filter(write => write.reason !== "frame" && Math.abs(write.actual - write.top) > PIXEL_TOLERANCE)
    .map(write => ({ phase: sample.phase, time: sample.time, ...write })));
}

beforeEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
});

test.each(replayCases.flatMap(replay => [false, true].map(advanceLeaf => ({ ...replay, advanceLeaf }))))(
  "formal takeover preserves the live row without a snap (width=$width frame=$frameMs leaf=$advanceLeaf)", async ({ width, frameMs, advanceLeaf }) => {
  // 先排除 Working、完成时间与队列几何；两组唯一差异是正式记录的 leaf。
  const h = await renderHandoffHarness({ width, initialEvents: [initialEvent], running: false });
  const clock = installHandoffClock();
  const recording = recordHandoff(h);
  try {
    const text = prepareFinishingReply(h, clock, recording, frameMs);
    const row = h.list.querySelector("article.partial")!;
    const rowKey = row.getAttribute("data-viewport-row");
    const event = formal(text, advanceLeaf);
    recording.capture("formal arrives", FORMAL_AT_MS, () => h.commit(event));
    // 正式数据已接收，但显示仍在收尾；业务状态不能等待动画。
    expect(h.timeline().runtimeRef.current.formalEvents()).toContainEqual(event);
    expect(h.timeline().items.some(item => item.kind === "partial")).toBe(true);
    for (let time = FORMAL_AT_MS + frameMs; time <= SETTLED_AT_MS; time += frameMs) {
      recording.capture("finish", time, () => clock.step(time));
    }
    assertSettled(h, clock, event);
    expect(Math.round(h.list.scrollHeight - h.list.clientHeight - h.list.scrollTop)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    const takeover = recording.samples.find(sample => sample.before.partial && !sample.after.partial);
    expect(takeover).toBeDefined();
    if (!takeover) throw new Error("Expected a partial-to-formal display boundary");
    // 旧位置仍可达，排除原生最大滚动范围收缩造成的钳制。
    expect(takeover.before.top).toBeLessThanOrEqual(takeover.after.bottom);
    expect(takeover.after.client).toBe(takeover.before.client);
    expect(takeover.after.header).toBe(takeover.before.header);
    expect(takeover.after.input).toBe(takeover.before.input);
    expect.soft(h.list.querySelectorAll("article.assistant").item(1) === row, "formal takeover keeps the existing DOM row").toBe(true);
    expect.soft(h.list.querySelectorAll("article.assistant").item(1).getAttribute("data-viewport-row")).toBe(rowKey);
    expect(synchronousJumps([takeover])).toEqual([]);
  } finally {
    recording.close();
    await h.screen.unmount();
    clock.restore();
  }
});

test.each(replayCases.flatMap(replay => [0, replay.frameMs].map(delay => ({ ...replay, delay }))))(
  "queue drain joins the finishing reply without body jumps (width=$width frame=$frameMs delay=$delay)", async ({ width, frameMs, delay }) => {
  const h = await renderHandoffHarness({ width, initialEvents: [initialEvent] });
  const clock = installHandoffClock();
  const recording = recordHandoff(h);
  // spy 保留原生实现；不伪造布局或滚动结果。
  const send = vi.spyOn(TimelineViewportLayout.prototype, "send");
  try {
    h.receive(queue(true));
    const text = prepareFinishingReply(h, clock, recording, frameMs);
    const event = formal(text, true);
    h.commit(event);
    h.commit({ event_id: "handoff-run-end", event_seq: 3, session_id: HANDOFF_SCOPE.sessionId,
      leaf_id: event.leaf_id, group_id: "handoff-turn", timestamp: 3, kind: "run_end", status: "complete" });
    const drain = () => {
      expect(new TimelineViewportLayout(h.list).measure().animate).toBe(true);
      return recording.capture("queue starts", FORMAL_AT_MS + delay, () => h.receive(queue(false)));
    };
    if (delay === 0) drain();
    for (let time = FORMAL_AT_MS + frameMs; time <= SETTLED_AT_MS; time += frameMs) {
      recording.capture("finish", time, () => clock.step(time));
      // 先实际推进一帧，再发送下一帧快照；不能只改采样标签而让时钟仍停在上一帧。
      if (delay === frameMs && time === FORMAL_AT_MS + frameMs) drain();
    }
    assertSettled(h, clock, event);
    const transition = recording.samples.find(sample => sample.phase === "queue starts")!;
    expect(transition.before.queued).toBe(true);
    expect(transition.after.queued).toBe(false);
    expect(transition.after.partial).toBe(true);
    expect(h.list.textContent).toContain("The queued follow-up");
    expect(transition.before.top).toBeLessThanOrEqual(transition.after.bottom);
    expect(transition.after.header).toBe(transition.before.header);
    expect(transition.after.input).toBe(transition.before.input);
    expect.soft(send).toHaveBeenCalledOnce();
    expect.soft(Math.abs(transition.after.old - transition.before.old)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    // 出队后尾部已是用户行，仍须平滑承接上一条回复尚未放完的文字。
    const finishing = recording.samples.filter(sample => sample.time >= transition.time && sample.before.partial && sample.after.partial);
    expect(finishing.length).toBeGreaterThan(0);
    expect(synchronousJumps(finishing)).toEqual([]);
  } finally {
    send.mockRestore();
    recording.close();
    await h.screen.unmount();
    clock.restore();
  }
});

test.each(replayCases.flatMap(replay => [0, replay.frameMs].map(delay => ({ ...replay, delay }))))(
  "same-turn completion joins the reply before queue drain (width=$width frame=$frameMs delay=$delay)", async ({ width, frameMs, delay }) => {
  // 同轮正式 user 使 run_end 在回复尚有显示积压时就能生成真实完成时间。
  const user: TimelineEvent = { event_id: "completion-user", event_seq: 2, message_id: "completion-user",
    session_id: HANDOFF_SCOPE.sessionId, leaf_id: HANDOFF_SCOPE.leafId, group_id: "handoff-turn", timestamp: 2,
    kind: "user", status: "committed", origin: "pwa", sender_ref: HANDOFF_SCOPE.selfSenderRef,
    delivery: "normal", blocks: [{ type: "text", text: "A reply that will finish before the queue starts" }] };
  const h = await renderHandoffHarness({ width, initialEvents: [initialEvent, user], running: false });
  const clock = installHandoffClock();
  const recording = recordHandoff(h);
  try {
    clock.step(STREAM_START_MS);
    const body = paragraphs("Reply", 12);
    const suffix = `\n\n${paragraphs("Tail", 5)}`;
    h.receive(partial(body));
    h.timeline().followOwnSend(h.timeline().captureOwnSend());
    h.receive(queue(true));
    for (let time = STREAM_START_MS + frameMs; time <= FORMAL_AT_MS; time += frameMs) clock.step(time);
    clock.step(FORMAL_AT_MS);
    h.receive(partial(suffix));
    const event = { ...formal(body + suffix, true), event_seq: 3 };
    h.commit(event);
    expect(h.list.querySelector(".pwa-turn-meta")).toBeNull();
    expect(h.list.querySelector(".pwa-thinking-status")).toBeNull();
    const completion = recording.capture("completion", FORMAL_AT_MS, () => h.commit({
      event_id: "completion-run-end", event_seq: 4, session_id: HANDOFF_SCOPE.sessionId,
      leaf_id: event.leaf_id, group_id: "handoff-turn", timestamp: 3, kind: "run_end", status: "complete",
    }));
    expect(h.list.querySelector(".pwa-turn-meta")).not.toBeNull();
    expect(completion.before.partial && completion.after.partial).toBe(true);
    expect(completion.before.queued && completion.after.queued).toBe(true);
    expect(completion.after.height).toBeGreaterThan(completion.before.height);
    expect(completion.before.top).toBeLessThanOrEqual(completion.after.bottom);
    expect(completion.after.client).toBe(completion.before.client);
    expect(completion.after.header).toBe(completion.before.header);
    expect(completion.after.input).toBe(completion.before.input);
    expect.soft(Math.abs(completion.after.old - completion.before.old)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    expect.soft(synchronousJumps([completion])).toEqual([]);
    if (delay === 0) recording.capture("queue starts", FORMAL_AT_MS, () => h.receive(queue(false)));
    for (let time = FORMAL_AT_MS + frameMs; time <= SETTLED_AT_MS; time += frameMs) {
      recording.capture("finish", time, () => clock.step(time));
      if (delay === frameMs && time === FORMAL_AT_MS + frameMs) {
        recording.capture("queue starts", time, () => h.receive(queue(false)));
      }
    }
    assertSettled(h, clock, event);
    expect(synchronousJumps(recording.samples)).toEqual([]);
  } finally { recording.close(); await h.screen.unmount(); clock.restore(); }
});

test.each(["read", "reset"] as const)("queue continuity releases control on %s", async action => {
  const h = await renderHandoffHarness({ initialEvents: [initialEvent] });
  const clock = installHandoffClock();
  const recording = recordHandoff(h);
  try {
    startQueuedFinish(h, clock, recording);
    if (action === "reset") {
      flushSync(() => h.timeline().clearTimeline());
      expect(h.timeline().items).toHaveLength(0);
    } else {
      flushSync(() => {
        h.list.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
        h.list.scrollTop -= 80;
        h.list.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      expect(h.timeline().followingNow()).toBe(false);
    }
    const afterInput = Math.round(h.list.scrollTop);
    expect(h.footer.style.height).toBe("");
    for (let time = FORMAL_AT_MS + FRAME_MS * 3; time <= SETTLED_AT_MS; time += FRAME_MS) clock.step(time);
    expect(Math.round(h.list.scrollTop)).toBe(afterInput);
    expect(h.footer.style.height).toBe("");
    expect(clock.pending()).toBe(0);
    if (action === "read") expect(h.timeline().followingNow()).toBe(false);
    else expect(h.list.querySelector("article")).toBeNull();
  } finally {
    recording.close();
    await h.screen.unmount();
    clock.restore();
  }
});

async function stationaryQueuedReply(h: HandoffHarness, clock: Clock) {
  h.receive(queue(true));
  h.receive(partial(paragraphs("Live", 4)));
  for (let time = 0; time <= 800; time += FRAME_MS) clock.step(time);
  h.receive(queue(false));
  for (let time = 816; time <= SETTLED_AT_MS; time += FRAME_MS) clock.step(time);
  expect(h.list.querySelector("article.partial")).not.toBeNull();
  expect(h.timeline().followingNow()).toBe(true);
  expect(clock.pending()).toBe(0);
}

test.each(["user", "large-user", "tool"] as const)("an old partial does not smooth a new %s row after queue handoff", async kind => {
  const h = await renderHandoffHarness({ initialEvents: [initialEvent], running: false });
  const clock = installHandoffClock();
  try {
    await stationaryQueuedReply(h, clock);
    const before = h.list.scrollTop;
    const common = { event_id: "unrelated-row", event_seq: 3, session_id: HANDOFF_SCOPE.sessionId,
      leaf_id: HANDOFF_SCOPE.leafId, group_id: "unrelated-turn", timestamp: 3 };
    h.commit(kind === "tool" ? { ...common, kind: "tool", status: "complete", tool_call_id: "unrelated-tool", tool: "read", args: {}, result: "done", truncated: false }
      : { ...common, kind: "user", status: "committed", message_id: common.event_id, origin: "extension", delivery: "normal",
        blocks: [{ type: "text", text: paragraphs("New user", kind === "large-user" ? 30 : 1) }] });
    // 正式事件也经过真实显示调度器，先消费发布帧再核对同帧落点。
    clock.step(SETTLED_AT_MS + FRAME_MS);
    expect(h.list.querySelector("article.partial")).not.toBeNull();
    expect(h.list.scrollHeight - h.list.clientHeight).toBeGreaterThan(before);
    expect(Math.round(h.list.scrollTop)).toBe(h.list.scrollHeight - h.list.clientHeight);
    if (kind === "large-user") expect(h.list.scrollTop - before).toBeGreaterThan(h.list.clientHeight);
  } finally { await h.screen.unmount(); clock.restore(); }
});

test("a stationary partial probe permits blank-area taps and smooths only its own later growth", async () => {
  const h = await renderHandoffHarness({ initialEvents: [initialEvent], running: false });
  const clock = installHandoffClock();
  try {
    await stationaryQueuedReply(h, clock);
    flushSync(() => h.list.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true })));
    expect(h.timeline().followingNow()).toBe(true);
    // 经过既有输入暂停窗口再开始下一段显示。
    clock.step(2200);
    const at = h.list.scrollTop;
    h.receive(partial(`\n\n${paragraphs("Continuation", 2)}`));
    let sawPendingGeometry = false;
    for (let time = 2216; time <= 3600; time += FRAME_MS) {
      clock.step(time);
      if (h.list.scrollHeight - h.list.clientHeight - h.list.scrollTop > PIXEL_TOLERANCE) sawPendingGeometry = true;
    }
    expect(sawPendingGeometry).toBe(true);
    expect(h.list.scrollTop).toBeGreaterThan(at);
    expect(h.timeline().followingNow()).toBe(true);
    expect(Math.round(h.list.scrollTop)).toBe(h.list.scrollHeight - h.list.clientHeight);
    expect(clock.pending()).toBe(0);
  } finally { await h.screen.unmount(); clock.restore(); }
});

test("real activity layout hands the reply glide's velocity to the next growth frame", async () => {
  const screen = await renderPwa(<main className="pwa-main">
    <div data-testid="activity-list" className="pwa-message-list" style={{ height: 300, flex: "none", overflow: "auto" }}>
      <article className="pwa-message assistant partial" data-viewport-row="moving-reply">
        {Array.from({ length: 20 }, (_, i) => <p key={i}>A real layout paragraph {i}</p>)}
      </article>
    </div>
  </main>);
  const list = document.querySelector<HTMLDivElement>("[data-testid='activity-list']")!;
  const row = list.querySelector("article")!;
  const clock = installHandoffClock();
  const layout = new TimelineViewportLayout(list);
  const core = new TimelineViewportCoordinator<NonNullable<ReturnType<typeof layout.captureSend>>, NonNullable<ReturnType<typeof layout.captureAnchor>>>({
    now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id),
  }, () => {});
  const activity = vi.spyOn(layout, "activity");
  const grow = () => { const p = document.createElement("p"); p.textContent = "Another measured paragraph"; row.append(p); };
  try {
    core.bind(layout); core.notify("commit");
    grow(); core.notify("commit");
    clock.step(16); clock.step(32); clock.step(48);
    const working = document.createElement("div"); working.style.height = `${layout.measure().tailSpace + 56}px`; list.append(working);
    core.notify("activity", true, layout.measure().tailSpace + 56);
    expect(activity).toHaveBeenCalledOnce();
    clock.step(208); // 真实 ActivityFollowTransition 的 160ms 尺寸时钟结束。
    expect(core.state.mode).toBe("idle");
    const at = list.scrollTop;
    grow(); core.notify("commit");
    expect(list.scrollTop).toBe(at);
    clock.step(224);
    expect(list.scrollTop).toBeGreaterThan(at); // 不能因 activity 的无 target step 清空旧速度和时钟。
  } finally { core.bind(null); activity.mockRestore(); await screen.unmount(); clock.restore(); }
});

test.each(["same-turn", "different-turn", "separated", "new-user", "new-tool"] as const)(
  "a cached reply probe limits completion geometry to %s", async kind => {
  const screen = await renderPwa(<main className="pwa-main">
    <div data-testid="completion-probe" className="pwa-message-list" style={{ height: 300, flex: "none", overflow: "auto" }}>
      <article className="pwa-message assistant partial" data-viewport-row="probe-reply" data-viewport-turn="probe-turn">
        {Array.from({ length: 20 }, (_, index) => <p key={index}>A measured reply paragraph {index}</p>)}
      </article>
    </div>
  </main>);
  const list = document.querySelector<HTMLDivElement>("[data-testid='completion-probe']")!;
  const layout = new TimelineViewportLayout(list);
  const probe = layout.captureReply()!;
  const before = layout.measure();
  const initialHeight = probe.sample()!.height;
  const continuity = new ReplyContinuity(probe, before);
  const query = vi.spyOn(list, "querySelectorAll");
  try {
    const meta = document.createElement("p");
    meta.className = "pwa-turn-meta";
    meta.setAttribute("data-viewport-completion", kind === "different-turn" ? "other-turn" : "probe-turn");
    meta.textContent = "00:00";
    if (kind === "separated") {
      const separator = document.createElement("div");
      separator.style.height = "44px";
      list.append(separator);
    }
    list.append(meta);
    if (kind === "new-user" || kind === "new-tool") {
      const other = document.createElement("article");
      other.className = kind === "new-user" ? "pwa-message user" : "pwa-tool";
      other.setAttribute("data-viewport-row", kind);
      other.style.height = "60px";
      list.append(other);
    }
    const after = layout.measure();
    const localGrowth = probe.sample()!.height - initialHeight;
    expect(after.height).toBeGreaterThan(before.height);
    expect(continuity.update(after)).toBe(kind === "same-turn");
    if (kind === "same-turn") {
      expect(Math.abs(localGrowth - (after.height - before.height))).toBeLessThanOrEqual(PIXEL_TOLERANCE);
      expect(meta.hasAttribute("data-viewport-row")).toBe(false);
    } else expect(Math.abs(localGrowth - (after.height - before.height))).toBeGreaterThan(PIXEL_TOLERANCE);
    expect(query).not.toHaveBeenCalled();
  } finally { query.mockRestore(); await screen.unmount(); }
});

test.each(["turn", "identity", "parent"] as const)("a cached reply probe rejects a changed %s", async kind => {
  const screen = await renderPwa(<main className="pwa-main">
    <div data-testid="completion-identity" className="pwa-message-list">
      <article className="pwa-message assistant partial" data-viewport-row="probe-reply" data-viewport-turn="probe-turn">Reply</article>
    </div>
  </main>);
  try {
    const list = document.querySelector<HTMLDivElement>("[data-testid='completion-identity']")!;
    const row = list.querySelector("article")!;
    const probe = new TimelineViewportLayout(list).captureReply()!;
    expect(probe.sample()).not.toBeNull();
    if (kind === "parent") {
      const wrapper = document.createElement("div");
      list.append(wrapper);
      wrapper.append(row);
    } else row.setAttribute(kind === "turn" ? "data-viewport-turn" : "data-viewport-row", "different");
    expect(probe.sample()).toBeNull();
  } finally { await screen.unmount(); }
});

test("Reduced Motion immediately releases queue dimensions and skips the inherited glide", async () => {
  const h = await renderHandoffHarness({ initialEvents: [initialEvent] });
  const clock = installHandoffClock();
  const recording = recordHandoff(h);
  try {
    const event = startQueuedFinish(h, clock, recording);
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // 媒体查询值可能先于 change 事件更新；等待真实处理完成，不把 CDP 响应当作事件已交付。
    await vi.waitFor(() => {
      expect(new TimelineViewportLayout(h.list).measure().animate).toBe(false);
      expect(h.footer.style.height).toBe("");
    });
    for (let time = FORMAL_AT_MS + FRAME_MS * 3; time <= SETTLED_AT_MS; time += FRAME_MS) clock.step(time);
    assertSettled(h, clock, event);
    expect(Math.round(h.list.scrollHeight - h.list.clientHeight - h.list.scrollTop)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  } finally {
    recording.close();
    await h.screen.unmount();
    clock.restore();
  }
});

test("a queue drained in the background does not replay a send transition on return", async () => {
  const h = await renderHandoffHarness({ initialEvents: [initialEvent] });
  const clock = installHandoffClock();
  const recording = recordHandoff(h);
  const send = vi.spyOn(TimelineViewportLayout.prototype, "send");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  try {
    h.receive(queue(true));
    const text = prepareFinishingReply(h, clock, recording);
    hidden.mockReturnValue(true);
    flushSync(() => document.dispatchEvent(new Event("visibilitychange")));
    const event = formal(text, true);
    h.commit(event);
    h.receive(queue(false));
    hidden.mockReturnValue(false);
    flushSync(() => document.dispatchEvent(new Event("visibilitychange")));
    for (let time = FORMAL_AT_MS + FRAME_MS; time <= SETTLED_AT_MS; time += FRAME_MS) clock.step(time);
    assertSettled(h, clock, event);
    expect(document.querySelector(".pwa-queued-messages")).toBeNull();
    expect(h.list.textContent).toContain("The queued follow-up");
    expect(send).not.toHaveBeenCalled();
  } finally {
    hidden.mockRestore();
    send.mockRestore();
    recording.close();
    await h.screen.unmount();
    clock.restore();
  }
});
