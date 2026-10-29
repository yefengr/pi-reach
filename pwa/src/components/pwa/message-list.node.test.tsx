import { describe, expect, test, vi } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineEvent, TimelinePartial } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelinePending } from "@/lib/pwa/timeline-runtime";
import { MessageList } from "./message-list";
import { PwaUiProvider } from "./pwa-ui-provider";
import { thinkingSummary, thinkingTitle } from "./timeline-content";
import { setLanguagePreference } from "@/lib/i18n";

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

test("shows the earlier-records state that matches loading, failure and connection", () => {
  const items = [{ kind: "event" as const, event: toolEvent }];
  expect(renderList(items, { loadingEarlier: true })).toContain("aria-busy=\"true\"");
  const failed = renderList(items, { loadEarlierFailed: true });
  expect(failed).toContain("Couldn&#x27;t load earlier records");
  expect(failed).toContain("aria-label=\"Retry loading earlier records\"");
  const offline = renderList(items, { isLive: false });
  expect(offline).toContain("Connect to load earlier records");
  expect(offline).not.toContain("pwa-earlier-button");
  // 离线时失败重试无法生效，以连接说明为准。
  expect(renderList(items, { isLive: false, loadEarlierFailed: true })).toContain("Connect to load earlier records");
  // 只读历史的更早记录已在本地，不依赖连接。
  expect(renderList(items, { isLive: false, earlierLocal: true })).toContain("Load more");
});

test("keeps earlier and check actions alongside a collapsed tool group", () => {
  const html = renderList([{ kind: "event", event: toolEvent }, unknownPending], { onRetryFailed: () => {}, onCheckStatus: () => {} });
  const earlierButton = html.match(/<button[^>]*class="[^"]*pwa-earlier-button[^"]*"[^>]*>/)?.[0] ?? "";
  const groupToggle = html.match(/<button[^>]*aria-label="Expand Used tools 1 time"[^>]*>/)?.[0] ?? "";
  const checkAction = html.match(/<button[^>]*aria-label="Check status"[^>]*>/)?.[0] ?? "";

  expect(earlierButton).toMatch(/pwa-button/);
  expect(earlierButton).toMatch(/data-variant="default"/);
  // 单条工具也成组，默认收起，组内工具行此时不挂载。
  expect(groupToggle).toMatch(/aria-expanded="false"/);
  expect(groupToggle).toMatch(/aria-controls=/);
  expect(html).not.toContain("View read tool details");
  expect(html).not.toContain("pwa-activity");
  // 未确认的投递只提供图标核对入口，不与重试共用文字按钮。
  expect(checkAction).toMatch(/pwa-icon-button/);
  expect(checkAction).toMatch(/pwa-delivery-action/);
  expect(html).toContain("Not confirmed");
});

test("renders a delivery status row only for abnormal pending states", () => {
  const normal = renderList([{ ...unknownPending, delivery: "pending" }]);
  expect(normal).not.toContain("pwa-delivery-status");
  const failed = renderList([{ ...unknownPending, delivery: "failed", deliveryFailure: { code: "queue_full", retryable: true } }], { onRetryFailed: () => {} });
  expect(failed).toContain("pwa-delivery-status");
  expect(failed).toContain("queue is full");
  expect(failed.match(/<button[^>]*aria-label="Retry send"[^>]*>/)?.[0] ?? "").toMatch(/pwa-icon-button/);
  const permanent = renderList([{ ...unknownPending, delivery: "failed", deliveryFailure: { code: "invalid_target", retryable: false } }], { onRetryFailed: () => {} });
  expect(permanent).toContain("The original target is no longer available");
  expect(permanent).not.toContain("Retry send");
  const unsupported = renderList([{ ...unknownPending, statusQueryUnsupported: true }], { onCheckStatus: () => {} });
  expect(unsupported).toContain("Update the Pi extension to check status");
  expect(unsupported).not.toContain("Check status");
});

