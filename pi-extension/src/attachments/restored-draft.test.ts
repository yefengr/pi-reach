import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import {
  ATTACHMENT_MAX_COUNT, decodeClientFrameV2, decodeServerFrameV2,
  encodeClientFrameTextV2, encodeServerFrameTextV2, type AttachmentDescriptor, type ClientFrame,
} from "@pi-reach/protocol/session";
import { AttachmentComposer, type AttachmentReadyMessage } from "../../../pwa/src/lib/pwa/attachment-composer.js";
import { AttachmentUploadClient } from "../../../pwa/src/lib/pwa/attachment-upload.js";
import { TimelineRuntime as PwaTimelineRuntime } from "../../../pwa/src/lib/pwa/timeline-runtime.js";
import { handleAttachmentFrame, isAttachmentFrame } from "../runtime/attachment_binding.js";
import { TimelineRuntime } from "../timeline/runtime.js";
import { TimelineV2Service } from "../timeline/v2_service.js";
import { AttachmentStore } from "./store.js";

async function setup() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "reach-restored-draft-"));
  const store = new AttachmentStore({ rootDir: root, runtimeId: "runtime", minFreeBytes: 0 });
  const manager = SessionManager.inMemory(root);
  const service = new TimelineV2Service({ sessionManager: manager, senderRef: "owner", extensionVersion: "1",
    runtime: new TimelineRuntime(), onUserMessage: () => false });
  service.handle({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "channel" });
  const scope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: manager.getSessionId(),
    selfSenderRef: "owner", channelId: "channel", leafId: manager.getLeafId() };
  const attachmentScope = { ownerId: "owner", sessionId: scope.sessionId, uploadScope: store.scopeFor(scope.sessionId) };
  const frames: ClientFrame[] = [];
  const composers: AttachmentComposer[] = [];
  const routed = new Set<Promise<void>>();
  const failures: unknown[] = [];
  function composer(ready: (message: AttachmentReadyMessage) => boolean) {
    const result = new AttachmentComposer({ onReady: ready, onChange: () => {}, createClient: (onCapabilityChange) => {
      const client = new AttachmentUploadClient({ onCapabilityChange, requestTimeoutMs: 10_000 });
      const send = (input: ClientFrame) => {
        const frame = decodeClientFrameV2(encodeClientFrameTextV2(input));
        frames.push(frame);
        if (!isAttachmentFrame(frame)) throw new Error("unexpected request kind");
        const task = handleAttachmentFrame(store, service, "owner", frame).then((replies) => {
          for (const reply of replies) client.receive(decodeServerFrameV2(encodeServerFrameTextV2(reply)));
        }).catch((error: unknown) => { failures.push(error); });
        routed.add(task);
        void task.finally(() => routed.delete(task));
        return true;
      };
      // connect 由 composer 统一执行，复用真实 uploader 和 strict 两向编解码。
      const connect = client.connect.bind(client);
      client.connect = (target) => connect(target, send);
      return client;
    } });
    composers.push(result);
    result.connect(scope, () => true);
    return result;
  }
  async function settle() {
    while (routed.size) await Promise.all([...routed]);
    expect(failures).toEqual([]);
  }
  async function close() {
    for (const item of composers) item.dispose();
    await settle();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  }
  return { store, attachmentScope, scope, frames, composer, settle, close };
}

const context = { draftKey: "draft", draftVersion: 1 };
const files = () => Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, index) =>
  new File([new Uint8Array([index, 123, 0])], `original-${index}.bin`, { type: "application/octet-stream" }));

