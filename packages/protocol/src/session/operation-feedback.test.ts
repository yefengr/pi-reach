import { describe, expect, test } from "vitest";
import { decodeClientFrameV2, decodeServerFrameV2, serverFrameTypes } from "./index.js";

const direct = { protocol_version: 2, target_channel_id: "channel", in_reply_to: "request" };
const model = { id: "model", name: "Model", provider: "provider", reasoning: true, context_window: 100, vision: false };

describe("operation feedback strict contract", () => {
  test("cancel requires its target run and rejects legacy target_id", () => {
    const frame = { protocol_version: 2, type: "cancel", id: "cancel", channel_id: "channel", session_id: "session", leaf_id: null };
    expect(() => decodeClientFrameV2(frame)).toThrow();
    expect(decodeClientFrameV2({ ...frame, group_id: "run" })).toHaveProperty("group_id", "run");
    expect(() => decodeClientFrameV2({ ...frame, group_id: "run", target_id: "old" })).toThrow();
  });
  test.each([
    { action: "model_set", model, thinking_level: "low" },
    { action: "thinking_set", thinking_level: "off" },
    { action: "thinking_set", thinking_level: "max" },
    { action: "session_new", session_id: "new-session" },
    ...["accepted", "completed", "cancelled"].map((phase) => ({ action: "session_compact", phase })),
  ])("validates action-specific success $action $phase", (fields) => {
    const frame = { ...direct, type: "action_ok", ...fields };
    expect(decodeServerFrameV2(frame)).toEqual(frame);
    for (const key of Object.keys(fields).filter((key) => key !== "action")) {
      const missing = { ...frame } as Record<string, unknown>;
      delete missing[key];
      expect(() => decodeServerFrameV2(missing)).toThrow();
    }
    expect(() => decodeServerFrameV2({ ...frame, extra: true })).toThrow();
    expect(() => decodeServerFrameV2({ ...direct, type: "action_ok", action: fields.action })).toThrow();
  });
  test("models list always carries actual thinking level", () => {
    const frame = { ...direct, type: "models_list", models: [model] };
    expect(() => decodeServerFrameV2(frame)).toThrow();
    expect(decodeServerFrameV2({ ...frame, thinking_level: "high" })).toHaveProperty("thinking_level", "high");
  });
  test("compaction activity is registered, broadcast-only, and carries no sensitive fields", () => {
    expect(serverFrameTypes.has("compaction_activity")).toBe(true);
    for (const status of ["running", "completed", "failed", "cancelled"]) {
      for (const reason of ["manual", "threshold", "overflow"]) {
        const frame = { protocol_version: 2, type: "compaction_activity", session_id: "session", leaf_id: null, status, reason };
        expect(decodeServerFrameV2(frame)).toEqual(frame);
        expect(() => decodeClientFrameV2(frame)).toThrow();
        for (const key of ["in_reply_to", "error", "summary", "target_channel_id"]) {
          expect(() => decodeServerFrameV2({ ...frame, [key]: "private" })).toThrow();
        }
      }
    }
  });
});
