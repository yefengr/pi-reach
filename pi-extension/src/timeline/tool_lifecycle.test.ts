import { expect, test } from "vitest";
import { PUBLISHED_FILE_TOOL_NAME } from "../files/publications.js";
import { recoverToolCalls, ToolLifecycleTracker, toolPartial, toolTimelineEvent } from "./tool_lifecycle.js";
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

test("summary paths inside the session cwd become relative while other paths stay as given", () => {
  const cwd = "/synthetic/project";
  const path = (value: string, base: string | null = cwd) => toolSummary("read", { path: value }, base ?? undefined).path;
  expect(path("/synthetic/project/src/a.ts")).toBe("src/a.ts");
  expect(path("/synthetic/project/..cache/a.ts")).toBe("..cache/a.ts");
  expect(path("/synthetic/project")).toBe(".");
  expect(path("/synthetic/project-old/a.ts")).toBe("/synthetic/project-old/a.ts");
  expect(path("/synthetic/other/a.ts")).toBe("/synthetic/other/a.ts");
  expect(path("src/a.ts")).toBe("src/a.ts");
  expect(path("/synthetic/project/src/a.ts", null)).toBe("/synthetic/project/src/a.ts");
  // 命令原样保留，不改写其中出现的路径。
  expect(toolSummary("bash", { command: "cat /synthetic/project/a.ts" }, cwd).command).toBe("cat /synthetic/project/a.ts");
});

test("live tracking and recovery both summarize paths relative to the session cwd", () => {
  const call = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/synthetic/project/src/a.ts" } };
  const tracker = new ToolLifecycleTracker<Record<string, never>>(() => "/synthetic/project");
  tracker.indexAssistantContent([call], { groupId: "group-1", correlation: {}, callEntryId: "assistant-1" });
  expect(tracker.get("call-1")?.summary).toEqual({ action: "read", path: "src/a.ts" });
  expect(tracker.start("call-1", "read", call.arguments)?.summary).toEqual({ action: "read", path: "src/a.ts" });
  const branch = [
    { type: "message", id: "assistant-1", message: { role: "assistant", content: [call] } },
    { type: "message", id: "result-1", message: { role: "toolResult", toolCallId: "call-1" } },
  ] as unknown as Parameters<typeof recoverToolCalls>[0];
  expect(recoverToolCalls(branch, "/synthetic/project").get("result-1")?.summary).toEqual({ action: "read", path: "src/a.ts" });
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
