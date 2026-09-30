import { expect, test } from "vitest";
import { encodeBase64, encodeUtf8 } from "./encoding";
import { PeerChannel } from "./peer-channel";
import { decodeRoutePayload } from "./protocol";
import { decodeClientFrameV2 } from "./protocol-v2";
import type { RelayClient } from "./relay-client";
import type { RouteFrame } from "./types";

const endpoint = {
  deviceId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  endpointId: "11111111-1111-4111-8111-111111111111",
  runtimeInstanceId: "22222222-2222-4222-8222-222222222222",
};

class RelayMock {
  readonly ownerId = "owner";
  readonly sentRoutes: RouteFrame[] = [];
  private listener: ((route: RouteFrame) => void) | null = null;

  on(_event: "route", listener: (route: RouteFrame) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  sendRoute(route: RouteFrame): boolean { this.sentRoutes.push(route); return true; }
  emit(route: RouteFrame): void { this.listener?.(route); }
}

function route(purpose: "pairing" | "session", frame: unknown): RouteFrame {
  return {
    type: "route",
    purpose,
    device_id: endpoint.deviceId,
    endpoint_id: endpoint.endpointId,
    runtime_instance_id: endpoint.runtimeInstanceId,
    target_owner_id: "owner",
    ct: encodeBase64(encodeUtf8(JSON.stringify(frame)), "standard"),
  };
}

test("encodes large client frames without overflowing the call stack", () => {
  const relay = new RelayMock();
  const malformed: string[] = [];
  const channel = new PeerChannel({
    relay: relay as unknown as RelayClient,
    endpoint,
    channelId: "channel-1",
    onMalformed: (reason) => malformed.push(reason),
  });
  const imageData = "A".repeat(256 * 1024);

  expect(channel.send({
    protocol_version: 2,
    type: "user_message",
    id: "message-1",
    channel_id: "channel-1",
    session_id: "session-1",
    leaf_id: "generation-1",
    client_request_id: "request-1",
    text: "describe this image",
    images: [{ data: imageData, mime: "image/png" }],
  })).toBe(true);

  expect(malformed).toEqual([]);
  expect(relay.sentRoutes).toHaveLength(1);
  const payload = decodeRoutePayload(relay.sentRoutes[0]!);
  expect(payload).toBeDefined();
  const decoded = decodeClientFrameV2(payload!);
  expect(decoded.type).toBe("user_message");
  if (decoded.type !== "user_message") throw new Error("Expected a user_message frame");
  expect(decoded.images?.[0]?.data).toBe(imageData);
  channel.close();
});

test("rejects pairing-purpose routes carrying session frames", () => {
  const relay = new RelayMock();
  const received: string[] = [];
  const channel = new PeerChannel({
    relay: relay as unknown as RelayClient,
    endpoint,
    channelId: "channel-1",
    onFrame: (frame) => received.push(frame.type),
  });
  const pong = {
    protocol_version: 2,
    type: "pong",
    target_channel_id: "channel-1",
    in_reply_to: "ping-1",
  };

  relay.emit(route("pairing", pong));
  expect(received).toEqual([]);
  relay.emit(route("session", pong));
  expect(received).toEqual(["pong"]);
  channel.close();
});

test("rejects corrupt UTF-8 server payloads while accepting valid Unicode text", () => {
  const relay = new RelayMock();
  const received: unknown[] = [];
  const malformed: string[] = [];
  const channel = new PeerChannel({
    relay: relay as unknown as RelayClient,
    endpoint,
    channelId: "channel-1",
    onFrame: (frame) => received.push(frame),
    onMalformed: (reason) => malformed.push(reason),
  });
  const frame = {
    protocol_version: 2, type: "protocol_error", target_channel_id: "channel-1",
    in_reply_to: "request", code: "protocol_upgrade_required", message: "X",
  };
  const payload = encodeUtf8(JSON.stringify(frame));
  payload[payload.indexOf(0x58)] = 0xff;
  relay.emit({ ...route("session", frame), ct: encodeBase64(payload, "standard") });
  expect(received).toEqual([]);
  expect(malformed).toHaveLength(1);
  expect(malformed[0]).toContain("UTF-8");

  const valid = { ...frame, message: "中文�🙂" };
  relay.emit(route("session", valid));
  expect(received).toEqual([valid]);
  channel.close();
});

test("does not send or process routes after closing", () => {
  const relay = new RelayMock();
  const received: string[] = [];
  const channel = new PeerChannel({
    relay: relay as unknown as RelayClient,
    endpoint,
    channelId: "channel-1",
    onFrame: (frame) => received.push(frame.type),
  });
  const pong = {
    protocol_version: 2,
    type: "pong",
    target_channel_id: "channel-1",
    in_reply_to: "ping-1",
  };

  channel.close();
  channel.close();
  expect(channel.closed).toBe(true);
  expect(channel.send({ protocol_version: 2, type: "list_models", id: "models-1", channel_id: "channel-1", session_id: "session-1", leaf_id: "generation-1" })).toBe(false);
  relay.emit(route("session", pong));
  expect(relay.sentRoutes).toEqual([]);
  expect(received).toEqual([]);
});
