import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { HistoryWorkspace, type HistoryRestore } from "./workspace-content";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

function savedItems(count: number): TimelineViewItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "event",
    event: { session_id: "history", leaf_id: "generation", event_id: `e-${index}`, group_id: `g-${index}`, timestamp: index, kind: "assistant", status: "complete", blocks: [{ type: "text", text: `Saved record ${index}` }] },
  }));
}
const items = savedItems(30);

type HarnessOptions = { restore?: HistoryRestore | null; initial?: TimelineViewItem[]; initialLoading?: boolean; visibleCountRef?: { current: number } };

async function renderHistory({ restore = null, initial = items, initialLoading = false, visibleCountRef }: HarnessOptions = {}) {
  let update!: (state: { items: TimelineViewItem[]; loading: boolean }) => void;
  function Harness() {
    const listRef = useRef<HTMLDivElement | null>(null);
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const [state, setState] = useState({ items: initial, loading: initialLoading });
    update = setState;
    return <main className="pwa-main" style={{ height: 500, display: "flex", flexDirection: "column" }}>
      <HistoryWorkspace items={state.items} loading={state.loading} restore={restore} visibleCountRef={visibleCountRef} listRef={listRef} bottomSentinelRef={bottomRef} />
    </main>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, update: (state: { items: TimelineViewItem[]; loading: boolean }) => flushSync(() => update(state)) };
}

function list(): HTMLDivElement { return document.querySelector<HTMLDivElement>(".pwa-message-list")!; }
function renderedRecords(): string[] { return [...list().querySelectorAll("p")].map((element) => element.textContent ?? "").filter((text) => text.startsWith("Saved record")); }

test("opens saved history at the latest content the first time and restores the saved position on return", async () => {
  const { screen: first } = await renderHistory();
  expect(list().scrollHeight).toBeGreaterThan(list().clientHeight);
  await expect.poll(() => list().scrollHeight - list().clientHeight - list().scrollTop).toBeLessThanOrEqual(1);
  await first.unmount();

  await renderHistory({ restore: { scrollTop: 120, visibleCount: 30 } });
  await expect.poll(() => list().scrollTop).toBe(120);
});

test("renders only the latest records of a long history and expands earlier pages without moving the reader", async () => {
  const visibleCountRef = { current: 0 };
  const { screen } = await renderHistory({ initial: savedItems(200), visibleCountRef });
  try {
    await expect.poll(() => renderedRecords().length).toBe(30);
    expect(renderedRecords()[0]).toBe("Saved record 170");
    expect(visibleCountRef.current).toBe(30);
    await expect.poll(() => list().scrollHeight - list().clientHeight - list().scrollTop).toBeLessThanOrEqual(1);

    list().scrollTop = 0;
    const fromBottom = list().scrollHeight - list().scrollTop;
    // 只读历史不依赖实时连接，「加载更多」保持可用。
    await screen.getByRole("button", { name: "Load more", exact: true }).click();
    await expect.poll(() => renderedRecords().length).toBe(110);
    expect(renderedRecords()[0]).toBe("Saved record 90");
    expect(Math.abs(list().scrollHeight - list().scrollTop - fromBottom)).toBeLessThanOrEqual(1);
    expect(visibleCountRef.current).toBe(110);

    await screen.getByRole("button", { name: "Load more", exact: true }).click();
    await screen.getByRole("button", { name: "Load more", exact: true }).click();
    await expect.poll(() => renderedRecords().length).toBe(200);
    await expect.element(screen.getByRole("button", { name: "Load more", exact: true })).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});

test("restores the expanded range together with the saved scroll position", async () => {
  const { screen } = await renderHistory({ initial: savedItems(200), restore: { scrollTop: 300, visibleCount: 110 } });
  try {
    await expect.poll(() => renderedRecords().length).toBe(110);
    await expect.poll(() => list().scrollTop).toBe(300);
  } finally { await screen.unmount(); }
});

test("shows a loading state instead of the empty hint until saved records are read", async () => {
  const { screen, update } = await renderHistory({ initial: [], initialLoading: true });
  try {
    expect(screen.getByText("No records to display.", { exact: true }).query()).toBeNull();
    await expect.poll(() => list().querySelectorAll(".pwa-skeleton").length).toBe(3);
    update({ items, loading: false });
    await expect.poll(() => renderedRecords().length).toBe(30);

    update({ items: [], loading: false });
    await expect.element(screen.getByText("No records to display.", { exact: true })).toBeVisible();
  } finally { await screen.unmount(); }
});

test("keeps attachment cards whose metadata falls just outside the rendered window", async () => {
  const user: TimelineViewItem = { kind: "event", event: { event_id: "message", message_id: "message", group_id: "group", session_id: "history", leaf_id: "user-leaf", timestamp: 2, kind: "user", blocks: [{ type: "text", text: "Server fallback notes.txt" }], sender_ref: "owner", origin: "pwa", delivery: "normal", status: "committed" } };
  const metadata: TimelineViewItem = { kind: "event", event: { event_id: "metadata", session_id: "history", leaf_id: "metadata-leaf", timestamp: 1, kind: "custom", truncated: false, payload: { custom_type: "pi-reach:attachments-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", text: "Original text", attachments: [{ attachment_id: "file", file_name: "notes.txt", mime_type: "text/plain", byte_length: 1024, sha256: "a".repeat(64) }] } } } };
  const binding: TimelineViewItem = { kind: "event", event: { event_id: "binding", session_id: "history", leaf_id: "binding-leaf", timestamp: 3, kind: "custom", truncated: false, payload: { custom_type: "pi-reach:attachment-message-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", message_id: "message" } } } };
  // 共 31 条：最近 30 条的窗口包含用户消息与关联记录，附件元数据落在窗口之外。
  const { screen } = await renderHistory({ initial: [metadata, user, binding, ...savedItems(28)] });
  try {
    await expect.element(screen.getByText("Original text")).toBeVisible();
    await expect.element(screen.getByText("notes.txt", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Server fallback notes.txt")).not.toBeInTheDocument();
  } finally { await screen.unmount(); }
});
