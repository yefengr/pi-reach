import { describe, expect, test } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelinePending } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderList(items: Parameters<typeof MessageList>[0]["items"], overrides: Partial<Parameters<typeof MessageList>[0]> = {}): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <MessageList
        items={items}
        hasEarlier
        listRef={createRef<HTMLDivElement>()}
        bottomSentinelRef={createRef<HTMLDivElement>()}
        onScroll={() => {}}
        {...overrides}
      />
    </PwaUiProvider>,
  );
}

const toolEvent: Extract<TimelineEvent, { kind: "tool" }> = {
  event_id: "event-1",
  session_id: "session-1",
  leaf_id: "history-1",
  timestamp: 0,
  group_id: "group-1",
  kind: "tool",
  tool_call_id: "tool-1",
  tool: "read",
  args: {},
  truncated: false,
  status: "complete",
  result: {},
};

const unknownPending: TimelinePending = {
  kind: "pending",
  id: "pending-1",
  clientRequestId: "request-1",
  requestId: "request-1",
  text: "Retry me",
  createdAt: 0,
  delivery: "unknown_delivery",
};

test("keeps earlier and retry actions alongside an independently collapsed tool", () => {
  const html = renderList([{ kind: "event", event: toolEvent }, unknownPending], { onRetryUnknown: () => {} });
  const earlierButton = html.match(/<button[^>]*class="[^"]*pwa-earlier-button[^"]*"[^>]*>/)?.[0] ?? "";
  const toolToggle = html.match(/<button[^>]*aria-label="Expand read tool"[^>]*>/)?.[0] ?? "";
  const retryAction = html.match(/<button[^>]*aria-label="Retry delivery"[^>]*>/)?.[0] ?? "";

  expect(earlierButton).toMatch(/pwa-button/);
  expect(earlierButton).toMatch(/data-variant="default"/);
  expect(toolToggle).toMatch(/aria-expanded="false"/);
  expect(html).not.toContain("pwa-activity");
  // 投递状态行下方的文字按钮「重试」。
  expect(retryAction).toMatch(/data-variant="transparent"/);
  expect(retryAction).toMatch(/pwa-delivery-action/);
  expect(html).toContain("Delivery status unknown");
});

test("keeps final answers visible while thinking is collapsed and skips empty assistant cards", () => {
  const base = { event_id: "answer", session_id: "s", leaf_id: "g", timestamp: 0, group_id: "group", kind: "assistant" as const, status: "complete" as const };
  const html = renderList([
    { kind: "event", event: { ...base, blocks: [{ type: "thinking", text: "private preview" }, { type: "text", text: "**Visible answer**" }] } },
    { kind: "event", event: { ...base, event_id: "empty", blocks: [] } },
  ]);
  expect(html).toContain("Expand thinking");
  expect(html).not.toContain("private preview");
  expect(html).toContain("<strong>Visible answer</strong>");
  expect(html.match(/<article /g)).toHaveLength(1);
});

test("keeps failed tools collapsed with a visible error status", () => {
  const event: TimelineEvent = { ...toolEvent, status: "error", error: "Permission denied", args: { path: "file.txt" }, result: [{ type: "text", text: "Readable text" }] };
  const html = renderList([{ kind: "event", event }]);
  expect(html).toContain("Expand read tool");
  expect(html).toContain('data-tool-status="error"');
  expect(html).toContain("Error");
  expect(html).not.toContain("Permission denied");
  expect(html).not.toContain("Readable text");
  expect(html).not.toContain("Tool input");
  expect(html).not.toContain("Tool output");
});

test("uses a Mantine cancel action only for cancelable queued messages", () => {
  const html = renderList([{
    ...unknownPending,
    delivery: "accepted",
    cancelable: true,
  }], { onCancelQueued: () => {} });
  const cancelAction = html.match(/<button[^>]*aria-label="Cancel queued message"[^>]*>/)?.[0] ?? "";

  expect(cancelAction).toMatch(/pwa-delivery-action/);
  expect(html).toContain(">Queued<");
});

