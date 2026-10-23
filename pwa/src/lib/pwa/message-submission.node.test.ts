import { expect, test, vi } from "vitest";
import { PeerChannel } from "../pi-reach/peer-channel";
import type { RelayClient } from "../pi-reach/relay-client";
import type { AttachmentDescriptor } from "../pi-reach/protocol-v2/schema";
import { AttachmentComposer } from "./attachment-composer";
import { TimelineRuntime, type TimelineScope } from "./timeline-runtime";
import { attachmentRetryDecision, submitMessage, type AttachmentLease } from "./message-submission";

const scope: TimelineScope = { deviceId: "device", endpointId: "endpoint", runtimeInstanceId: "runtime", sessionId: "session", leafId: "leaf", selfSenderRef: "self", channelId: "channel" };
const attachment: AttachmentDescriptor = { attachment_id: "file", file_name: "file.txt", mime_type: "text/plain", byte_length: 3, sha256: "a".repeat(64) };
function setup() {
  const runtime = new TimelineRuntime(); runtime.setScope(scope);
  const relay = { on: vi.fn(() => () => {}), sendRoute: vi.fn(() => true) } as unknown as RelayClient;
  const channel = new PeerChannel({ relay, endpoint: scope, channelId: scope.channelId });
  const send = vi.spyOn(channel, "send");
  const input = { text: "draft", scope, channel, online: true, historyOpen: false, newSessionPending: false,
    runtime, capture: vi.fn(() => null), follow: vi.fn(), apply: vi.fn() };
  return { runtime, input, channel, send };
}

test.each(["offline", "history", "new-session", "no-scope", "no-channel", "closed", "target", "capacity", "validation"])("%s gate preserves the draft without establishing a message", (gate) => {
  const { input, runtime, channel, send } = setup();
  const overrides: Partial<Parameters<typeof submitMessage>[0]> = {};
  if (gate === "offline") overrides.online = false;
  if (gate === "history") overrides.historyOpen = true;
  if (gate === "new-session") overrides.newSessionPending = true;
  if (gate === "no-scope") overrides.scope = null;
  if (gate === "no-channel") overrides.channel = null;
  if (gate === "closed") channel.close();
  if (gate === "target") overrides.scope = { ...scope, sessionId: "other" };
  if (gate === "capacity") { overrides.runtime = new TimelineRuntime({ maxEntries: 1 }); overrides.runtime.setScope(scope); overrides.runtime.sendUser("existing"); }
  if (gate === "validation") overrides.text = "  ";
  let draft = input.text;
  const result = submitMessage({ ...input, ...overrides });
  if (result === "handled") draft = "";
  expect(result).toBe("not-handled");
  expect(draft).toBe("draft");
  // 容量门禁使用替换后的 runtime；确认它保留了原有消息且没有新建第二条。
  const targetRuntime = overrides.runtime ?? runtime;
  expect(targetRuntime.pendingItems).toHaveLength(gate === "capacity" ? 1 : 0);
  expect(send).not.toHaveBeenCalled();
  expect(input.follow).not.toHaveBeenCalled();
  expect(input.apply).not.toHaveBeenCalled();
});

test("an over-limit wire frame is discarded before ownership and keeps the draft", () => {
  const { input, runtime, send } = setup();
  const text = "a".repeat(2 * 1024 * 1024 + 1);
  const errors: unknown[] = [];
  let draft = text;
  const result = submitMessage({ ...input, text, onPrepareError: (error) => errors.push(error) });
  if (result === "handled") draft = "";
  expect(result).toBe("not-handled");
  expect(draft).toBe(text);
  expect(runtime.pendingItems).toEqual([]);
  expect(send).not.toHaveBeenCalled();
  expect(errors[0]).toMatchObject({ invalidPayload: true });
});

