import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTACHMENT_MESSAGE_TYPE, ATTACHMENT_METADATA_TYPE, MAX_TEXT_CHARS } from "@pi-reach/protocol/session";
import { describe, expect, test, vi } from "vitest";
import { AttachmentStore } from "../attachments/store.js";
import { encodeServerFrameV2, type ClientFrame, type ServerFrame, type TimelineEvent } from "../protocol/v2/index.js";
import { AttachmentDelivery, MAX_ATTACHMENT_DELIVERY_BYTES, MAX_ATTACHMENT_DELIVERY_RECORDS } from "./attachment_delivery.js";
import { TimelineRuntime } from "./runtime.js";
import { UserDeliveryBinding, type UserDeliveryTarget } from "./user_delivery_binding.js";
import { TimelineV2Service } from "./v2_service.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("attachment delivery integration", () => {
  test("queue, marker ancestors, dense history, safe started and committed reconnect replay", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "reach-attachment-delivery-"));
    const store = new AttachmentStore({ rootDir: root, runtimeId: "runtime", minFreeBytes: 0 });
    const manager = SessionManager.inMemory(root);
    const adapter = new AttachmentDelivery(store);
    const published: TimelineEvent[] = [];
    const outbound: ServerFrame[] = [];
    const targets = new Map<string, UserDeliveryTarget>();
    let idle = false;
    let persist = true;
    let binding!: UserDeliveryBinding;
    const runtime = new TimelineRuntime({ prepareStarted: (started, manager, runtime) => adapter.started(started, manager, runtime),
      onStarted: (started) => binding.onStarted(started),
      onPublished: (event, correlation) => { published.push(event); binding.onPublished(event, correlation); } });
    const sendUserMessage = vi.fn((content: unknown) => {
      const message = { role: "user", content, timestamp: Date.now() };
      runtime.onMessageStart(message, manager);
      if (!persist) return;
      manager.appendMessage(message as never);
      runtime.onMessageEnd(message, manager);
    });
    binding = new UserDeliveryBinding({ isIdle: () => idle, canAcceptNormal: () => true,
      getPi: () => ({ sendUserMessage } as unknown as ExtensionAPI), getTimeline: () => runtime,
      getCurrentSessionId: () => manager.getSessionId(), getCurrentLeafId: () => manager.getLeafId(),
      findTarget: (ownerId) => targets.get(ownerId) ?? null, sendFrames: (_ownerId, frames) => outbound.push(...frames),
      prepareAttachment: (frame, ownerId) => adapter.prepare(frame, ownerId, manager, runtime),
      beforeSend: (correlation) => adapter.beforeSend(correlation, manager) });
    const create = () => {
      let service!: TimelineV2Service;
      service = new TimelineV2Service({ sessionManager: manager, senderRef: "owner", extensionVersion: "1", runtime,
        onAttachmentReplay: (frame) => adapter.replay(frame, "owner", manager, runtime),
        onUserMessage: (frame, correlation) => binding.submit(frame, correlation, { ownerId: "owner", service,
          sessionId: manager.getSessionId(), leafId: manager.getLeafId(), clientRequestId: frame.client_request_id }),
        onQueueSnapshot: () => binding.snapshot("owner", service),
        onQueuedMessageClear: (id) => binding.clearQueued("owner", service, id),
        onQueuedMessageSteer: (id) => binding.steerQueued("owner", service, id).kind });
      targets.set("owner", { service, sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
      service.handle({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "channel" });
      return service;
    };
    try {
      const scope = { ownerId: "owner", sessionId: manager.getSessionId(), uploadScope: store.scopeFor(manager.getSessionId()) };
      const bytes = Buffer.from("original");
      await store.begin(scope, { uploadId: "upload", fileName: "photo.png", mimeType: "image/png", byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
      await store.write(scope, "upload", 0, bytes);
      const file = (await store.finish(scope, "upload")).attachment!;
      const path = store.resolve(scope, [file.attachment_id])[0]!.path;
      let service = create();
      const frame = (request = "request"): Extract<ClientFrame, { type: "user_message" }> => ({ protocol_version: 2,
        type: "user_message", id: request, channel_id: "channel", leaf_id: manager.getLeafId(),
        client_request_id: request, text: "", attachment_ids: [file.attachment_id] });
      expect(service.handle(frame())).toMatchObject([{ status: "accepted" }, { items: [{ text: "photo.png" }] }]);
      expect(sendUserMessage).not.toHaveBeenCalled();
      // 未调用 Pi 的已准备记录可在断线清空旧 queue 后重新进入新 channel。
      binding.clearOwner("owner", service);
      service = create();
      expect(service.handle(frame())).toMatchObject([{ status: "accepted" }, { type: "queued_message_state" }]);
      idle = true;
      await tick(); await tick();
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage.mock.calls[0]![0]).toContain(path);
      expect(sendUserMessage.mock.calls[0]![0]).not.toEqual(expect.any(Array));
      const branch = manager.getBranch();
      expect(branch.map((entry) => entry.type === "custom" ? entry.customType : entry.type)).toEqual([
        ATTACHMENT_METADATA_TYPE, "pi-reach:timeline-v2", ATTACHMENT_MESSAGE_TYPE, "message",
      ]);
      const userEntry = branch.find((entry) => entry.type === "message")!;
      manager.branch(userEntry.id);
      const history = runtime.recover(manager);
      expect(history.map((event) => event.event_seq)).toEqual([1, 2, 3]);
      expect(published.map((event) => event.event_seq)).toEqual([1, 2, 3]);
      expect(JSON.stringify(history)).not.toContain(path);
      expect(JSON.stringify(outbound)).not.toContain(path);
      expect(history.at(-1)).toMatchObject({ kind: "user", blocks: [{ type: "text", text: "photo.png" }] });
      binding.clearOwner("owner", service);
      service = create();
      expect(service.handle(frame())).toMatchObject([{ status: "committed" }]);
      expect(service.handle({ ...frame(), text: "changed" })).toMatchObject([{ code: "invalid_message" }]);
      const withoutAttachments = frame();
      delete withoutAttachments.attachment_ids;
      expect(service.handle(withoutAttachments)).toMatchObject([{ code: "invalid_message" }]);
      expect(service.handle({ ...frame("steer"), streaming_behavior: "steer" })).toMatchObject([{ code: "invalid_message" }]);
      idle = false;
      service.handle(frame("clear-target"));
      expect(service.handle({ protocol_version: 2, type: "queued_message_clear", id: "clear", channel_id: "channel",
        session_id: manager.getSessionId(), leaf_id: manager.getLeafId(), target_id: "clear-target" })).toMatchObject([{ items: [] }]);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      service.handle(frame("steer-target"));
      expect(service.handle({ protocol_version: 2, type: "queued_message_steer", id: "steer-queue", channel_id: "channel",
        session_id: manager.getSessionId(), leaf_id: manager.getLeafId(), target_id: "steer-target" })).toMatchObject([{ items: [] }]);
      await tick();
      expect(sendUserMessage).toHaveBeenCalledTimes(2);
      expect(sendUserMessage.mock.calls[1]![0]).toContain(path);
      expect(service.handle(frame("steer-target"))).toMatchObject([{ status: "committed" }]);
      // 合法最大原文加清单仍可排队、started、recover；原文完整，所有展示无路径。
      const text = "x".repeat(MAX_TEXT_CHARS);
      const large = { ...frame("large"), text };
      const queued = service.handle(large);
      expect(queued).toMatchObject([{ status: "accepted" }, { items: [{ text }] }]);
      for (const response of queued) expect(() => encodeServerFrameV2(response)).not.toThrow();
      idle = true;
      await tick(); await tick();
      expect(sendUserMessage).toHaveBeenCalledTimes(3);
      expect(sendUserMessage.mock.calls[2]![0]).toContain(text);
      expect(sendUserMessage.mock.calls[2]![0]).toContain(path);
      const largeUser = runtime.recover(manager).filter((event) => event.kind === "user").at(-1)!;
      expect(largeUser.kind).toBe("user");
      if (largeUser.kind !== "user") throw new Error("missing user event");
      expect(largeUser.blocks.map((block) => block.type === "text" ? block.text : "").join("")).toBe(`${text}\nphoto.png`);
      expect(largeUser.blocks).toHaveLength(2);
      expect(JSON.stringify(largeUser)).not.toContain(path);
      for (const response of service.publishFrames(largeUser)) expect(() => encodeServerFrameV2(response)).not.toThrow();
      const largeStarted = outbound.filter((response) => response.type === "user_message_started").at(-1)!;
      expect(largeStarted.type).toBe("user_message_started");
      if (largeStarted.type !== "user_message_started") throw new Error("missing started event");
      expect(largeStarted.message.blocks.map((block) => block.type === "text" ? block.text.length : 0)).toEqual([MAX_TEXT_CHARS, 10]);
      expect(largeStarted.message.blocks.map((block) => block.type === "text" ? block.text : "").join("") === `${text}\nphoto.png`).toBe(true);
      expect(JSON.stringify(largeStarted).includes(path)).toBe(false);
      expect(() => encodeServerFrameV2(largeStarted)).not.toThrow();
      expect(adapter.replay({ ...large, leaf_id: manager.getLeafId() }, "owner", manager, runtime)).toMatchObject({ status: "committed" });
      const memory = adapter as unknown as { journal: Map<string, { heavy?: unknown; fingerprint: string }>; journalBytes: number };
      expect([...memory.journal.values()].every((record) => !record.heavy && record.fingerprint.length === 64)).toBe(true);
      expect(memory.journalBytes).toBeLessThan(16 * 1024);
      persist = false;
      expect(service.handle(frame("lost"))).toMatchObject([{ status: "accepted" }, { type: "queued_message_state" }]);
      await tick();
      binding.clearOwner("owner", service);
      service = create();
      expect(service.handle(frame("lost"))).toMatchObject([{ status: "unknown_delivery" }]);
      await tick();
      expect(sendUserMessage).toHaveBeenCalledTimes(4);
      // 丢正文时，已写 binding 不得冒充正式提交或越过未发布 marker。
      expect(published.filter((event) => event.kind === "user")).toHaveLength(3);
      expect(published.filter((event) => event.kind === "custom" && event.payload.custom_type === ATTACHMENT_MESSAGE_TYPE)).toHaveLength(3);
      await store.dispose();
      expect((await stat(path)).isFile()).toBe(true);
    } finally {
      binding.clearAll();
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("queue rejection flood releases heavy data, bounds journal and reuses native metadata", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "reach-attachment-budget-"));
    const store = new AttachmentStore({ rootDir: root, runtimeId: "budget", minFreeBytes: 0 });
    const manager = SessionManager.inMemory(root);
    const adapter = new AttachmentDelivery(store);
    const runtime = new TimelineRuntime();
    // 此测试只关心准入与清理，避免每次 append 重跑整条发布历史。
    const append = vi.spyOn(runtime, "appendDeferredCustom").mockImplementation((manager, type, data) => manager.appendCustomEntry(type, data));
    const sendUserMessage = vi.fn();
    let service!: TimelineV2Service;
    const binding = new UserDeliveryBinding({ isIdle: () => false, canAcceptNormal: () => true,
      getPi: () => ({ sendUserMessage } as unknown as ExtensionAPI), getTimeline: () => runtime,
      getCurrentSessionId: () => manager.getSessionId(), getCurrentLeafId: () => manager.getLeafId(),
      findTarget: () => ({ service, sessionId: manager.getSessionId(), leafId: manager.getLeafId() }), sendFrames: () => {},
      prepareAttachment: (frame, ownerId) => adapter.prepare(frame, ownerId, manager, runtime),
      beforeSend: (correlation) => adapter.beforeSend(correlation, manager) });
    service = new TimelineV2Service({ sessionManager: manager, senderRef: "owner", extensionVersion: "1", runtime,
      onAttachmentReplay: (frame) => adapter.replay(frame, "owner", manager, runtime),
      onUserMessage: (frame, correlation) => binding.submit(frame, correlation, { ownerId: "owner", service,
        sessionId: manager.getSessionId(), leafId: manager.getLeafId(), clientRequestId: frame.client_request_id }) });
    service.handle({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "channel" });
    try {
      const scope = { ownerId: "owner", sessionId: manager.getSessionId(), uploadScope: store.scopeFor(manager.getSessionId()) };
      await store.begin(scope, { uploadId: "file", fileName: "data.bin", mimeType: "application/octet-stream", byteLength: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        preview: { mime_type: "image/jpeg", data: Buffer.alloc(32768).toString("base64"), byte_length: 32768, width: 1, height: 1 } });
      const file = (await store.finish(scope, "file")).attachment!;
      const frame = (id: string, text = "x".repeat(1024)): Extract<ClientFrame, { type: "user_message" }> => ({ protocol_version: 2,
        type: "user_message", id, channel_id: "channel", client_request_id: id, text, leaf_id: manager.getLeafId(),
        attachment_ids: [file.attachment_id] });
      const memory = adapter as unknown as { journal: Map<string, { heavy?: unknown; fingerprint: string }>; journalBytes: number };
      // 完整正文/preview 在 append 前受 byte budget 约束，失败没有新增 native 记录。
      const held = [];
      for (let i = 0; i < 3; i++) held.push(adapter.prepare(frame(`big-${i}`, "x".repeat(MAX_TEXT_CHARS)), "owner", manager, runtime)!);
      expect(held.every(Boolean)).toBe(true);
      expect(adapter.prepare(frame("big-overflow", "x".repeat(MAX_TEXT_CHARS)), "owner", manager, runtime)).toBeNull();
      expect(append).toHaveBeenCalledTimes(3);
      expect(memory.journalBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_DELIVERY_BYTES);
      for (const prepared of held) prepared.payload.on_release();
      adapter.reset();
      append.mockClear();
      for (let i = 0; i < MAX_ATTACHMENT_DELIVERY_RECORDS; i++) {
        const input = frame(`flood-${i}`);
        expect(binding.submit(input, { origin: "pwa", delivery: "normal", senderRef: "owner", clientRequestId: input.client_request_id },
          { ownerId: "owner", service, sessionId: manager.getSessionId(), leafId: manager.getLeafId(), clientRequestId: input.client_request_id }))
          .toBe(i < 32 ? "queued" : "rejected");
      }
      expect(memory.journal.size).toBe(MAX_ATTACHMENT_DELIVERY_RECORDS);
      expect(memory.journalBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_DELIVERY_BYTES);
      expect([...memory.journal.values()].filter((record) => record.heavy)).toHaveLength(32);
      expect(service.handle(frame("overflow"))[0]).toMatchObject({ type: "protocol_error", code: "too_large" });
      expect(append).toHaveBeenCalledTimes(MAX_ATTACHMENT_DELIVERY_RECORDS);
      const repeat = adapter.prepare(frame("flood-40"), "owner", manager, runtime)!;
      expect(repeat).not.toBeNull();
      repeat.payload.on_release();
      expect(append).toHaveBeenCalledTimes(MAX_ATTACHMENT_DELIVERY_RECORDS);
      adapter.beforeSend({ origin: "pwa", delivery: "normal", senderRef: "owner", clientRequestId: "flood-0" }, manager);
      binding.clearQueued("owner", service);
      expect([...memory.journal.values()].every((record) => !record.heavy && record.fingerprint.length === 64)).toBe(true);
      expect(adapter.replay(frame("flood-0"), "owner", manager, runtime)).toEqual({ status: "unknown_delivery" });
      expect(adapter.prepare(frame("protected-overflow"), "owner", manager, runtime)).toBeNull();
      expect(sendUserMessage).not.toHaveBeenCalled();
      // 清理后旧请求可恢复 payload，不重复写 sidecar，也不解除可能已投递记录的保护。
      const restored = adapter.prepare(frame("flood-1"), "owner", manager, runtime)!;
      expect(restored.content.includes("data.bin")).toBe(true);
      restored.payload.on_release();
      expect(append).toHaveBeenCalledTimes(MAX_ATTACHMENT_DELIVERY_RECORDS);
    } finally {
      binding.clearAll();
      await store.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