test("summarizes common tools in the header while raw args stay in the collapsed details", () => {
  // 分属不同轮次，避免相邻成功工具合并为摘要行，从而检查每条工具自己的标题。
  const read: TimelineEvent = { ...toolEvent, args: { path: "src/components/pwa/message-list.tsx" } };
  const run: TimelineEvent = { ...toolEvent, event_id: "bash", tool_call_id: "bash-1", group_id: "group-bash", tool: "bash", args: { command: "pnpm   test" }, result: "ok" };
  const search: TimelineEvent = { ...toolEvent, event_id: "search", tool_call_id: "search-1", group_id: "group-search", tool: "grep", args: { pattern: "ToolCard", path: "src" }, result: [] };
  const html = renderList([{ kind: "event", event: read }, { kind: "event", event: run }, { kind: "event", event: search }]);

  expect(html).toContain("src/components/pwa/message-list.tsx");
  expect(html).toContain("Expand read tool");
  expect(html).toContain("Expand bash tool");
  expect(html).toContain("Expand grep tool");
  expect(html).toContain("pnpm   test");
  expect(html).toContain("ToolCard");
  expect(html).not.toContain("&quot;path&quot;");
  expect(html).not.toContain("&quot;command&quot;");
});

test("keeps streaming thinking collapsed independently of the tools", () => {
  const partial: TimelinePartial = {
    protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1",
    group_id: "group-1", partial_id: "thinking", kind: "thinking", status: "delta", delta: "Inspecting the request.",
  };
  const html = renderList([{ kind: "partial", createdAt: 0, partial }]);

  expect(html).toContain("Thinking…");
  expect(html).not.toContain("Inspecting the request.");
  expect(html).not.toContain("pwa-tool-code");
  expect(html).toContain('aria-expanded="false"');
});

test("does not render run_end markers as timeline rows", () => {
  const runEnd: TimelineEvent = { event_id: "run-end-1", session_id: "session-1", leaf_id: "history-1", timestamp: 1, group_id: "group-1", kind: "run_end", status: "complete" };
  const html = renderList([{ kind: "event", event: toolEvent }, { kind: "event", event: runEnd }]);
  expect(html).not.toContain("run_end");
  expect(html).not.toContain("System");
  expect(renderList([{ kind: "event", event: runEnd }])).toContain("Send a message to Pi to begin.");
});

const customEvent: TimelineEvent = { event_id: "custom-1", session_id: "session-1", leaf_id: "history-1", timestamp: 1, kind: "custom", payload: { notice: true }, truncated: false };

test("hides extension custom events without rendering their raw payload", () => {
  const html = renderList([{ kind: "event", event: toolEvent }, { kind: "event", event: customEvent }]);
  expect(html).toContain("Expand read tool");
  expect(html).not.toContain("notice");
  expect(html).not.toContain("System");
});

test("falls back to the empty state when a list only holds hidden custom events", () => {
  const html = renderList([{ kind: "event", event: customEvent }], { hasEarlier: false });
  expect(html).toContain("Send a message to Pi to begin.");
  expect(html).not.toContain("notice");
  expect(html).not.toContain("System");
});

test("keeps compaction and branch summaries visible alongside hidden custom events", () => {
  const compaction: TimelineEvent = { event_id: "compaction-1", session_id: "session-1", leaf_id: "history-1", timestamp: 2, kind: "compaction", payload: "Compacted history", truncated: false };
  const branch: TimelineEvent = { event_id: "branch-1", session_id: "session-1", leaf_id: "history-1", timestamp: 3, kind: "branch_summary", payload: "Branch summary", truncated: false };
  const html = renderList([{ kind: "event", event: compaction }, { kind: "event", event: branch }, { kind: "event", event: customEvent }]);
  expect(html).toContain("Compacted history");
  expect(html).toContain("Branch summary");
  expect(html).not.toContain("notice");
});