test("ten handed-off originals can be restored on a fresh page, removed, and free actual store quota", async () => {
  const fixture = await setup();
  try {
    const handedOff: AttachmentDescriptor[][] = [];
    const timeline = new PwaTimelineRuntime();
    timeline.setScope(fixture.scope);
    const handoff = (message: AttachmentReadyMessage) => {
      const sent = timeline.sendUserWithAttachments(message.text, message.attachments,
        { clientRequestId: message.clientRequestId, requestId: crypto.randomUUID() });
      if (!sent) return false;
      expect(decodeClientFrameV2(encodeClientFrameTextV2(sent.frame))).toEqual(sent.frame);
      handedOff.push([...timeline.pendingItems.find((item) => item.clientRequestId === message.clientRequestId)!.attachments!]);
      return true;
    };
    const first = fixture.composer(handoff);
    await vi.waitFor(() => expect(first.snapshot().capability.status).toBe("supported"));
    expect(first.addFiles(files())).toBeNull();
    expect(first.start("", context)).toBe(true);
    await vi.waitFor(() => expect(handedOff).toHaveLength(1), { timeout: 10_000 });
    await fixture.settle();
    expect(first.snapshot().items).toHaveLength(0);
    const pending = timeline.pendingItems[0];
    const queue = { protocol_version: 2 as const, type: "queued_message_state" as const, session_id: fixture.scope.sessionId,
      leaf_id: fixture.scope.leafId, snapshot_id: "before-cancel", chunk_index: 0, final: true,
      items: [{ id: pending.clientRequestId, text: pending.text, sender_ref: "owner", editable: true, created_at: 1 }] };
    timeline.receive(decodeServerFrameV2(encodeServerFrameTextV2(queue)));
    const cancellation = timeline.actOnQueued(pending.clientRequestId, "cancel");
    expect(cancellation).not.toBeNull();
    expect(decodeClientFrameV2(encodeClientFrameTextV2(cancellation!.frame))).toMatchObject({ type: "queued_message_clear" });
    const cancelled = timeline.receive(decodeServerFrameV2(encodeServerFrameTextV2({ ...queue, snapshot_id: "after-cancel", items: [] })));
    const descriptors = cancelled.cancelledQueued![0].attachments!;
    expect(descriptors).toEqual(handedOff[0]);
    const paths = fixture.store.resolve(fixture.attachmentScope, descriptors.map((item) => item.attachment_id)).map((item) => item.path);
    expect(fixture.store.debugCounts().resources).toBe(10);
    first.dispose();
    const restored = fixture.composer(handoff);
    await vi.waitFor(() => expect(restored.snapshot().capability.status).toBe("supported"));
    expect(restored.restoreAttachments(descriptors)).toBe(true);
    for (const item of restored.snapshot().items) restored.remove(item.id);
    await fixture.settle();
    expect(fixture.frames.filter((frame) => frame.type === "attachment_discard")).toHaveLength(10);
    expect(fixture.frames.filter((frame) => frame.type === "attachment_cancel")).toHaveLength(0);
    expect(fixture.store.debugCounts()).toMatchObject({ resources: 0, attachments: 0 });
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(restored.addFiles(files())).toBeNull();
    expect(restored.start("", context)).toBe(true);
    await vi.waitFor(() => expect(handedOff).toHaveLength(2), { timeout: 10_000 });
    await fixture.settle();
    expect(handedOff[1]).toHaveLength(10);
    expect(fixture.store.debugCounts().resources).toBe(10);
  } finally { await fixture.close(); }
});

test("cancel intent keeps restored originals resendable and retained originals survive discard", async () => {
  const fixture = await setup();
  try {
    let handedOff: readonly AttachmentDescriptor[] = [];
    let accepted = true;
    const composer = fixture.composer((message) => { handedOff = message.attachments; return accepted; });
    await vi.waitFor(() => expect(composer.snapshot().capability.status).toBe("supported"));
    composer.addFiles(files().slice(0, 1));
    composer.start("", context);
    await vi.waitFor(() => expect(handedOff).toHaveLength(1), { timeout: 10_000 });
    const descriptor = handedOff[0];
    accepted = false;
    expect(composer.restoreAttachments(handedOff)).toBe(true);
    composer.start("not handed off", context);
    composer.cancelIntent();
    await fixture.settle();
    expect(fixture.store.resolve(fixture.attachmentScope, [descriptor.attachment_id])).toHaveLength(1);
    expect(fixture.frames.some((frame) => frame.type === "attachment_discard")).toBe(false);
    accepted = true;
    composer.start("retry", context);
    expect(composer.snapshot().items).toHaveLength(0);
    expect(fixture.frames.filter((frame) => frame.type === "attachment_begin")).toHaveLength(1);
    fixture.store.retain(fixture.attachmentScope, [descriptor.attachment_id]);
    const path = fixture.store.resolve(fixture.attachmentScope, [descriptor.attachment_id])[0].path;
    expect(composer.restoreAttachments(handedOff)).toBe(true);
    composer.remove(composer.snapshot().items[0].id);
    await fixture.settle();
    expect((await stat(path)).size).toBe(descriptor.byte_length);
    expect(fixture.store.resolve(fixture.attachmentScope, [descriptor.attachment_id])).toHaveLength(1);
    expect(fixture.store.debugCounts().resources).toBe(0);
  } finally { await fixture.close(); }
});
