import { expect, test } from "vitest";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";
import { ToolLifecycleTracker, toolPartial, toolTimelineEvent } from "./tool_lifecycle.js";
import { toolSummary } from "./tool_summary.js";

const base = { event_id: "evt-1", session_id: "sess-1", leaf_id: null, timestamp: 1 };
const sourcePath = "/isolated-synthetic/private-source.txt";
const toolRef = { call_entry_id: "assistant-1", tool_call_id: "call-1" };

test("summary extraction never traverses unknown arguments or large body fields", () => {
  const args = { path: "notes.txt", get content(): never { throw new Error("body was traversed"); } };
  expect(toolSummary("write", args)).toEqual({ action: "write", path: "notes.txt" });
  expect(toolSummary("custom", args)).toEqual({ action: "other" });
  expect(toolSummary("bash", { command: "x".repeat(10000) }).command).toHaveLength(512);
});

test.each([false, true])("publish_file source paths never enter formal summaries (%s)", (isError) => {
  const event = toolTimelineEvent(base, "group-1", { toolCallId: "call-1", toolName: PUBLISHED_FILE_TOOL_NAME,
    args: { path: sourcePath }, content: "synthetic result", isError });
  expect(event).toMatchObject({ representation: "summary", summary: { action: "other" }, status: isError ? "error" : "complete" });
  for (const field of ["args", "result", "error", "truncated"]) expect(event).not.toHaveProperty(field);
  expect(JSON.stringify(event)).not.toContain(sourcePath);
});

test("tracker and partials only retain small summaries, not native objects", () => {
  const tracker = new ToolLifecycleTracker<Record<string, never>>();
  tracker.indexAssistantContent([{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.txt", content: "large".repeat(100000) } }],
    { groupId: "group-1", correlation: {}, callEntryId: "assistant-1" });
  const association = tracker.start("call-1", "write", { path: "a.txt" })!;
  expect(association).toMatchObject({ summary: { action: "write", path: "a.txt" }, toolRef });
  expect(association).not.toHaveProperty("args");
  const partial = toolPartial("call-1", association, { sessionId: "sess-1", leafId: null }, { content: "not inline" });
  expect(partial).toMatchObject({ representation: "summary", tool_ref: toolRef, status: "delta" });
  expect(partial).not.toHaveProperty("blocks");
  expect(partial).not.toHaveProperty("args");
});