test.each(["en", "zh"] as const)("invalid attachment delivery asks to select files again in %s", (language) => {
  setLanguagePreference(language);
  try {
    const failed: TimelinePending = { ...unknownPending, delivery: "failed", deliveryFailure: { code: "invalid_target", retryable: false },
      attachments: [{ attachment_id: "old-file", file_name: "retained.txt", mime_type: "text/plain", byte_length: 4, sha256: "a".repeat(64) }] };
    const html = renderList([failed], { onRetryFailed: () => {}, onCheckStatus: () => {} });
    expect(html).toContain(language === "en" ? "Select the files again before sending" : "请重新选择文件后发送");
    expect(html).toContain("Retry me");
    expect(html).toContain("retained.txt");
    expect(html).not.toMatch(/aria-label="(?:Retry send|Check status|重试发送|核对状态)"/);
    const textOnly = renderList([{ ...failed, attachments: undefined }]);
    expect(textOnly).toContain(language === "en" ? "The original target is no longer available" : "原目标已不可用");
    expect(textOnly).not.toContain(language === "en" ? "Select the files again" : "重新选择文件");
  } finally { setLanguagePreference("en"); }
});

test("disables status checks while querying and explains offline recovery", () => {
  const querying = renderList([{ ...unknownPending, statusQuery: { requestId: "query", requestedAt: 1 } }], { onCheckStatus: () => {} });
  const checkButton = [...querying.matchAll(/<button[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes('aria-label="Check status"'))!;
  expect(checkButton).toContain("disabled");
  const offline = renderList([unknownPending], { isLive: false, onCheckStatus: () => {} });
  expect(offline).toContain("Reconnect to check status");
  expect(offline).not.toContain('aria-label="Check status"');
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

test("keeps failed tool details out of the conversation with a visible error status", () => {
  const event: TimelineEvent = { ...toolEvent, status: "error", error: "Permission denied", args: { path: "file.txt" }, result: [{ type: "text", text: "Readable text" }] };
  const html = renderList([{ kind: "event", event }]);
  expect(html).toContain("Read 1 file · 1 failed");
  expect(html).toContain("pwa-tool-group-alert");
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

test("summarizes running tools in the group header without mounting raw args", () => {
  // 分属不同轮次，各自成组；运行中的工具在折叠的组头显示自己的标题。
  const running = (tool: string, id: string, args: Extract<TimelinePartial, { kind: "tool" }>["args"]): TimelinePartial => ({
    protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1", group_id: `group-${id}`, kind: "tool", partial_id: `tool:${id}`, tool_call_id: id, tool, args, status: "running",
  });
  const html = renderList([
    { kind: "partial", createdAt: 0, partial: running("read", "read-1", { path: "src/components/pwa/message-list.tsx" }) },
    { kind: "partial", createdAt: 0, partial: running("bash", "bash-1", { command: "pnpm   test" }) },
    { kind: "partial", createdAt: 0, partial: running("grep", "search-1", { pattern: "ToolCard", path: "src" }) },
  ]);

  expect(html).toContain("src/components/pwa/message-list.tsx");
  expect(html).toContain("Expand read src/components/pwa/message-list.tsx · 1 running");
  expect(html).toContain("Expand bash pnpm   test · 1 running");
  expect(html).toContain("Expand grep ToolCard · 1 running");
  expect(html).toContain("pnpm   test");
  expect(html).toContain("ToolCard");
  expect(html).not.toContain("&quot;path&quot;");
  expect(html).not.toContain("&quot;command&quot;");
});

test("keeps streaming thinking collapsed independently of the tools", () => {
  const partial: TimelinePartial = {
    protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1",
    group_id: "group-1", partial_id: "thinking", kind: "thinking", status: "delta", delta: "Inspecting the request.\nFull reasoning stays collapsed.",
  };
  const html = renderList([{ kind: "partial", createdAt: 0, partial }]);

  expect(html).not.toContain('title="Thinking"');
  expect(html).toContain('<span class="pwa-sr-only" role="status"></span>');
  expect(html).toContain('<span title="Inspecting the request.">Inspecting the request.</span>');
  expect(html.indexOf("pwa-spin")).toBeLessThan(html.indexOf('title="Inspecting the request."'));
  expect(html).not.toContain("Full reasoning stays collapsed.");
  expect(html).not.toContain("pwa-text-plain");
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
  expect(html).toContain("Used tools 1 time");
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
  expect(html).toContain("Context compacted · View summary");
  expect(html).toContain("Branch summary created · View summary");
  expect(html).not.toContain("Compacted history");
  expect(html).not.toContain("notice");
});

test("summary and provider-error rows expose only safe reader entries", () => {
  const base = { event_id: "summary", session_id: "session", leaf_id: "leaf", timestamp: 1 };
  const html = renderList([
    { kind: "event", event: { ...base, kind: "compaction", payload: { summary: "ORIGINAL_BODY", details: "INTERNAL_DETAILS" }, truncated: false } },
    { kind: "event", event: { ...base, event_id: "error", kind: "provider_error", group_id: "group", message: "PRIVATE_TOKEN HTTP 429 <script>request body</script>" } },
  ]);
  expect(html).toContain("Context compacted · View summary");
  expect(html).toContain("Model service error");
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).not.toMatch(/ORIGINAL_BODY|INTERNAL_DETAILS|PRIVATE_TOKEN|429|request body/);
});

describe("attachment history presentation", () => {
  const attachment = { attachment_id: "file", file_name: "notes.txt", mime_type: "text/plain", byte_length: 1024, sha256: "a".repeat(64) };
  const user: Extract<TimelineEvent, { kind: "user" }> = { event_id: "message", message_id: "message", group_id: "group", session_id: "session-1", leaf_id: "user-leaf", timestamp: 2, kind: "user", blocks: [{ type: "text", text: "Server fallback notes.txt" }], sender_ref: "owner", origin: "pwa", delivery: "normal", status: "committed" };
  const metadata: TimelineEvent = { ...customEvent, event_id: "metadata", leaf_id: "metadata-leaf", payload: { custom_type: "pi-reach:attachments-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", text: "Original text", attachments: [attachment] } } };
  const binding: TimelineEvent = { ...customEvent, event_id: "binding", leaf_id: "binding-leaf", payload: { custom_type: "pi-reach:attachment-message-v1", data: { version: 1, client_request_id: "request", sender_ref: "owner", message_id: "message" } } };
  const items = (...events: TimelineEvent[]) => events.map(event => ({ kind: "event" as const, event }));

  test("uses metadata before custom filtering and across ordinary leaf changes", () => {
    const html = renderList(items(metadata, binding, user), { isLive: false });
    expect(html).toContain("Original text");
    expect(html).toContain("notes.txt");
    expect(html).toContain("pwa-attachment-card");
    expect(html).not.toContain("Server fallback");
    expect(html).not.toContain("pi-reach:attachments");
    expect(html).not.toContain("pwa-attachment-actions button");
    expect(html).not.toContain('aria-label="Remove');
  });

  test("falls back until metadata arrives and never borrows another session or sender", () => {
    expect(renderList(items(binding, user))).toContain("Server fallback");
    expect(renderList(items({ ...metadata, session_id: "other" }, binding, user))).toContain("Server fallback");
    expect(renderList(items(metadata, binding, { ...user, sender_ref: "other" }))).toContain("Server fallback");
  });

  test("renders attachment-only pending and preserves old image blocks", () => {
    const html = renderList([{ ...unknownPending, text: "", attachments: [attachment] }]);
    expect(html).toContain("notes.txt");
    expect(html).toContain("Not confirmed");
    const legacy = renderList(items({ ...user, blocks: [{ type: "image", mime_type: "image/png", data: "YQ==", byte_length: 1 }] }));
    expect(legacy).toContain("data:image/png;base64,YQ==");
    expect(legacy).not.toContain("pwa-attachment-cards");
  });
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
    expect(html).toMatch(/class="pwa-turn-meta"[^>]*><time[^>]*dateTime="2026-01-01T09:30:00.000Z"/);
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
  ])("groups tools but does not finish the turn without run_end ($label)", ({ running, isLive, later }) => {
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
    expect(html.match(/data-tool-group-size="2"/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("View read tool details");
  });

  test("uses Working immediately as a fallback behind specific live indicators", () => {
    const live = { hasEarlier: false, running: true };
    expect(renderList(events(user("u1", "g1", 1)), live)).toContain("Working…");
    // 已完成摘要与正文不自带运行指示，保留 Working；思考与工具自带旋转图标。
    expect(renderList([...events(user("u1", "g1", 1)), { kind: "event", event: { ...toolEvent, group_id: "g1" } }], live)).toContain("Working…");
    expect(renderList(events(user("u1", "g1", 1), answer("a1", "g1", 2)), live)).toContain("Working…");
    const streaming: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...scope, group_id: "g1", partial_id: "g1:assistant:0", kind: "assistant", status: "delta", delta: "Partial" };
    expect(renderList([...events(user("u1", "g1", 1)), { kind: "partial", createdAt: 2, partial: streaming }], live)).toContain("Working…");
    const thinking: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...scope, group_id: "g1", partial_id: "g1:thinking:0", kind: "thinking", status: "delta", delta: "Reasoning" };
    expect(renderList([...events(user("u1", "g1", 1)), { kind: "partial", createdAt: 2, partial: thinking }], live)).not.toContain("Working…");
    const tool: TimelinePartial = { protocol_version: 2, type: "timeline_partial", ...scope, group_id: "g1", partial_id: "tool:t1", kind: "tool", tool_call_id: "t1", tool: "bash", args: { command: "pnpm test" }, status: "running" };
    expect(renderList([...events(user("u1", "g1", 1)), { kind: "partial", createdAt: 2, partial: tool }], live)).not.toContain("Working…");
    // 首次渲染即有已完成队首和后续运行调用，组级图标也须接管 Working。
    const mixed = renderList([...events(user("u1", "g1", 1), { ...toolEvent, group_id: "g1" }), { kind: "partial", createdAt: 2, partial: tool }], live);
    expect(mixed).toContain("pwa-tool-spinner");
    expect(mixed).toContain("1 running");
    expect(mixed).not.toContain("Working…");
    // 旧轮、已结束轮的具体指示不能压制新轮兜底。
    const residuals = [{ kind: "partial" as const, createdAt: 2, partial: thinking }, { kind: "partial" as const, createdAt: 2, partial: tool }];
    expect(renderList([...events(user("u1", "g1", 1), user("u2", "g2", 3)), ...residuals], live)).toContain("Working…");
    expect(renderList([...events(user("u1", "g1", 1), runEnd("r1", "g1", 2), user("u2", "g2", 3)), ...residuals], live)).toContain("Working…");
    expect(renderList([...events(user("u1", "g1", 1), runEnd("r1", "g1", 3)), ...residuals], live)).not.toContain("Working…");
    // 本轮结束、Pi 空闲或断线时隐藏。
    expect(renderList(events(user("u1", "g1", 1), answer("a1", "g1", 2), runEnd("r1", "g1", 3)), live)).not.toContain("Working…");
    expect(renderList(events(user("u1", "g1", 1)), { hasEarlier: false, running: false })).not.toContain("Working…");
    expect(renderList(events(user("u1", "g1", 1)), { hasEarlier: false, running: true, isLive: false })).not.toContain("Working…");
  });
});

test.each([
  { text: "**First step**\nBody.\n**Latest step**\n**Unfinished", title: "Latest step" },
  { text: "\n \t\n  检查   工具\t分组  \nHidden body", title: "检查 工具 分组" },
  { text: "**", title: "Thinking…" },
  { text: "**Unfinished heading", title: "Thinking…" },
  { text: "*", title: "Thinking…" },
  { text: "", title: "Thinking…" },
  { text: "\n \t\n", title: "Thinking…" },
])("renders the live thinking title or running fallback in SSR ($title)", ({ text, title }) => {
  const partial: TimelinePartial = {
    protocol_version: 2, type: "timeline_partial", session_id: "session-1", leaf_id: "history-1",
    group_id: "group-1", partial_id: "thinking", kind: "thinking", status: "delta", delta: text,
  };
  const html = renderList([{ kind: "partial", createdAt: 0, partial }]);
  expect(html).toContain(`<span title="${title}">${title}</span>`);
  expect(html).toContain('<span class="pwa-sr-only" role="status"></span>');
  expect(html).toContain('aria-live="off"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("pwa-text-plain");
});

test.each([
  { name: "empty", text: "", visible: false },
  { name: "whitespace", text: " \t\n", visible: false },
  { name: "nonempty", text: "Completed reasoning without a heading.", visible: true },
])("renders static historical traces without changing readable thinking ($name)", ({ text, visible }) => {
  const event: TimelineEvent = {
    event_id: "historical-thinking", session_id: "session-1", leaf_id: "history-1",
    timestamp: 1, group_id: "group-1", kind: "assistant", status: "complete",
    blocks: [{ type: "thinking", text }, { type: "text", text: "Visible answer." }],
  };
  const html = renderList([{ kind: "event", event }], { isLive: false, running: false });
  expect(html).toContain("Visible answer.");
  expect(html).toContain(">Thinking<");
  expect(html.includes('title="Thinking"')).toBe(visible);
  expect(html.includes("pwa-thinking-trace")).toBe(!visible);
  expect(html.includes('aria-expanded="false"')).toBe(visible);
  expect(html).not.toContain("Thinking…");
  expect(html).not.toContain("pwa-thinking-live");
});

test("formal thinking retains the latest heading and an empty icon slot without a live status", () => {
  const event: TimelineEvent = {
    event_id: "historical-thinking", session_id: "session-1", leaf_id: "history-1", timestamp: 1,
    group_id: "group-1", kind: "assistant", status: "complete",
    blocks: [{ type: "thinking", text: "**First**\nBody\n**Latest**\n**Unfinished" }],
  };
  const html = renderList([{ kind: "event", event }], { isLive: false, running: false });
  expect(html).toContain('title="Latest"');
  expect(html).toContain("pwa-thinking-icon-slot");
  expect(html).not.toContain("pwa-spin");
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain('title="First"');
});

test("retains empty-only historical thinking without losing a trailing gap", () => {
  const first: TimelineEvent = {
    event_id: "first-empty", session_id: "session-1", leaf_id: "history-1", timestamp: 1,
    group_id: "group-1", kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: "" }],
  };
  const duplicate = { ...first, event_id: "duplicate-empty", timestamp: 2 };
  const html = renderList([{ kind: "event", event: first }, { kind: "event", event: duplicate }], {
    isLive: false, running: false, gapBefore: new Set(["duplicate-empty"]),
  });
  expect(html.match(/>Thinking</g)).toHaveLength(1);
  expect(html).not.toContain("Expand thinking");
  expect(html).not.toContain("No records to display.");
  const gap = "Some records in between";
  expect(html.includes(gap)).toBe(true);
  expect(html.indexOf(">Thinking<")).toBeLessThan(html.indexOf(gap));
});

describe("thinkingSummary", () => {
  test("does not split or normalize the remaining body after finding the first line", () => {
    const text = `\n \t\n First\t line \n${"Unused reasoning.\n".repeat(10_000)}`;
    const split = vi.spyOn(String.prototype, "split");
    const normalize = vi.spyOn(String.prototype, "replace");
    try {
      const summary = thinkingSummary(text);
      const calls = { summary, splits: split.mock.calls.length, normalizations: normalize.mock.calls.length };
      expect(calls).toEqual({ summary: "First line", splits: 0, normalizations: 1 });
    } finally {
      split.mockRestore();
      normalize.mockRestore();
    }
  });
  test("uses the first nonempty line and normalizes inline whitespace only", () => {
    expect(thinkingSummary("\n \t\n  Inspecting\t  the request.  \nLater line")).toBe("Inspecting the request.");
    expect(thinkingSummary("\r\n  检查　 工具分组 \r\n模型原文")).toBe("检查 工具分组");
    expect(thinkingSummary("**Unfinished heading")).toBe("**Unfinished heading");
    expect(thinkingSummary("An inline **bold** word.")).toBe("An inline **bold** word.");
  });
  test("has no summary before text arrives", () => {
    expect(thinkingSummary("")).toBeUndefined();
    expect(thinkingSummary(" \n\t\r\n")).toBeUndefined();
  });
});

describe("thinkingTitle", () => {
  const text = "**First step**\nSome reasoning.\n\n**Second step**\nMore reasoning.\nAn inline **bold** word stays text.";
  test("takes the latest whole-line bold heading both once finished and while streaming", () => {
    expect(thinkingTitle(text, false)).toBe("Second step");
    expect(thinkingTitle(text, true)).toBe("Second step");
  });
  test("ignores inline bold, an unclosed heading and text without headings", () => {
    expect(thinkingTitle("An inline **bold** word.", false)).toBeUndefined();
    expect(thinkingTitle("**First step**\n\n**Unfinished", true)).toBe("First step");
    expect(thinkingTitle("Plain reasoning.", true)).toBeUndefined();
  });
  test("keeps the model's original language", () => {
    expect(thinkingTitle("**检查工具分组规则**\n正文", false)).toBe("检查工具分组规则");
  });
});
