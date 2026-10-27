import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { HistoryConversation } from "./workspace-content";
import type { PeerChannel } from "@/lib/pi-reach/peer-channel";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { ThinkingLevel } from "@/lib/pi-reach/types";
import { loadTimeline } from "@/lib/pwa/timeline-store";
import { useTimeline } from "@/lib/pwa/use-timeline";
import type { TimelineSessionPosition } from "@/lib/pwa/use-timeline-viewport";

vi.mock("@/lib/pwa/timeline-store", () => ({
  loadTimeline: vi.fn(async () => []), mergeTimelineEvents: vi.fn(async () => {}), replaceTimelineEvents: vi.fn(async () => {}), latestTimelineEvent: vi.fn(async () => null), discardTimelineEventsAfter: vi.fn(async () => {}),
  ensureTimelineBranchCheckpoint: vi.fn(async () => null), clearTimelineBranchCheckpoint: vi.fn(async () => {}),
  TimelineStoreConflictError: class extends Error {},
}));

const target = { deviceId: "device", endpointId: "endpoint", sessionId: "history" };

function record(seq: number): TimelineEvent {
  return { session_id: "history", leaf_id: "generation", event_id: `s-${seq}`, event_seq: seq, group_id: `g-${seq}`, timestamp: 10 + seq, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Saved record ${seq}` }] };
}
function savedRecords(count: number): TimelineEvent[] { return Array.from({ length: count }, (_, index) => record(index + 1)); }
function sequenced(sequences: number[]): TimelineEvent[] { return sequences.map(record); }
function runEnd(seq: number, groupId = `g-${seq}`): TimelineEvent {
  return { session_id: "history", leaf_id: "generation", event_id: `s-${seq}`, event_seq: seq, group_id: groupId, timestamp: 10 + seq, kind: "run_end", status: "complete" };
}

let api: ReturnType<typeof useTimeline>;
type HarnessProps = { height: number; modelName: string | null; thinking: ThinkingLevel };
function Harness({ height, modelName, thinking }: HarnessProps) {
  const channelRef = useRef<PeerChannel | null>(null);
  const timeline = useTimeline({ channelRef, reportHistoryFailure: () => {} });
  useLayoutEffect(() => { api = timeline; });
  return <main className="pwa-main" style={{ height, display: "flex", flexDirection: "column" }}>
    <HistoryConversation items={timeline.items} savedEvents={timeline.history?.events ?? []} hasEarlier={timeline.hasEarlier} loadingEarlier={timeline.loadingEarlier} loadEarlierFailed={timeline.loadEarlierFailed} onLoadEarlier={timeline.loadEarlier} loading={timeline.history?.status === "loading"} viewport={timeline} modelName={modelName} thinking={thinking} />
  </main>;
}

type RenderOptions = { saved?: TimelineEvent[] | Promise<TimelineEvent[]>; restore?: { shown: number; position: TimelineSessionPosition }; height?: number; modelName?: string | null; thinking?: ThinkingLevel };

/** 与工作区相同：打开只读历史，切回时先按已展开条数读出，再按行恢复阅读位置。 */
async function renderHistory({ saved = savedRecords(30), restore, height = 500, modelName = null, thinking = "off" }: RenderOptions = {}) {
  vi.mocked(loadTimeline).mockReturnValueOnce(Promise.resolve(saved));
  const screen = await renderPwa(<Harness height={height} modelName={modelName} thinking={thinking} />);
  flushSync(() => {
    void api.openHistory(target, restore?.shown);
    api.restoreSessionPosition(restore?.position ?? null);
  });
  return screen;
}

afterEach(async () => { vi.mocked(loadTimeline).mockReset().mockResolvedValue([]); await page.viewport(1280, 900); });

function list(): HTMLDivElement { return document.querySelector<HTMLDivElement>(".pwa-message-list")!; }
function renderedRecords(): string[] { return [...list().querySelectorAll("p")].map((element) => element.textContent ?? "").filter((text) => text.startsWith("Saved record")); }
function fromBottom(): number { return list().scrollHeight - list().clientHeight - list().scrollTop; }
/** 用户滚动伴随输入事件；没有输入的跳顶会被视口当作系统覆盖前插位置而恢复。 */
function userScrollTo(top: number) {
  list().dispatchEvent(new WheelEvent("wheel", { deltaY: top - list().scrollTop }));
  list().scrollTop = top;
}

test("opens saved history at the latest content and restores the reading row with its expanded range on return", async () => {
  const first = await renderHistory({ saved: savedRecords(200) });
  await expect.poll(() => renderedRecords().length).toBe(30);
  await expect.poll(() => fromBottom()).toBeLessThanOrEqual(1);
  expect(api.followingOutput).toBe(true);

  userScrollTo(0);
  await expect.poll(() => renderedRecords().length).toBe(110);
  // 离顶部足够远，切回时不会再触发自动展开。
  userScrollTo(2000);
  await expect.poll(() => api.followingOutput).toBe(false);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const position = api.captureSessionPosition()!;
  const shown = api.historyShownCount()!;
  const top = list().scrollTop;
  expect(position.following).toBe(false);
  expect(shown).toBe(110);
  await first.unmount();

  const second = await renderHistory({ saved: savedRecords(200), restore: { shown, position } });
  try {
    await expect.poll(() => renderedRecords().length).toBe(110);
    await expect.poll(() => Math.abs(list().scrollTop - top)).toBeLessThanOrEqual(1);
  } finally { await second.unmount(); }
});

test("renders only the latest records of a long history and expands earlier pages near the top without moving the reader", async () => {
  const screen = await renderHistory({ saved: savedRecords(200) });
  try {
    await expect.poll(() => renderedRecords().length).toBe(30);
    expect(renderedRecords()[0]).toBe("Saved record 171");
    await expect.poll(() => fromBottom()).toBeLessThanOrEqual(1);
    // 停在底部跟随最新时不提前展开；按钮只作键盘与兜底入口。
    await expect.element(screen.getByRole("button", { name: "Load more", exact: true })).toBeVisible();

    const distance = list().scrollHeight;
    userScrollTo(0);
    await expect.poll(() => renderedRecords().length).toBe(110);
    expect(renderedRecords()[0]).toBe("Saved record 91");
    expect(Math.abs(list().scrollHeight - list().scrollTop - distance)).toBeLessThanOrEqual(1);

    userScrollTo(0);
    await expect.poll(() => renderedRecords().length).toBe(190);
    userScrollTo(0);
    await expect.poll(() => renderedRecords().length).toBe(200);
    await expect.element(screen.getByRole("button", { name: "Load more", exact: true })).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});

test("keeps the load more button as a keyboard entry", async () => {
  const screen = await renderHistory({ saved: savedRecords(200) });
  try {
    await expect.poll(() => renderedRecords().length).toBe(30);
    // 直接触发按钮：定位器点击会先把按钮滚入视野，接近顶部时自动加载已抢先完成。
    screen.getByRole("button", { name: "Load more", exact: true }).element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.poll(() => renderedRecords().length).toBe(110);
  } finally { await screen.unmount(); }
});

test("shows Latest after scrolling away and returns to the end of the history", async () => {
  const screen = await renderHistory({ saved: savedRecords(30) });
  try {
    await expect.poll(() => renderedRecords().length).toBe(30);
    await expect.poll(() => list().scrollTop > 0 && fromBottom() <= 1).toBe(true);
    expect(screen.getByRole("button", { name: "Latest", exact: true }).query()).toBeNull();
    userScrollTo(list().scrollTop - 300);
    await screen.getByRole("button", { name: "Latest", exact: true }).click();
    await expect.poll(() => fromBottom()).toBeLessThanOrEqual(1);
    await expect.poll(() => screen.getByRole("button", { name: "Latest", exact: true }).query()).toBeNull();
  } finally { await screen.unmount(); }
});

test("fills a history shorter than one screen and keeps following its end", async () => {
  // 视口足够高，最近 30 条不足一屏。
  await page.viewport(1280, 2400);
  const screen = await renderHistory({ saved: savedRecords(200), height: 2400 });
  try {
    await expect.poll(() => renderedRecords().length).toBe(110);
    expect(list().scrollHeight).toBeGreaterThan(list().clientHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(renderedRecords()).toHaveLength(110);
    expect(api.followingOutput).toBe(true);
    await expect.poll(() => fromBottom()).toBeLessThanOrEqual(1);
  } finally { await screen.unmount(); }
});

test("marks records that were never saved in this browser before and between saved ranges", async () => {
  const screen = await renderHistory({ saved: sequenced([5, 6, 7, 20, 21]) });
  try {
    await expect.poll(() => renderedRecords().length).toBe(5);
    await expect.element(screen.getByText("Earlier records aren't saved in this browser")).toBeVisible();
    const gap = screen.getByText("Some records in between aren't saved in this browser");
    await expect.element(gap).toBeVisible();
    const texts = [...list().querySelectorAll("p")].map((element) => element.textContent ?? "");
    expect(texts.indexOf("Some records in between aren't saved in this browser")).toBe(texts.indexOf("Saved record 7") + 1);
    expect(texts.indexOf("Saved record 20")).toBe(texts.indexOf("Some records in between aren't saved in this browser") + 1);
  } finally { await screen.unmount(); }
});

test("pages across a large unsaved gap without an empty page", async () => {
  const screen = await renderHistory({ saved: [...sequenced([1, 2, 3]), ...savedRecords(30).map((event) => ({ ...event, event_id: `late-${event.event_seq}`, event_seq: event.event_seq! + 5000 }))] });
  try {
    await expect.poll(() => renderedRecords().length).toBe(30);
    expect(screen.getByText("Earlier records aren't saved in this browser").query()).toBeNull();
    screen.getByRole("button", { name: "Load more", exact: true }).element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.poll(() => renderedRecords().length).toBe(33);
    await expect.element(screen.getByText("Some records in between aren't saved in this browser")).toBeVisible();
    expect(screen.getByText("Earlier records aren't saved in this browser").query()).toBeNull();
  } finally { await screen.unmount(); }
});

test("moves a gap marker past hidden records to the next visible record", async () => {
  const screen = await renderHistory({ saved: [...sequenced([5, 6, 7]), runEnd(20, "g-7"), ...sequenced([21])] });
  try {
    await expect.poll(() => renderedRecords().length).toBe(4);
    await expect.element(screen.getByText("Some records in between aren't saved in this browser")).toBeVisible();
    const texts = [...list().querySelectorAll("p")].map((element) => element.textContent ?? "");
    expect(texts.indexOf("Saved record 21")).toBe(texts.indexOf("Some records in between aren't saved in this browser") + 1);
  } finally { await screen.unmount(); }
});

test("keeps a gap marker when only hidden records follow the gap", async () => {
  const screen = await renderHistory({ saved: [...sequenced([5, 6, 7]), runEnd(20, "g-7")] });
  try {
    await expect.poll(() => renderedRecords().length).toBe(3);
    await expect.element(screen.getByText("Some records in between aren't saved in this browser")).toBeVisible();
    const texts = [...list().querySelectorAll("p")].map((element) => element.textContent ?? "");
    expect(texts.indexOf("Some records in between aren't saved in this browser")).toBeGreaterThan(texts.indexOf("Saved record 7"));
  } finally { await screen.unmount(); }
});

test("shows a gap marker even when every saved record is hidden", async () => {
  const screen = await renderHistory({ saved: [runEnd(1), runEnd(20)] });
  try {
    await expect.element(screen.getByText("No records to display.")).toBeVisible();
    await expect.element(screen.getByText("Some records in between aren't saved in this browser")).toBeVisible();
  } finally { await screen.unmount(); }
});

test("does not group tools of one run across an unsaved gap", async () => {
  const tool = (seq: number): TimelineEvent => ({ session_id: "history", leaf_id: "generation", event_id: `s-${seq}`, event_seq: seq, group_id: "run", timestamp: seq, kind: "tool", tool_call_id: `call-${seq}`, tool: "read", args: {}, truncated: false, status: "complete", result: {} });
  const screen = await renderHistory({ saved: [tool(1), tool(2), tool(3), tool(20), tool(21), tool(22), runEnd(23, "run")] });
  try {
    await expect.poll(() => list().querySelectorAll(".pwa-tool-group").length).toBe(2);
    const gap = screen.getByText("Some records in between aren't saved in this browser").element();
    const groups = [...list().querySelectorAll(".pwa-tool-group")];
    // 缺口提示位于两组之间，缺口两侧的工具不合并为一组。
    expect(groups[0]!.compareDocumentPosition(gap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gap.compareDocumentPosition(groups[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally { await screen.unmount(); }
});

test("does not mark a complete saved history", async () => {
  const screen = await renderHistory({ saved: sequenced([1, 2, 3]) });
  try {
    await expect.poll(() => renderedRecords().length).toBe(3);
    expect(list().querySelector(".pwa-timeline-notice")).toBeNull();
  } finally { await screen.unmount(); }
});

test("shows a loading state instead of the empty hint until saved records are read", async () => {
  let resolve!: (events: TimelineEvent[]) => void;
  const screen = await renderHistory({ saved: new Promise((done) => { resolve = done; }) });
  try {
    expect(screen.getByText("No records to display.", { exact: true }).query()).toBeNull();
    await expect.poll(() => list().querySelectorAll(".pwa-skeleton").length).toBe(3);
    resolve(savedRecords(30));
    await expect.poll(() => renderedRecords().length).toBe(30);

    vi.mocked(loadTimeline).mockResolvedValueOnce([]);
    flushSync(() => { void api.openHistory({ ...target, sessionId: "empty" }); });
    await expect.element(screen.getByText("No records to display.", { exact: true })).toBeVisible();
  } finally { await screen.unmount(); }
});

test("keeps attachment cards whose metadata falls just outside the rendered window", async () => {
  const user: TimelineEvent = { event_id: "message", message_id: "message", group_id: "group", session_id: "history", leaf_id: "user-leaf", timestamp: 2, kind: "user", blocks: [{ type: "text", text: "Server fallback notes.txt" }], sender_ref: "owner", origin: "pwa", delivery: "normal", status: "committed" };
  const metadata: TimelineEvent = { event_id: "metadata", session_id: "history", leaf_id: "metadata-leaf", timestamp: 1, kind: "custom", truncated: false, payload: { custom_type: "pi-reach:attachments-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", text: "Original text", attachments: [{ attachment_id: "file", file_name: "notes.txt", mime_type: "text/plain", byte_length: 1024, sha256: "a".repeat(64) }] } } };
  const binding: TimelineEvent = { event_id: "binding", session_id: "history", leaf_id: "binding-leaf", timestamp: 3, kind: "custom", truncated: false, payload: { custom_type: "pi-reach:attachment-message-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", message_id: "message" } } };
  // 共 31 条：最近 30 条的窗口包含用户消息与关联记录，附件元数据落在窗口之外。
  const screen = await renderHistory({ saved: [metadata, user, binding, ...savedRecords(28)] });
  try {
    await expect.element(screen.getByText("Original text")).toBeVisible();
    await expect.element(screen.getByText("notes.txt", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Server fallback notes.txt")).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});

test("keeps the live composer layout disabled and shows the last known model only when it is saved", async () => {
  const known = await renderHistory({ modelName: "Saved model", thinking: "high" });
  try {
    await expect.element(known.getByRole("note")).toHaveTextContent("It's read-only.");
    await expect.element(known.getByRole("textbox")).toBeDisabled();
    const model = known.getByRole("button", { name: "Model and thinking settings, current Saved model, thinking level high" });
    await expect.element(model).toBeDisabled();
    await expect.element(model).toHaveTextContent("Saved model · high");
    for (const name of ["Add attachments", "Pi commands", "Send message"]) await expect.element(known.getByRole("button", { name, exact: true })).toBeDisabled();
  } finally {
    await known.unmount();
  }

  const unknown = await renderHistory();
  try {
    await expect.element(unknown.getByRole("textbox")).toBeDisabled();
    expect(document.querySelector(".pwa-composer-model")).toBeNull();
  } finally { await unknown.unmount(); }
});
