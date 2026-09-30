import { describe, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TimelinePartial } from "../protocol/v2/index.js";
import { TimelineRuntime, TIMELINE_MARKER, type Correlation } from "./runtime.js";

function userMessage(text: string, timestamp = 1): Record<string, unknown> {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp = 2): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  };
}

function assistantMessageWithThinking(text: string, thinking: string, timestamp = 2): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }, { type: "text", text }],
    stopReason: "stop",
    timestamp,
  };
}

function assistantToolMessage(
  calls: Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
  timestamp = 2,
): Record<string, unknown> {
  return {
    role: "assistant",
    content: calls,
    stopReason: "toolUse",
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    timestamp,
  };
}

function toolMessage(options: {
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  timestamp?: number;
} = {}): Record<string, unknown> {
  const isError = options.isError ?? false;
  return {
    role: "toolResult",
    content: [{ type: "text", text: isError ? "failed" : "ok" }],
    toolCallId: options.toolCallId ?? "tool-1",
    toolName: options.toolName ?? "read",
    isError,
    timestamp: options.timestamp ?? 3,
    ...(options.args === undefined ? {} : { args: options.args }),
  };
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function markerEntries(session: SessionManager): Array<Record<string, unknown> & { id: string }> {
  return session.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === TIMELINE_MARKER)
    .map((entry) => ({ id: entry.id, ...(entry.data as Record<string, unknown>) }));
}

