import { describe, expect, it } from "vitest";
import { decodeClientFrameV2, decodeServerFrameV2, encodeClientFrameV2, encodeServerFrameV2 } from "./codec.js";
import type { ServerFrame } from "./frames.js";
import { SESSION_STATUS_MAX_EXTENSIONS } from "./session-status.js";

const request = { protocol_version: 2, type: "session_status_subscribe", id: "status-1", channel_id: "tab-a", session_id: "session", leaf_id: null } as const;
const item = { key: "example:ci", label: "CI", text: "Passed", section: "session" } as const;
const snapshot = {
  protocol_version: 2, type: "session_status", target_channel_id: "tab-a", session_id: "session", leaf_id: "next-tip",
  subscription_id: "status-1",
  status: {
    context: { tokens: null, window: 200_000, auto_compact: true, level: null },
    usage: { input: 10, output: 20, cache_read: 0, cache_write: 0, cost: 0.1, cache_hit_rate_session: null, cache_hit_rate_latest: null },
    branch: null, extensions: [item],
  },
} as const satisfies ServerFrame;

const withStatus = (patch: Record<string, unknown>) => ({ ...snapshot, status: { ...snapshot.status, ...patch } });

describe("session status frames", () => {
  it("round-trips a scoped subscribe and targeted snapshots without changing hello", () => {
    const first = { ...snapshot, in_reply_to: request.id };
    expect(decodeClientFrameV2(encodeClientFrameV2(request))).toEqual(request);
    expect(decodeServerFrameV2(encodeServerFrameV2(first))).toEqual(first);
    expect(decodeServerFrameV2(encodeServerFrameV2(snapshot))).toEqual(snapshot);
    expect(() => decodeServerFrameV2(request)).toThrow();
    expect(() => decodeClientFrameV2(snapshot)).toThrow();
    expect(() => decodeClientFrameV2({ protocol_version: 2, type: "session_hello", id: "hello", channel_id: "tab-a", session_status: 1 })).toThrow();
  });

  it.each([
    { ...snapshot, target_channel_id: undefined },
    { ...snapshot, session_id: undefined },
    { ...snapshot, leaf_id: undefined },
    { ...snapshot, subscription_id: undefined },
    { ...snapshot, in_reply_to: "other" },
    withStatus({ branch: "b".repeat(257) }),
    withStatus({ context: { tokens: -1, window: 200_000, auto_compact: true, level: "normal" } }),
    withStatus({ context: { tokens: 0, window: 0, auto_compact: true, level: "normal" } }),
    withStatus({ context: { tokens: 0, window: 200_000, auto_compact: true, level: null } }),
    withStatus({ context: { tokens: null, window: 200_000, auto_compact: true, level: "high" } }),
    withStatus({ context: { tokens: 0, window: 200_000, auto_compact: true, level: "normal", percent: 0 } }),
    withStatus({ usage: { ...snapshot.status.usage, cache_hit_rate_session: 101 } }),
    withStatus({ usage: { ...snapshot.status.usage, cache_hit_rate_latest: -1 } }),
    withStatus({ usage: { ...snapshot.status.usage, subscription: true } }),
    withStatus({ extensions: [{ ...item, key: "a".repeat(65) }] }),
    withStatus({ extensions: [{ ...item, label: "A".repeat(13) }] }),
    withStatus({ extensions: [{ ...item, text: "a".repeat(161) }] }),
    withStatus({ extensions: [{ ...item, section: "unknown" }] }),
    withStatus({ extensions: [{ ...item, tone: "neutral" }] }),
    withStatus({ extensions: Array.from({ length: SESSION_STATUS_MAX_EXTENSIONS + 1 }, (_, index) => ({ ...item, key: `${index}` })) }),
  ])("rejects invalid scope or payload %#", (invalid) => {
    expect(() => decodeServerFrameV2(invalid)).toThrow();
  });
});
