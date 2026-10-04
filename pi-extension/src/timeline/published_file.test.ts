import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import { afterEach, expect, test } from "vitest";
import { TimelineRuntime } from "./runtime.js";
import type { TimelineEvent, TimelinePartial } from "../protocol/v2/index.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "pi-reach-file-timeline-"));
  directories.push(path);
  const manager = SessionManager.create(path, path);
  const published: TimelineEvent[] = [];
  const partials: TimelinePartial[] = [];
  const runtime = new TimelineRuntime({ onPublished: (event) => published.push(event), onPartial: (partial) => partials.push(partial) });
  runtime.attach(manager);
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call-file", name: "publish_file", arguments: { path: join(path, "成果.txt") } }], stopReason: "toolUse", timestamp: 1 };
  runtime.onMessageStart(assistant, manager);
  runtime.onMessageEnd(assistant, manager);
  manager.appendMessage(assistant as never);
  return { path, manager, runtime, published, partials };
}
function addCustom(manager: SessionManager, path: string, groupId: string | null) {
  return manager.appendCustomEntry(PUBLISHED_FILE_TYPE, {
    source_path: join(path, "成果.txt"), file_name: "成果.txt", mime_type: "text/plain", byte_length: 0,
    tool_call_id: "call-file", ...(groupId ? { group_id: groupId } : {}),
  });
}
function result(id: string, isError = false) {
  return { role: "toolResult", toolCallId: "call-file", toolName: "publish_file", content: [{ type: "text", text: isError ? "Failed" : "Published" }], isError, details: { publication_id: id }, timestamp: 2 };
}
const task = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only durable confirmation appears in the same turn, after its tool and before agent_end", async () => {
  const { path, manager, runtime, published } = await fixture();
  const groupId = runtime.currentGroupId;
  const id = addCustom(manager, path, groupId);
  expect(runtime.recover(manager).some((event) => event.event_id === id)).toBe(false);
  const message = result(id);
  runtime.onMessageStart(message, manager);
  runtime.onMessageEnd(message, manager);
  await task();
  expect(published.some((event) => event.event_id === id)).toBe(false);
  manager.appendMessage(message as never);
  runtime.onTurnEnd(manager);
  await task();
  const events = runtime.recover(manager);
  expect(JSON.stringify(events)).not.toContain(join(path, "成果.txt"));
  const file = events.find((event) => event.event_id === id)!;
  expect(file).toMatchObject({ kind: "custom", group_id: groupId, payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: "成果.txt", tool_call_id: "call-file" } } });
  expect(JSON.stringify(file)).not.toContain("source_path");
  expect(JSON.stringify(file)).not.toContain(path);
  const tool = events.find((event) => event.kind === "tool")!;
  expect(file.event_seq).toBe(tool.event_seq + 1);
  expect(published.filter((event) => event.event_id === id)).toHaveLength(1);
  expect(published.find((event) => event.event_id === id)).toEqual(file);
  runtime.onTurnEnd(manager);
  await task();
  expect(published.filter((event) => event.event_id === id)).toHaveLength(1);
  const reloaded = SessionManager.open(manager.getSessionFile()!);
  const reloadedEvents = new TimelineRuntime().recover(reloaded);
  expect(reloadedEvents.map((event) => ({ id: event.event_id, seq: event.event_seq })))
    .toEqual(events.map((event) => ({ id: event.event_id, seq: event.event_seq })));
  expect(JSON.stringify(reloadedEvents)).not.toContain(join(path, "成果.txt"));
  const sessionText = await readFile(manager.getSessionFile()!, "utf8");
  expect(sessionText).toContain("source_path");
  expect(sessionText).toContain(join(path, "成果.txt"));
});

test("keeps the published file source path out of realtime tool partials while the native record keeps it", async () => {
  const { path, manager, runtime, partials } = await fixture();
  const args = { path: join(path, "成果.txt") };
  runtime.onToolExecutionStart({
    type: "tool_execution_start",
    toolCallId: "call-file",
    toolName: "publish_file",
    args,
  } as never, manager);
  runtime.onToolExecutionUpdate({
    type: "tool_execution_update",
    toolCallId: "call-file",
    toolName: "publish_file",
    args,
    partialResult: { content: [{ type: "text", text: "snapshot" }] },
  } as never, manager);
  const id = addCustom(manager, path, runtime.currentGroupId);
  const message = result(id);
  runtime.onMessageStart(message, manager);
  runtime.onMessageEnd(message, manager);
  manager.appendMessage(message as never);
  runtime.onTurnEnd(manager);
  await task();

  expect(partials.some((partial) => partial.status === "running")).toBe(true);
  expect(partials.some((partial) => partial.status === "delta")).toBe(true);
  expect(partials.every((partial) => JSON.stringify(partial).includes('"args":{}'))).toBe(true);
  expect(JSON.stringify(partials)).not.toContain(join(path, "成果.txt"));

  const sessionText = await readFile(manager.getSessionFile()!, "utf8");
  expect(sessionText).toContain("source_path");
  expect(sessionText).toContain(join(path, "成果.txt"));
});

test("a failed tool leaves its internal custom hidden in real-time and after reopening", async () => {
  const { path, manager, runtime, published } = await fixture();
  const id = addCustom(manager, path, runtime.currentGroupId);
  const message = result(id, true);
  runtime.onMessageStart(message, manager);
  runtime.onMessageEnd(message, manager);
  manager.appendMessage(message as never);
  runtime.onTurnEnd(manager);
  await task();
  expect(manager.getBranch().some((entry) => entry.id === id)).toBe(true);
  expect(published.some((event) => event.event_id === id)).toBe(false);
  const reloaded = SessionManager.open(manager.getSessionFile()!);
  expect(new TimelineRuntime().recover(reloaded).some((event) => event.event_id === id)).toBe(false);
});