describe("turn presentation", () => {
  const scope = { session_id: "session-1", leaf_id: "history-1" };
  const user = (id: string, group: string, timestamp: number): TimelineEvent => ({ ...scope, event_id: id, message_id: id, group_id: group, timestamp, kind: "user", blocks: [{ type: "text", text: `Question ${id}` }], origin: "pwa", sender_ref: "me", delivery: "normal", status: "committed" });
  const answer = (id: string, group: string, timestamp: number): TimelineEvent => ({ ...scope, event_id: id, group_id: group, timestamp, kind: "assistant", blocks: [{ type: "text", text: `Answer ${id}` }], status: "complete" });
  const runEnd = (id: string, group: string, timestamp: number, status: "complete" | "interrupted" | "error" = "complete"): TimelineEvent => ({ ...scope, event_id: id, group_id: group, timestamp, kind: "run_end", status });
  const events = (...values: TimelineEvent[]) => values.map((event) => ({ kind: "event" as const, event }));

  test("shows the completion time once at the end of a finished turn without visible sender labels", () => {
    const finished = Date.UTC(2026, 0, 1, 9, 30);
    const html = renderList(events(user("u1", "g1", finished - 5000), answer("a1", "g1", finished - 1000), runEnd("r1", "g1", finished)), { hasEarlier: false });
    expect(html.match(/class="pwa-turn-meta"/g)).toHaveLength(1);
    expect(html).toMatch(/class="pwa-turn-meta"><time[^>]*dateTime="2026-01-01T09:30:00.000Z"/);
    expect(html).toMatch(/<span class="pwa-sr-only">You:<\/span>/);
    expect(html).toMatch(/<span class="pwa-sr-only">Pi:<\/span>/);
    expect(html).not.toMatch(/>Agent</);
    expect(html).not.toMatch(/pwa-message-label/);
  });

  test("marks interrupted turns and waits for run_end while Pi is still running", () => {
    const interrupted = renderList(events(user("u1", "g1", 1), answer("a1", "g1", 2), runEnd("r1", "g1", 3, "interrupted")), { hasEarlier: false });
    expect(interrupted).toContain("· Interrupted");
    const running = renderList(events(user("u1", "g1", 1), answer("a1", "g1", 2)), { hasEarlier: false, running: true });
    expect(running).not.toContain("pwa-turn-meta");
    const idle = renderList(events(user("u1", "g1", 1), answer("a1", "g1", 2)), { hasEarlier: false, running: false });
    expect(idle).not.toContain("pwa-turn-meta");
  });

  test.each([
    { label: "idle", running: false },
    { label: "history", running: true, isLive: false },
    { label: "later formal run", running: true, later: "formal" },
    { label: "later partial run", running: true, later: "partial" },
  ])("does not finish or group tools without run_end ($label)", ({ running, isLive, later }) => {
    const items: Parameters<typeof MessageList>[0]["items"] = events(
      user("u1", "group-1", 1), toolEvent,
      { ...toolEvent, event_id: "tool-2", tool_call_id: "tool-2", timestamp: 2 },
    );
    if (later === "formal") items.push(...events(user("u2", "g2", 3)));
    if (later === "partial") items.push({ kind: "partial", createdAt: 3, partial: {
      protocol_version: 2, type: "timeline_partial", ...scope, group_id: "g2", partial_id: "later:assistant:0", kind: "assistant", status: "delta", delta: "Next run",
    } });
    const html = renderList(items, { hasEarlier: false, running, isLive });
    expect(html).not.toContain("pwa-turn-meta");
    expect(html).not.toContain("pwa-tool-group");
    expect(html.match(/aria-label="Expand read tool"/g)).toHaveLength(2);
  });

  test("shows Pi is thinking only while running and before the turn has any output", () => {
    const waiting = renderList(events(user("u1", "g1", 1)), { hasEarlier: false, running: true });
    expect(waiting).toContain("Pi is thinking…");
    expect(renderList(events(user("u1", "g1", 1), answer("a1", "g1", 2)), { hasEarlier: false, running: true })).not.toContain("Pi is thinking…");
    expect(renderList(events(user("u1", "g1", 1)), { hasEarlier: false, running: false })).not.toContain("Pi is thinking…");
    expect(renderList(events(user("u1", "g1", 1)), { hasEarlier: false, running: true, isLive: false })).not.toContain("Pi is thinking…");
  });
});