describe("TimelineRuntime", () => {
  test("recovers oversized tool results without breaking the protocol string limit", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runtime.attach(session);
    const big = "A".repeat(1024 * 1024 + 8);
    session.appendMessage(userMessage("shot") as never);
    session.appendMessage(assistantToolMessage([{ type: "toolCall", id: "t1", name: "read", arguments: { note: big } }]) as never);
    session.appendMessage({
      ...toolMessage({ toolCallId: "t1" }),
      content: [{ type: "text", text: big }, { type: "image", mimeType: "image/png", data: big }],
    } as never);
    const tool = runtime.recover(session).find((event) => event.kind === "tool");
    expect(tool).toMatchObject({ status: "complete", truncated: true });
    const result = (tool as { result: Array<Record<string, unknown>> }).result;
    expect((result[0]!.text as string).length).toBe(1024 * 1024);
    expect(result[1]).toEqual({ type: "image", mime_type: "image/png", omitted: true, byte_length: Math.floor(big.length * 3 / 4) });
    expect(((tool as { args: { note: string } }).args.note).length).toBe(1024 * 1024);
  });

  test("binds ALS correlation to the message object and publishes a committed user event after persistence", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const started: unknown[] = [];
    const committed: unknown[] = [];
    const runtime = new TimelineRuntime({
      onStarted: (value) => started.push(value),
      onPublished: (event, correlation) => committed.push({ event, correlation }),
    });
    runtime.attach(session);
    runtime.onAgentStart();
    const message = userMessage("hello");
    const correlation: Correlation = {
      clientRequestId: "request-1",
      origin: "pwa",
      delivery: "normal",
      senderRef: "owner-1",
    };

    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(message, session));
    expect(runtime.getCorrelation(message)).toEqual(correlation);
    const [marker] = markerEntries(session);
    expect(marker).toMatchObject({
      version: 2,
      kind: "user",
      origin: "pwa",
      delivery: "normal",
      sender_ref: "owner-1",
    });
    expect(marker).not.toHaveProperty("event_id");
    expect(marker).not.toHaveProperty("message_id");
    expect(marker).not.toHaveProperty("client_request_id");
    expect(started).toEqual([
      expect.objectContaining({
        eventId: marker.id,
        groupId: marker.group_id,
        role: "user",
        correlation,
        blocks: [{ type: "text", text: "hello" }],
      }),
    ]);

    session.appendMessage(message as never);
    runtime.onMessageEnd(message, session);
    await nextMacrotask();

    const [event] = runtime.getPublishedEvents();
    expect(event).toMatchObject({
      kind: "user",
      event_id: marker.id,
      message_id: marker.id,
      origin: "pwa",
      delivery: "normal",
      sender_ref: "owner-1",
      status: "committed",
      leaf_id: session.getLeafId(),
      event_seq: 1,
    });
    expect(committed).toEqual([{ event, correlation }]);
  });

  test("uses target branch order for recovery and same-tick live publication", async () => {
    const session = SessionManager.inMemory(process.cwd());
    session.appendMessage(userMessage("legacy", 999) as never);
    session.appendCustomEntry("third-party:metadata", { order: 2 });
    const runtime = new TimelineRuntime();
    runtime.onAgentStart();

    const assistant = assistantMessage("first formal", 100);
    runtime.onMessageStart(assistant, session);
    session.appendMessage(assistant as never);
    runtime.onMessageEnd(assistant, session);

    const user = userMessage("second formal", 1);
    runtime.onMessageStart(user, session);
    session.appendMessage(user as never);
    runtime.onMessageEnd(user, session);
    await nextMacrotask();

    expect(runtime.recover(session).map((event) => [event.kind, event.event_seq])).toEqual([
      ["user", 1],
      ["custom", 2],
      ["assistant", 3],
      ["user", 4],
    ]);
    expect(runtime.getPublishedEvents().map((event) => event.event_seq)).toEqual([3, 4]);
    for (const published of runtime.getPublishedEvents()) {
      expect(runtime.recover(session).find((event) => event.event_id === published.event_id)).toEqual(published);
    }

    const later = assistantMessage("later formal", 0);
    runtime.onMessageStart(later, session);
    session.appendMessage(later as never);
    runtime.onMessageEnd(later, session);
    await nextMacrotask();
    expect(runtime.getPublishedEvents().map((event) => event.event_seq)).toEqual([3, 4, 5]);
    expect(runtime.recover(session).map((event) => event.event_seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("marks steer as unknown and preserves the same run group", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runtime.onAgentStart();
    const first = userMessage("first");
    const steer = userMessage("steer");
    const correlation: Correlation = { origin: "unknown", delivery: "unknown" };

    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(first, session));
    session.appendMessage(first as never);
    runtime.onMessageEnd(first, session);
    await nextMacrotask();
    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(steer, session));
    session.appendMessage(steer as never);
    runtime.onMessageEnd(steer, session);
    await nextMacrotask();
    const markers = markerEntries(session);
    expect(markers).toHaveLength(2);
    expect(markers[0]?.group_id).toBe(markers[1]?.group_id);
    expect(markers[0]).not.toHaveProperty("event_id");
    expect(markers[0]).not.toHaveProperty("message_id");
    expect(markers[0]).toMatchObject({ origin: "unknown", delivery: "unknown" });
    expect(runtime.getPublishedEvents().map((event) => event.kind)).toEqual(["user", "user"]);
  });

  test("publishes stable assistant and thinking partials without persisting them", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const partials: unknown[] = [];
    const runtime = new TimelineRuntime({
      onPartial: (partial, correlation) => partials.push({ partial, correlation }),
    });
    const correlation: Correlation = {
      clientRequestId: "request-stream",
      origin: "pwa",
      delivery: "normal",
      senderRef: "owner-stream",
    };
    const assistant = assistantMessage("");

    runtime.onAgentStart();
    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(assistant, session));
    const [marker] = markerEntries(session);
    const partialMessage = { ...assistant, content: [{ type: "text", text: "Hello" }] };
    runtime.onMessageUpdate({
      type: "message_update",
      message: partialMessage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: partialMessage },
    } as never, session);
    runtime.onMessageUpdate({
      type: "message_update",
      message: partialMessage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: partialMessage },
    } as never, session);
    runtime.onMessageUpdate({
      type: "message_update",
      message: partialMessage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: partialMessage },
    } as never, session);
    runtime.onMessageUpdate({
      type: "message_update",
      message: partialMessage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Plan", partial: partialMessage },
    } as never, session);

    expect(partials).toEqual([
      { partial: expect.objectContaining({ partial_id: `${marker.id}:assistant:0`, group_id: marker.group_id, kind: "assistant", status: "running" }), correlation },
      { partial: expect.objectContaining({ partial_id: `${marker.id}:assistant:0`, kind: "assistant", status: "delta", delta: "Hello", leaf_id: session.getLeafId() }), correlation },
      { partial: expect.objectContaining({ partial_id: `${marker.id}:thinking:1`, group_id: marker.group_id, kind: "thinking", status: "running" }), correlation },
      { partial: expect.objectContaining({ partial_id: `${marker.id}:thinking:1`, kind: "thinking", status: "delta", delta: "Plan" }), correlation },
    ]);
    expect(markerEntries(session)).toHaveLength(1);

    session.appendMessage(assistantMessageWithThinking("Hello", "Plan") as never);
    runtime.onMessageEnd(assistant, session);
    await nextMacrotask();
    const nextAssistant = assistantMessage("", 3);
    runtime.onMessageStart(nextAssistant, session);
    runtime.onMessageUpdate({
      type: "message_update",
      message: partialMessage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " late", partial: partialMessage },
    } as never, session);
    expect(partials).toHaveLength(4);
    expect(runtime.getPublishedEvents()).toContainEqual(expect.objectContaining({
      event_id: marker.id,
      group_id: marker.group_id,
      kind: "assistant",
      status: "complete",
      blocks: [{ type: "thinking", text: "Plan" }, { type: "text", text: "Hello" }],
    }));
  });

  test("uses projected block indices when tool calls precede streaming text and thinking", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const partials: TimelinePartial[] = [];
    const runtime = new TimelineRuntime({ onPartial: partial => partials.push(partial) });
    runtime.attach(session);
    runtime.onAgentStart();
    const message = { ...assistantMessage(""), content: [
      { type: "toolCall", id: "call", name: "read", arguments: {} },
      { type: "text", text: "After call" },
      { type: "thinking", thinking: "Next thought" },
    ] };
    const started = runtime.onMessageStart(message, session)!;
    for (const [type, contentIndex, delta] of [["text_delta", 1, "After call"], ["thinking_delta", 2, "Next thought"]] as const) {
      runtime.onMessageUpdate({ type: "message_update", message, assistantMessageEvent: { type, contentIndex, delta, partial: message } } as never, session);
    }
    expect(partials.map(partial => partial.partial_id)).toEqual([`${started.eventId}:assistant:0`, `${started.eventId}:thinking:1`]);
    session.appendMessage(message as never);
    runtime.onMessageEnd(message, session);
    await nextMacrotask();
    expect(runtime.getPublishedEvents()[0]).toMatchObject({ kind: "assistant", blocks: [{ type: "text", text: "After call" }, { type: "thinking", text: "Next thought" }] });
  });

  test("publishes stable tool lifecycle partials with JSON-safe args and snapshot blocks", () => {
    const session = SessionManager.inMemory(process.cwd());
    const otherSession = SessionManager.inMemory(process.cwd());
    const partials: Array<{ partial: TimelinePartial; correlation: Correlation }> = [];
    const runtime = new TimelineRuntime({
      onPartial: (partial, correlation) => partials.push({ partial, correlation }),
    });
    const correlation: Correlation = {
      clientRequestId: "request-tools",
      origin: "pwa",
      delivery: "normal",
      senderRef: "owner-tools",
    };
    const assistant = assistantMessage("");

    runtime.onAgentStart();
    runtime.runWithCorrelation(correlation, () => runtime.onMessageStart(assistant, session));
    const streamedAssistant = {
      ...assistant,
      content: [{ type: "toolCall", id: "call-live", name: "read", arguments: { path: "README.md", limit: 20 } }],
    };
    runtime.onMessageUpdate({
      type: "message_update",
      message: streamedAssistant,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: streamedAssistant.content[0],
        partial: streamedAssistant,
      },
    } as never, session);
    runtime.onToolExecutionStart({
      type: "tool_execution_start",
      toolCallId: "call-live",
      toolName: "read",
      args: { path: "README.md", limit: 20, unsupported: undefined },
    } as never, session);
    const [marker] = markerEntries(session);

    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "call-live",
      toolName: "read",
      args: { path: "README.md", limit: 20 },
      partialResult: {
        content: [
          { type: "text", text: "first snapshot" },
          { type: "image", data: "ignored", mimeType: "image/png" },
        ],
      },
    } as never, session);
    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "call-live",
      toolName: "read",
      args: {},
      partialResult: { content: [{ type: "image", data: "ignored", mimeType: "image/png" }] },
    } as never, session);
    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "call-live",
      toolName: "read",
      args: {},
      partialResult: { content: [{ type: "text", text: "replacement snapshot" }] },
    } as never, session);
    runtime.onToolExecutionEnd({
      type: "tool_execution_end",
      toolCallId: "call-live",
      toolName: "read",
      result: { content: [{ type: "text", text: "final snapshot" }] },
      isError: false,
    } as never, session);
    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "unknown-call",
      toolName: "read",
      args: {},
      partialResult: { content: [{ type: "text", text: "must be ignored" }] },
    } as never, session);
    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "call-live",
      toolName: "read",
      args: {},
      partialResult: { content: [{ type: "text", text: "wrong session" }] },
    } as never, otherSession);

    expect(partials).toEqual([
      {
        partial: expect.objectContaining({
          partial_id: "tool:call-live",
          group_id: marker?.group_id,
          kind: "tool",
          tool_call_id: "call-live",
          tool: "read",
          args: { path: "README.md", limit: 20, unsupported: null },
          status: "running",
        }),
        correlation,
      },
      {
        partial: expect.objectContaining({
          partial_id: "tool:call-live",
          status: "delta",
          blocks: [{ type: "text", text: "first snapshot" }],
        }),
        correlation,
      },
      {
        partial: expect.objectContaining({ partial_id: "tool:call-live", status: "delta", blocks: [] }),
        correlation,
      },
      {
        partial: expect.objectContaining({
          partial_id: "tool:call-live",
          status: "delta",
          blocks: [{ type: "text", text: "replacement snapshot" }],
        }),
        correlation,
      },
      {
        partial: expect.objectContaining({
          partial_id: "tool:call-live",
          status: "delta",
          blocks: [{ type: "text", text: "final snapshot" }],
        }),
        correlation,
      },
    ]);
    expect(partials.every(({ partial }) => partial.leaf_id === session.getLeafId())).toBe(true);
    expect(markerEntries(session)).toHaveLength(1);
    expect(runtime.getPublishedEvents().some((event) => event.kind === "tool")).toBe(false);

    runtime.resetSession(otherSession);
    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "call-live",
      toolName: "read",
      args: {},
      partialResult: { content: [{ type: "text", text: "after reset" }] },
    } as never, otherSession);
    expect(partials).toHaveLength(5);
  });

  test("splits oversized deltas without breaking surrogate pairs", () => {
    const session = SessionManager.inMemory(process.cwd());
    const partials: Array<{ delta?: string }> = [];
    const runtime = new TimelineRuntime({ onPartial: (partial) => partials.push(partial) });
    const assistant = assistantMessage("");
    const delta = `${"x".repeat(64 * 1024 - 1)}😀tail`;
    runtime.onAgentStart();
    runtime.onMessageStart(assistant, session);
    runtime.onMessageUpdate({
      type: "message_update",
      message: { ...assistant },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistant },
    } as never, session);

    expect(partials).toHaveLength(2);
    expect(partials.map((partial) => partial.delta).join("")).toBe(delta);
    expect(partials.every((partial) => (partial.delta?.length ?? 0) <= 64 * 1024)).toBe(true);
  });

  test("ignores streaming updates without an active assistant lane", () => {
    const session = SessionManager.inMemory(process.cwd());
    const otherSession = SessionManager.inMemory(process.cwd());
    const partials: unknown[] = [];
    const runtime = new TimelineRuntime({ onPartial: (partial) => partials.push(partial) });
    const assistant = assistantMessage("");
    const delta = (message: unknown, value: string) => ({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: value, partial: assistant },
    }) as never;

    runtime.attach(session);
    runtime.onMessageUpdate(delta(assistant, "before start"), session);
    runtime.onAgentStart();
    runtime.onMessageStart(assistant, session);
    runtime.onMessageUpdate(delta(userMessage("not assistant"), "ignored"), session);
    runtime.onMessageUpdate(delta(assistant, ""), session);
    runtime.onMessageUpdate(delta(assistant, "other session"), otherSession);

    expect(partials).toEqual([]);
  });

  test("maps assistant, provider errors, and tool messages into immutable formal events", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runtime.onAgentStart();
    const assistant = assistantMessage("answer");
    const providerError = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider failed",
      timestamp: 3,
    };
    const tool = toolMessage();
    runtime.onMessageStart(assistant, session);
    session.appendMessage(assistant as never);
    runtime.onMessageEnd(assistant, session);
    await nextMacrotask();
    runtime.onMessageStart(providerError, session);
    session.appendMessage(providerError as never);
    runtime.onMessageEnd(providerError, session);
    await nextMacrotask();
    runtime.onMessageStart(tool, session);
    session.appendMessage(tool as never);
    runtime.onMessageEnd(tool, session);
    await nextMacrotask();

    expect(runtime.getPublishedEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", status: "complete" }),
      expect.objectContaining({ kind: "provider_error", message: "provider failed" }),
      expect.objectContaining({ kind: "tool", status: "complete", result: expect.anything() }),
    ]));
  });

  test("preserves associated args for successful and failed formal tool events across agent_end", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const assistant = assistantToolMessage([
      { type: "toolCall", id: "call-success", name: "read", arguments: { path: "src/index.ts" } },
      { type: "toolCall", id: "call-error", name: "bash", arguments: { command: "exit 1" } },
    ]);

    runtime.onAgentStart();
    runtime.onMessageStart(assistant, session);
    session.appendMessage(assistant as never);
    runtime.onMessageEnd(assistant, session);
    runtime.onToolExecutionStart({
      type: "tool_execution_start",
      toolCallId: "call-success",
      toolName: "read",
      args: { path: "/resolved/src/index.ts" },
    } as never, session);
    runtime.onToolExecutionEnd({
      type: "tool_execution_end",
      toolCallId: "call-success",
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    } as never, session);
    expect(runtime.getPublishedEvents().some((event) => event.kind === "tool")).toBe(false);

    const success = toolMessage({
      toolCallId: "call-success",
      toolName: "fallback-success",
      args: { fallback: true },
      timestamp: 3,
    });
    runtime.onMessageStart(success, session);
    session.appendMessage(success as never);
    runtime.onMessageEnd(success, session);

    const failure = toolMessage({
      isError: true,
      toolCallId: "call-error",
      toolName: "fallback-error",
      args: { fallback: true },
      timestamp: 4,
    });
    runtime.onMessageStart(failure, session);
    session.appendMessage(failure as never);
    runtime.onMessageEnd(failure, session);

    const fallback = toolMessage({
      toolCallId: "call-fallback",
      toolName: "custom-tool",
      args: { retained: true },
      timestamp: 5,
    });
    runtime.onMessageStart(fallback, session);
    session.appendMessage(fallback as never);
    runtime.onMessageEnd(fallback, session);

    runtime.onAgentEnd();
    await nextMacrotask();

    expect(runtime.getPublishedEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tool",
        tool_call_id: "call-fallback",
        tool: "custom-tool",
        args: { retained: true },
        status: "complete",
      }),
    ]));
    const recovered = new TimelineRuntime().recover(session);
    expect(recovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_call_id: "call-success", args: { path: "src/index.ts" } }),
      expect.objectContaining({ tool_call_id: "call-error", args: { command: "exit 1" }, error: "failed" }),
      expect.objectContaining({ tool_call_id: "call-fallback", args: { retained: true } }),
    ]));
  });

  test("maps aborted assistant messages to interrupted timeline events", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "aborted",
      timestamp: 2,
    };
    runtime.onAgentStart();
    runtime.onMessageStart(assistant, session);
    session.appendMessage(assistant as never);
    runtime.onMessageEnd(assistant, session);
    await nextMacrotask();

    expect(runtime.getPublishedEvents()).toContainEqual(expect.objectContaining({
      kind: "assistant",
      status: "interrupted",
    }));
  });

  test("stops scanner at markers, hard boundaries, and role mismatch", () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const first = userMessage("first");
    runtime.onAgentStart();
    runtime.onMessageStart(first, session);
    const firstMarker = markerEntries(session)[0];
    session.appendCustomEntry("pi-reach:other", { ignored: true });
    const secondMarkerId = session.appendCustomEntry(TIMELINE_MARKER, {
      version: 2,
      group_id: "other-group",
      kind: "user",
      origin: "unknown",
      delivery: "unknown",
    });
    session.appendMessage(first as never);

    const recovered = runtime.recover(session);
    expect(recovered).toHaveLength(2);
    const recoveredUser = recovered.find((event) => event.kind === "user");
    expect(recoveredUser?.event_id).toBe(secondMarkerId);
    expect(firstMarker?.id).not.toBe(recoveredUser?.event_id);
    expect(recovered).toContainEqual(expect.objectContaining({
      kind: "custom",
      payload: { custom_type: "pi-reach:other", data: { ignored: true } },
    }));
  });

  test("recovers compaction and metadata custom entries and publishes branch summaries", () => {
    const session = SessionManager.inMemory(process.cwd());
    const firstKeptEntryId = session.appendMessage(userMessage("kept") as never);
    const compactionId = session.appendCompaction(
      "summary",
      firstKeptEntryId,
      123,
      { source: "test" },
      true,
    );
    const customId = session.appendCustomEntry("third-party:metadata", { value: 1 });
    const runtime = new TimelineRuntime();

    expect(runtime.recover(session)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_id: compactionId,
        kind: "compaction",
        leaf_id: session.getLeafId(),
        payload: expect.objectContaining({ summary: "summary", tokens_before: 123 }),
      }),
      expect.objectContaining({
        event_id: customId,
        kind: "custom",
        payload: { custom_type: "third-party:metadata", data: { value: 1 } },
      }),
    ]));

    session.branchWithSummary(firstKeptEntryId, "branch summary", { files: 2 }, false);
    const branchSummaryEntry = session.getBranch().at(-1)!;
    const branchSummary = runtime.publishSessionEntry(branchSummaryEntry, session);
    expect(branchSummary).toMatchObject({
      event_id: branchSummaryEntry.id,
      event_seq: 2,
      kind: "branch_summary",
      payload: expect.objectContaining({ summary: "branch summary", from_id: expect.any(String) }),
    });
  });

  test("recovers tool args from assistant toolCall blocks without retaining recovery-only associations", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const writer = new TimelineRuntime();
    const assistant = assistantToolMessage([
      { type: "toolCall", id: "call-recovered", name: "grep", arguments: { pattern: "TimelineRuntime", path: "src" } },
    ]);
    const tool = toolMessage({
      toolCallId: "call-recovered",
      toolName: "fallback-recovered",
      timestamp: 3,
    });

    writer.onAgentStart();
    writer.onMessageStart(assistant, session);
    writer.onMessageEnd(assistant, session);
    session.appendMessage(assistant as never);
    writer.onMessageStart(tool, session);
    writer.onMessageEnd(tool, session);
    session.appendMessage(tool as never);

    const partials: TimelinePartial[] = [];
    const runtime = new TimelineRuntime({ onPartial: (partial) => partials.push(partial) });
    const recovered = runtime.recover(session);
    expect(recovered).toContainEqual(expect.objectContaining({
      kind: "tool",
      tool_call_id: "call-recovered",
      tool: "grep",
      args: { pattern: "TimelineRuntime", path: "src" },
      status: "complete",
    }));
    expect(markerEntries(session)).toHaveLength(2);

    runtime.onToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: "call-recovered",
      toolName: "grep",
      args: {},
      partialResult: { content: [{ type: "text", text: "must not leak" }] },
    } as never, session);
    expect(partials).toEqual([]);
    await nextMacrotask();
  });

  test("keeps earlier tool arguments stable when a later turn reuses a call ID", () => {
    const session = SessionManager.inMemory(process.cwd());
    for (const path of ["first.txt", "second.txt"]) {
      session.appendMessage(assistantToolMessage([{ type: "toolCall", id: "reused", name: "read", arguments: { path } }]) as never);
      session.appendMessage(toolMessage({ toolCallId: "reused" }) as never);
    }
    const recovered = new TimelineRuntime().recover(session).filter((event) => event.kind === "tool");
    expect(recovered.map((event) => event.args)).toEqual([{ path: "first.txt" }, { path: "second.txt" }]);
  });

  test("does not publish deferred tool results after a session reset", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    const message = toolMessage();
    runtime.onMessageStart(message, session);
    session.appendMessage(message as never);
    runtime.onMessageEnd(message, session);
    runtime.resetSession(session);
    await nextMacrotask();
    expect(runtime.getPublishedEvents()).toEqual([]);
  });

  test("recovers an unmatched branch message with its entry id and does not guess a group root", () => {
    const session = SessionManager.inMemory(process.cwd());
    const messageId = session.appendMessage(userMessage("legacy") as never);
    const runtime = new TimelineRuntime();
    const [event] = runtime.recover(session);
    expect(event).toMatchObject({
      event_id: messageId,
      message_id: messageId,
      origin: "unknown",
      delivery: "unknown",
      group_id: `legacy:${session.getSessionId()}`,
    });
  });
});
