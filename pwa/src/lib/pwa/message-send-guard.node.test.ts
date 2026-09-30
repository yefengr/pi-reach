import { expect, test } from "vitest";
import { isCurrentMessageSendIntent, type MessageSendChannel } from "./message-send-guard";
import type { TimelineScope } from "./timeline-runtime";

const scope: TimelineScope = {
  deviceId: "device-1",
  endpointId: "endpoint-1",
  runtimeInstanceId: "runtime-1",
  sessionId: "session-1",
  leafId: "history-1",
  selfSenderRef: "sender-1",
  channelId: "channel-1",
};
const channel: MessageSendChannel = { closed: false };
const intent = { generation: 4, channel, scope };

function matches(currentScope: TimelineScope | null, overrides: { generation?: number; channel?: MessageSendChannel | null; online?: boolean; historyMode?: boolean } = {}): boolean {
  return isCurrentMessageSendIntent(intent, {
    generation: overrides.generation ?? 4,
    channel: overrides.channel === undefined ? channel : overrides.channel,
    scope: currentScope,
    online: overrides.online ?? true,
    historyMode: overrides.historyMode ?? false,
  });
}

test("requires the complete click-time live scope before an awaited message can send", () => {
  expect(matches(scope)).toBe(true);
  expect(matches({ ...scope, deviceId: "device-2" })).toBe(false);
  expect(matches({ ...scope, endpointId: "endpoint-2" })).toBe(false);
  expect(matches({ ...scope, runtimeInstanceId: "runtime-2" })).toBe(false);
  expect(matches({ ...scope, sessionId: "session-2" })).toBe(false);
  expect(matches({ ...scope, leafId: "history-2" })).toBe(false);
  expect(matches({ ...scope, selfSenderRef: "sender-2" })).toBe(false);
  expect(matches({ ...scope, channelId: "channel-2" })).toBe(false);
});

test("rejects an awaited message after disconnect, channel replacement, or history navigation", () => {
  expect(matches(scope, { generation: 5 })).toBe(false);
  expect(matches(scope, { channel: { closed: false } })).toBe(false);
  expect(matches(scope, { online: false })).toBe(false);
  expect(matches(scope, { historyMode: true })).toBe(false);
  expect(matches(scope, { channel: { closed: true } })).toBe(false);
  expect(matches(null)).toBe(false);
});
