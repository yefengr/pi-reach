import { describe, expect, test } from "vitest";
import {
  PAIRING_INVITE_TTL_MS,
  PAIR_TTL_MAX_MS,
  PAIR_TTL_MIN_MS,
  PROTOCOL_VERSION,
  decodeChallenge,
  decodeControlFrame,
  decodeRelayFrame,
  decodeRoute,
  decodeRoutePayload,
  encodeControlFrame,
  encodeRoutePayload,
  parseJson,
  type OwnerHelloFrame,
  type RouteFrame,
} from "./index.js";

const endpointId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const route: RouteFrame = {
  type: "route", purpose: "session", device_id: "device",
  endpoint_id: endpointId, runtime_instance_id: runtimeId, ct: "opaque payload",
};

describe("shared outer contract", () => {
  test("exports pairing TTL bounds for every consumer", () => {
    expect(PAIRING_INVITE_TTL_MS).toBe(300_000);
    expect(PAIR_TTL_MIN_MS).toBe(10_000);
    expect(PAIR_TTL_MAX_MS).toBe(300_000);
  });

  test("keeps outer routing opaque and rejects unknown fields or invalid identities", () => {
    expect(decodeRoute(route)).toEqual(route);
    expect(decodeRelayFrame(route)).toEqual({ kind: "route", route });
    for (const value of [null, [], { ...route, unknown: true }, { ...route, purpose: "legacy" },
      { ...route, endpoint_id: "not-a-uuid" }, { ...route, runtime_instance_id: "old" },
      { ...route, device_id: "" }, { ...route, source_owner_id: "" }, { ...route, target_owner_id: null }]) {
      expect(decodeRoute(value)).toBeUndefined();
    }
    expect(decodeRoutePayload(route)).toBeUndefined();
  });

  test("round-trips UTF-8 payloads without Node builtins", () => {
    const text = "共享协议🙂";
    const ct = encodeRoutePayload(text);
    expect(decodeRoutePayload({ ...route, ct })).toEqual(new TextEncoder().encode(text));
    expect(encodeRoutePayload(new TextEncoder().encode(text))).toBe(ct);
    expect(parseJson(new TextEncoder().encode('{"type":"route"}'))).toEqual({ type: "route" });
    expect(parseJson("not-json")).toBeUndefined();
  });

  test("accepts only a bounded version in the Relay info control", () => {
    const frame = { type: "relay_info", version: "1.2.3" };
    expect(decodeControlFrame(frame)).toEqual(frame);
    expect(decodeRelayFrame(frame)).toEqual({ kind: "control", frame });
    expect(decodeControlFrame({ ...frame, version: "v".repeat(256) })).toBeDefined();
    for (const value of [{ type: "relay_info" }, { ...frame, version: "" }, { ...frame, version: null },
      { ...frame, version: 1 }, { ...frame, version: "v".repeat(257) }, { ...frame, device_id: "device" },
      { ...frame, extra: true }]) {
      expect(decodeControlFrame(value)).toBeUndefined();
      expect(decodeRelayFrame(value)).toBeUndefined();
    }
  });

  test("preserves endpoint metadata and legacy daemon read compatibility", () => {
    for (const kind of ["interactive", "daemon"] as const) {
      const frame = { type: "endpoint_announced", device_id: "device", endpoint_id: endpointId,
        runtime_instance_id: runtimeId, metadata: { kind, name: "session" } };
      expect(decodeControlFrame(frame)).toEqual(frame);
      expect(decodeControlFrame({ ...frame, metadata: { ...frame.metadata, extra: true } })).toBeUndefined();
      expect(decodeControlFrame({ ...frame, metadata: { ...frame.metadata, name: null } })).toBeUndefined();
    }
  });

  test("keeps pairing target and error controls separate from session routing", () => {
    const frame = { type: "pairing_target", in_reply_to: "request", code: "ABCD2345", device_id: "device",
      endpoint_id: endpointId, runtime_instance_id: runtimeId };
    expect(decodeControlFrame(frame)).toEqual(frame);
    expect(decodeControlFrame({ ...frame, token: "legacy" })).toBeUndefined();
    for (const reason of ["unknown_code", "expired_code", "stale_target", "rate_limited"]) {
      const error = { type: "pairing_code_error", in_reply_to: "request", reason };
      expect(decodeControlFrame(error)).toEqual(error);
    }
    expect(decodeControlFrame({ type: "pairing_code_error", in_reply_to: "request", reason: "other" })).toBeUndefined();
  });

  test("preserves role-aware hello, challenge and control serialization", () => {
    const hello: OwnerHelloFrame = { type: "hello", protocol_version: PROTOCOL_VERSION, role: "owner", pubkey: "owner" };
    expect(hello.protocol_version).toBe(2);
    expect(decodeChallenge('{"type":"challenge","nonce":"AQID"}')).toEqual({ type: "challenge", nonce: "AQID" });
    expect(decodeChallenge({ type: "challenge", nonce: "!!!" })).toBeUndefined();
    expect(decodeChallenge({ type: "challenge", nonce: "AQID", extra: true })).toBeUndefined();
    const control = { type: "subscribe_endpoints" as const, device_ids: ["device"] };
    expect(JSON.parse(encodeControlFrame(control))).toEqual(control);
  });
});
