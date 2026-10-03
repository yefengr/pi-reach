import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { AttachmentStore } from "../attachments/store.js";
import type { ClientFrame } from "../protocol/v2/index.js";
import { TimelineRuntime } from "../timeline/runtime.js";
import { TimelineV2Service } from "../timeline/v2_service.js";
import { handleAttachmentFrame } from "./attachment_binding.js";

describe("attachment routing", () => {
  test("hello gate, real chunks/SHA, owner isolation and reconnect lease", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "reach-attachment-route-"));
    const store = new AttachmentStore({ rootDir: root, runtimeId: "runtime-test", minFreeBytes: 0 });
    const manager = SessionManager.inMemory(root);
    const create = () => new TimelineV2Service({ sessionManager: manager, senderRef: "owner-a", extensionVersion: "1",
      runtime: new TimelineRuntime(), onUserMessage: () => false });
    let service = create();
    const capabilities = () => ({ protocol_version: 2, type: "attachment_capabilities_request", id: "caps",
      channel_id: "channel", session_id: manager.getSessionId(), leaf_id: manager.getLeafId() } as const);
    try {
      expect(await handleAttachmentFrame(store, service, "owner-a", capabilities())).toMatchObject([{ code: "invalid_channel" }]);
      service.handle({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "channel" });
      const [caps] = await handleAttachmentFrame(store, service, "owner-a", capabilities());
      if (caps?.type !== "attachment_capabilities") throw new Error("missing capabilities");
      const common = { protocol_version: 2 as const, id: "request", channel_id: "channel",
        session_id: manager.getSessionId(), upload_scope: caps.upload_scope, upload_id: "upload" };
      const bytes = Buffer.alloc(64 * 1024, 123);
      expect(await handleAttachmentFrame(store, service, "owner-a", { ...common, type: "attachment_begin",
        file_name: "sample.bin", mime_type: "application/octet-stream", byte_length: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") })).toMatchObject([{ status: "receiving" }]);
      expect(await handleAttachmentFrame(store, service, "owner-b", { ...common, type: "attachment_status_request" })).toMatchObject([{ code: "not_found" }]);
      expect(await handleAttachmentFrame(store, service, "owner-a", { ...common, upload_scope: "wrong", type: "attachment_status_request" })).toMatchObject([{ code: "invalid_scope" }]);
      await handleAttachmentFrame(store, service, "owner-a", { ...common, type: "attachment_chunk", offset: 0, data_base64: bytes.toString("base64") });
      service = create();
      service.handle({ protocol_version: 2, type: "session_hello", id: "hello-again", channel_id: "channel" });
      manager.appendCustomEntry("test-leaf", {});
      expect(store.scopeFor(manager.getSessionId())).toBe(caps.upload_scope);
      expect(await handleAttachmentFrame(store, service, "owner-a", { ...common, type: "attachment_status_request" })).toMatchObject([{ received_bytes: bytes.length }]);
      const [finished] = await handleAttachmentFrame(store, service, "owner-a", { ...common, type: "attachment_finish" });
      if (finished?.type !== "attachment_state" || finished.status !== "complete") throw new Error("not complete");
      const [file] = store.resolve({ ownerId: "owner-a", sessionId: manager.getSessionId(), uploadScope: caps.upload_scope }, [finished.attachment.attachment_id]);
      expect(await readFile(file!.path)).toEqual(bytes);
      store.resetScope(manager.getSessionId());
      expect(await handleAttachmentFrame(store, service, "owner-a", { ...common, type: "attachment_status_request" })).toMatchObject([{ code: "invalid_scope" }]);
      expect(service.handle({ ...common, type: "attachment_cancel" } as ClientFrame)).toMatchObject([{ code: "unsupported_type" }]);
    } finally {
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
