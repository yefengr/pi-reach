import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PUBLISHED_FILE_TYPE } from "@pi-reach/protocol/session";
import { afterEach, expect, test } from "vitest";
import { TimelineRuntime } from "../timeline/runtime.js";
import { TimelineV2Service } from "../timeline/v2_service.js";
import type { OwnerBinding } from "./create_owner_binding.js";
import { FileBinding } from "./file_binding.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pi-reach-file-binding-")));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  const manager = SessionManager.create(path, path);
  manager.appendMessage({ role: "assistant", content: [], timestamp: 1 } as never);
  const source = join(path, "report.txt");
  await writeFile(source, "original");
  const publication = manager.appendCustomEntry(PUBLISHED_FILE_TYPE, {
    source_path: source, file_name: "report.txt", mime_type: "text/plain", byte_length: 8, tool_call_id: "publish-call",
  });
  manager.appendMessage({ role: "toolResult", toolName: "publish_file", toolCallId: "publish-call", isError: false,
    content: [{ type: "text", text: "Published" }], details: { publication_id: publication }, timestamp: 2 } as never);
  const bindings = new Map<string, OwnerBinding>();
  for (const ownerId of ["owner-a", "owner-b"]) {
    const service = new TimelineV2Service({ sessionManager: manager, senderRef: ownerId,
      extensionVersion: "test", runtime: new TimelineRuntime() });
    bindings.set(ownerId, { service, channel: {} as never, sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
  }
  const files = new FileBinding({ runtimeId: "runtime", getManager: () => manager, getBinding: (owner) => bindings.get(owner) });
  cleanup.push(() => files.reader.dispose());
  const hello = (owner: string, channel: string) => bindings.get(owner)!.service.handle({ protocol_version: 2, type: "session_hello", id: `hello-${channel}`, channel_id: channel });
  const open = (channel: string, id = "open", session = manager.getSessionId()) => ({ protocol_version: 2 as const, type: "file_open" as const, id, channel_id: channel, session_id: session, publication_id: publication });
  return { files, bindings, manager, hello, open };
}

test("native channel/session gate stays protocol_error while two permitted Owners can open", async () => {
  const { files, bindings, hello, open } = await fixture();
  const a = bindings.get("owner-a")!;
  expect(await files.handle(open("a"), "owner-a", a)).toMatchObject([{ type: "protocol_error", code: "invalid_channel" }]);
  hello("owner-a", "a"); hello("owner-b", "b");
  expect(await files.handle(open("a", "stale", "other-session"), "owner-a", a)).toMatchObject([{ type: "reset", reason: "session_replaced" }]);
  expect(await files.handle(open("a"), "owner-a", a)).toMatchObject([{ type: "file_opened", target_channel_id: "a" }]);
  expect(await files.handle(open("b"), "owner-b", bindings.get("owner-b")!)).toMatchObject([{ type: "file_opened", target_channel_id: "b" }]);
});

test("ordinary leaf append survives, cross-channel transfer does not; explicit branch reset invalidates", async () => {
  const { files, bindings, manager, hello, open } = await fixture();
  const binding = bindings.get("owner-a")!;
  hello("owner-a", "a"); hello("owner-a", "other");
  const [opened] = await files.handle(open("a"), "owner-a", binding);
  if (opened?.type !== "file_opened") throw new Error("open failed");
  manager.appendCustomEntry("unrelated", {});
  const read = { protocol_version: 2 as const, type: "file_read" as const, id: "read", channel_id: "a", session_id: manager.getSessionId(), transfer_id: opened.transfer_id, offset: 0 };
  expect(await files.handle({ ...read, channel_id: "other" }, "owner-a", binding)).toMatchObject([{ type: "file_error", code: "invalid_transfer" }]);
  expect(await files.handle(read, "owner-a", binding)).toMatchObject([{ type: "file_chunk", final: true, total_bytes: 8 }]);
  const [second] = await files.handle(open("a", "second-open"), "owner-a", binding);
  if (second?.type !== "file_opened") throw new Error("open failed");
  files.invalidate();
  expect(await files.handle({ ...read, transfer_id: second.transfer_id }, "owner-a", binding)).toMatchObject([{ type: "file_error", code: "invalid_transfer" }]);
});
