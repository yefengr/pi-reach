import { expect, test } from "vitest";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";
import type { TimelinePartial } from "../protocol/v2/index.js";
import { ToolLifecycleTracker, toolPartial, toolTimelineEvent } from "./tool_lifecycle.js";

const base = { event_id: "evt-1", session_id: "sess-1", leaf_id: null, timestamp: 1 };
const sourcePath = "/tmp/pi-reach/成果.txt";

function partial(id: string, tool: string, args: unknown, result?: unknown): TimelinePartial | null {
  const association = { groupId: "group-1", correlation: {}, tool, args: args as never };
  return toolPartial(id, association, { sessionId: "sess-1", leafId: null }, result);
}

test("hides publish_file arguments in successful and failed formal tool events", () => {
  const success = toolTimelineEvent(base, "group-1", {
    toolCallId: "call-file",
    toolName: PUBLISHED_FILE_TOOL_NAME,
    args: { path: sourcePath },
    content: [{ type: "text", text: "Published" }],
    isError: false,
  });
  expect(success).toMatchObject({
    kind: "tool",
    group_id: "group-1",
    tool_call_id: "call-file",
    tool: PUBLISHED_FILE_TOOL_NAME,
    args: {},
    status: "complete",
  });
  expect(JSON.stringify(success)).not.toContain(sourcePath);

  const failure = toolTimelineEvent(base, "group-1", {
    toolCallId: "call-file",
    toolName: PUBLISHED_FILE_TOOL_NAME,
    args: { path: sourcePath },
    isError: true,
    errorMessage: "Failed",
  });
  expect(failure).toMatchObject({ tool: PUBLISHED_FILE_TOOL_NAME, args: {}, status: "error", error: "Failed" });
  expect(JSON.stringify(failure)).not.toContain(sourcePath);
});

test("hides associated publish_file arguments even when the call carries them", () => {
  const event = toolTimelineEvent(
    base, "group-1",
    { toolCallId: "call-file", toolName: "ignored", content: [{ type: "text", text: "ok" }], isError: false },
    { tool: PUBLISHED_FILE_TOOL_NAME, args: { path: sourcePath, destination: "remote" } },
  );
  expect(event).toMatchObject({ tool: PUBLISHED_FILE_TOOL_NAME, args: {} });
  expect(JSON.stringify(event)).not.toContain(sourcePath);
});

test("keeps arguments for non publish_file tools unchanged", () => {
  const event = toolTimelineEvent(base, "group-1", {
    toolCallId: "call-read",
    toolName: "read",
    args: { path: "/tmp/pi-reach/notes.txt", limit: 20 },
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });
  expect(event).toMatchObject({ tool: "read", args: { path: "/tmp/pi-reach/notes.txt", limit: 20 } });
});

test("hides publish_file arguments in running and delta partials", () => {
  const running = partial("call-file", PUBLISHED_FILE_TOOL_NAME, { path: sourcePath });
  expect(running).toMatchObject({
    partial_id: "tool:call-file",
    group_id: "group-1",
    kind: "tool",
    tool: PUBLISHED_FILE_TOOL_NAME,
    args: {},
    status: "running",
  });
  expect(JSON.stringify(running)).not.toContain(sourcePath);

  const delta = partial("call-file", PUBLISHED_FILE_TOOL_NAME, { path: sourcePath }, {
    content: [{ type: "text", text: "snapshot" }],
  });
  expect(delta).toMatchObject({ status: "delta", args: {}, blocks: [{ type: "text", text: "snapshot" }] });
  expect(JSON.stringify(delta)).not.toContain(sourcePath);
});

test("keeps partial arguments for non publish_file tools", () => {
  const running = partial("call-read", "read", { path: "/tmp/pi-reach/notes.txt" });
  expect(running).toMatchObject({ tool: "read", args: { path: "/tmp/pi-reach/notes.txt" }, status: "running" });
});

test("retains original publish_file arguments in the in-memory tracker", () => {
  const tracker = new ToolLifecycleTracker<Record<string, never>>();
  tracker.indexAssistantContent(
    [{ type: "toolCall", id: "call-file", name: PUBLISHED_FILE_TOOL_NAME, arguments: { path: sourcePath } }],
    { groupId: "group-1", correlation: {} },
  );
  expect(tracker.get("call-file")).toMatchObject({ tool: PUBLISHED_FILE_TOOL_NAME, args: { path: sourcePath } });
  const started = tracker.start("call-file", PUBLISHED_FILE_TOOL_NAME, { path: sourcePath });
  expect(started).toMatchObject({ tool: PUBLISHED_FILE_TOOL_NAME, args: { path: sourcePath } });
});
