import { describe, expect, it } from "vitest";
import { decodeClientFrameV2, decodeServerFrameV2, encodeServerFrameV2 } from "./codec.js";
import { MAX_TOOL_DETAILS_BYTES, MAX_TOOL_SUMMARY_BYTES, timelineEventSchema, timelinePartialSchema, toolDetailsContentSchema, toolSummarySchema } from "./schema.js";

const toolRef = { call_entry_id: "assistant-marker", tool_call_id: "tool-call" };
const scope = { protocol_version: 2, session_id: "session", leaf_id: "leaf" };
const summary = { event_id: "event", event_seq: 2, session_id: "session", leaf_id: "leaf", timestamp: 1, group_id: "group", kind: "tool", tool: "bash", tool_call_id: "tool-call", representation: "summary", summary: { action: "execute", command: "pwd" }, tool_ref: toolRef, status: "complete" };

describe("tool details protocol", () => {
  it("distinguishes lightweight summaries from legacy complete records", () => {
    expect(timelineEventSchema.parse(summary)).toEqual(summary);
    expect(timelineEventSchema.safeParse({ ...summary, args: {}, result: [] }).success).toBe(false);
    expect(timelineEventSchema.safeParse({ ...summary, tool_ref: { ...toolRef, tool_call_id: "other" } }).success).toBe(false);
    const { representation: _representation, summary: _summary, tool_ref: _ref, ...base } = summary;
    expect(timelineEventSchema.safeParse({ ...base, args: {}, result: [], truncated: false }).success).toBe(true);
    expect(timelineEventSchema.safeParse(base).success).toBe(false);
  });

  it("allows lightweight preparation without broadcasting parameters or output", () => {
    const partial = { ...scope, type: "timeline_partial", group_id: "group", partial_id: "partial", kind: "tool", tool: "bash", tool_call_id: "tool-call", representation: "summary", tool_ref: toolRef, summary: { action: "execute" }, status: "preparing" };
    expect(timelinePartialSchema.safeParse(partial).success).toBe(true);
    expect(timelinePartialSchema.safeParse({ ...partial, blocks: [{ type: "text", text: "output" }] }).success).toBe(false);
  });

  it("keeps legacy handshakes valid and negotiates only the known capability", () => {
    const hello = { protocol_version: 2, type: "session_hello", channel_id: "channel", id: "hello" };
    expect(decodeClientFrameV2(hello)).toEqual(hello);
    expect(decodeClientFrameV2({ ...hello, tool_details: 1 })).toEqual({ ...hello, tool_details: 1 });
    expect(() => decodeClientFrameV2({ ...hello, tool_details: 2 })).toThrow();
  });

  it("opens only scoped references, not file paths, and closes the selected subscription", () => {
    const open = { ...scope, type: "tool_details_open", channel_id: "channel", id: "open", group_id: "group", tool_ref: toolRef };
    expect(decodeClientFrameV2(open)).toEqual(open);
    expect(() => decodeClientFrameV2({ ...open, path: "/arbitrary/file" })).toThrow();
    const close = { ...scope, type: "tool_details_close", channel_id: "channel", id: "close", subscription_id: "open" };
    expect(decodeClientFrameV2(close)).toEqual(close);
  });

  it("carries ordered revision chunks with a final length and digest", () => {
    const frame = { ...scope, type: "tool_details_chunk", target_channel_id: "channel", in_reply_to: "open", group_id: "group", tool_ref: toolRef, revision: 1, index: 0, data_base64: "e30=", final: true, total_bytes: 2, sha256: "a".repeat(64) } as const;
    expect(decodeServerFrameV2(encodeServerFrameV2(frame))).toEqual(frame);
    const { sha256: _digest, ...withoutDigest } = frame;
    expect(() => decodeServerFrameV2(withoutDigest)).toThrow();
    expect(() => decodeServerFrameV2({ ...frame, total_bytes: MAX_TOOL_DETAILS_BYTES + 1 })).toThrow();
    expect(() => decodeClientFrameV2(frame)).toThrow();
  });

  it("keeps unavailable previews distinct from terminal lookup errors", () => {
    const frame = { ...scope, type: "tool_details_error", target_channel_id: "channel", in_reply_to: "open", group_id: "group", tool_ref: toolRef, revision: 2, code: "unavailable", retryable: true, terminal: false };
    expect(decodeServerFrameV2(frame)).toEqual(frame);
    expect(() => decodeServerFrameV2({ ...frame, code: "unexpected" })).toThrow();
  });

  it("validates saved detail content separately from bounded running previews", () => {
    const content = { tool_ref: toolRef, tool: "bash", source: "session", status: "complete", args: { command: "pwd" }, result: [{ type: "text", text: "result" }], limited: false };
    expect(toolDetailsContentSchema.parse(content)).toEqual(content);
    expect(toolDetailsContentSchema.safeParse({ ...content, limited: true }).success).toBe(false);
    expect(toolDetailsContentSchema.safeParse({ ...content, source: "preview" }).success).toBe(false);
    expect(toolDetailsContentSchema.safeParse({ ...content, source: "preview", status: "running", limited: true }).success).toBe(true);
    const { result: _result, ...missingResult } = content;
    expect(toolDetailsContentSchema.safeParse(missingResult).success).toBe(false);
  });

  it("bounds structured summaries even for escaped or multibyte values", () => {
    const value = { action: "other", command: "\u0000".repeat(512), path: "\u0000".repeat(512) };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(MAX_TOOL_SUMMARY_BYTES);
    expect(toolSummarySchema.safeParse(value).success).toBe(false);
    expect(toolSummarySchema.safeParse({ action: "read", path: "目录/文件", offset: 2, limit: 10 }).success).toBe(true);
  });
});