test("transport failure is handled once and retry preserves the logical ID and original bubble", () => {
  const { input, runtime, send } = setup();
  send.mockReturnValue(false);
  let draft = input.text;
  const result = submitMessage(input);
  if (result === "handled") draft = "";
  expect(result).toBe("handled");
  expect(draft).toBe("");
  expect(runtime.pendingItems).toHaveLength(1);
  const pending = runtime.pendingItems[0];
  expect(pending).toMatchObject({ text: "draft", delivery: "failed", deliveryFailure: { code: "transport_unavailable", retryable: true } });
  expect(input.follow).not.toHaveBeenCalled();
  expect(input.apply).toHaveBeenCalledTimes(2);
  const retried = runtime.retryFailed(pending.clientRequestId)!;
  expect(retried.frame.client_request_id).toBe(pending.clientRequestId);
  expect(retried.frame.id).not.toBe(send.mock.calls[0][0].id);
  expect(runtime.pendingItems).toEqual([pending]);
});

test("successful text and attachment sends return handled and only accepted transport activates follow", () => {
  const { input, runtime, send } = setup();
  expect(submitMessage(input)).toBe("handled");
  expect(submitMessage({ ...input, text: "", attachments: [attachment] })).toBe("handled");
  expect(runtime.pendingItems).toHaveLength(2);
  expect(runtime.pendingItems.every((pending) => pending.delivery === "pending" && !pending.deliveryFailure)).toBe(true);
  expect(send.mock.calls[1][0]).toMatchObject({ type: "user_message", text: "", attachment_ids: ["file"] });
  expect(send.mock.calls[1][0]).not.toHaveProperty("attachments");
  expect(input.capture).toHaveBeenCalledTimes(2);
  expect(input.follow).toHaveBeenCalledTimes(2);
});

test.each(["handled", "not-handled"] as const)("attachment ownership transfer only clears drafts on %s", (outcome) => {
  const { input, runtime, send } = setup();
  send.mockReturnValue(false);
  if (outcome === "not-handled") input.online = false;
  const composer = new AttachmentComposer({
    onChange: vi.fn(),
    onReady: (message) => submitMessage({ ...input, text: message.text, attachments: message.attachments }),
    createClient: (changed) => ({
      connect: () => changed({ status: "supported", uploadScope: "lease" }), disconnect: vi.fn(), receive: () => false,
      upload: async () => attachment, cancel: async () => {}, cancelAttachment: async () => {}, release: vi.fn(), dispose: vi.fn(),
    }),
  });
  composer.connect(scope, () => true);
  expect(composer.restoreAttachments([attachment])).toBe(true);
  expect(composer.start("caption", { draftKey: "draft", draftVersion: 1 })).toBe(true);
  expect(runtime.pendingItems).toHaveLength(outcome === "handled" ? 1 : 0);
  expect(composer.snapshot().items).toHaveLength(outcome === "handled" ? 0 : 1);
  if (outcome === "handled") expect(runtime.pendingItems[0]).toMatchObject({ text: "caption", attachments: [attachment], delivery: "failed" });
  else expect(composer.snapshot()).toMatchObject({ issue: "send_failed" });
  expect(input.follow).not.toHaveBeenCalled();
  composer.dispose();
});

test.each([
  ["checking click waits without a terminal failure", "A", { status: "checking" as const, uploadScope: "lease-a" }, "lease-a", "wait"],
  ["unknown capability waits", "A", { status: "unknown" as const }, "lease-a", "wait"],
  ["returning A→B→A with the original lease retries", "A", { status: "supported" as const, uploadScope: "lease-a" }, "lease-a", "retry"],
  ["composer still on another target is invalid", "B", { status: "supported" as const, uploadScope: "lease-b" }, "lease-a", "invalid"],
  ["a changed upload lease is invalid", "A", { status: "supported" as const, uploadScope: "lease-a2" }, "lease-a", "invalid"],
  ["a missing handoff lease is invalid", "A", { status: "supported" as const, uploadScope: "lease-a" }, null, "invalid"],
  ["an unsupported target is invalid", "A", { status: "unsupported" as const }, "lease-a", "invalid"],
] as const)("attachment retry decision: %s", (_name, composerTarget, capability, lease, expected) => {
  const leases = new Map<string, AttachmentLease>(lease ? [[attachment.attachment_id, { target: "A", uploadScope: lease }]] : []);
  expect(attachmentRetryDecision({ attachments: [attachment], target: "A", composer: { target: composerTarget, capability }, leases })).toBe(expected);
});
