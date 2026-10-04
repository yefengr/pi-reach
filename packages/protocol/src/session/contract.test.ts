import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DecodeError,
  FILE_CHUNK_BYTES,
  FILE_MAX_BYTES,
  MAX_FRAGMENT_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_WINDOW_BYTES,
  PUBLISHED_FILE_TYPE,
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameTextV2,
  encodeClientFrameV2,
  encodeServerFrameTextV2,
  encodeServerFrameV2,
  parseTimelineEventV2,
  publishedFileFromEvent,
  validateFragmentSizeV2,
  validateHistoryChunkSizeV2,
  validateWindowSizeV2,
  type ClientFrame,
} from "./index.js";

type FixtureCase = {
  id: string;
  direction: "client" | "server" | "timeline" | "marker";
  valid: boolean;
  value: Record<string, unknown>;
  expected_code?: DecodeError["code"];
};
type FixtureManifest = { schema_version: 2; cases: FixtureCase[] };

const manifest = JSON.parse(
  readFileSync(new URL("../../../../docs/reference/protocol/fixtures/v2/manifest.json", import.meta.url), "utf8"),
) as FixtureManifest;

const version = { protocol_version: 2 as const };
const channel = { channel_id: "channel-1", session_id: "session-1", leaf_id: "generation-1" };
const session = { session_id: "session-1", leaf_id: "generation-1" };
const direct = { target_channel_id: "channel-1" };

function parseFixture(fixture: FixtureCase): unknown {
  if (fixture.direction === "client") return decodeClientFrameV2(fixture.value);
  if (fixture.direction === "server") return decodeServerFrameV2(fixture.value);
  if (fixture.direction === "timeline") return parseTimelineEventV2(fixture.value);
  return fixture.value;
}

function expectCode(action: () => unknown, code: DecodeError["code"]): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DecodeError);
  expect((thrown as DecodeError).code).toBe(code);
}

describe("shared session protocol fixture contract", () => {
  test("accepts valid fixtures and rejects invalid fixtures without rewriting input", () => {
    expect(manifest.schema_version).toBe(2);
    const ids = manifest.cases.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const fixture of manifest.cases.filter((candidate) => candidate.direction !== "marker")) {
      if (fixture.valid) {
        expect(() => parseFixture(fixture), fixture.id).not.toThrow();
      } else {
        expect(fixture.expected_code, `${fixture.id} must declare expected_code`).toBeDefined();
        expectCode(() => parseFixture(fixture), fixture.expected_code!);
      }
    }
  });

  test("keeps version, direction, strict fields and pairing codes closed", () => {
    expectCode(() => decodeClientFrameV2({ ...version, type: "pair_request", id: "P1", code: "token-1", device_name: "Browser" }), "schema");
    expectCode(() => decodeClientFrameV2({ ...version, type: "pair_request", id: "P1", code: "ABCD2345", device_name: "Browser", extra: true }), "schema");
    expectCode(() => decodeClientFrameV2({ ...version, type: "pair_request", id: "P1", code: "ABCI2345", device_name: "Browser" }), "schema");
    expectCode(() => decodeClientFrameV2({ ...version, type: "pair_ok", in_reply_to: "P1", session_name: "Pi", session_started_at: 0, endpoint_id: "E1" }), "direction");
    expectCode(() => decodeClientFrameV2({ protocol_version: 1, type: "pair_request", id: "P1", code: "ABCD2345", device_name: "Browser" }), "version");
    expectCode(() => decodeClientFrameV2({ ...version, type: "future_frame" }), "unsupported");
  });

  test("keeps session readiness on its original shape and reports version only on request", () => {
    const ready = { ...version, type: "session_ready", ...direct, ...session,
      in_reply_to: "hello", head_seq: 0, self_sender_ref: "owner" };
    expect(decodeServerFrameV2(ready)).toEqual(ready);
    expectCode(() => decodeServerFrameV2({ ...ready, extension_version: "1.2.3" }), "schema");

    const request = { ...version, type: "extension_info_request", id: "info-1", ...channel };
    expect(decodeClientFrameV2(request)).toEqual(request);
    const { version: _version, ...missingVersion } = { ...version, type: "extension_info", ...direct, in_reply_to: "info-1", version: "1.2.3" };
    expectCode(() => decodeServerFrameV2(missingVersion), "schema");
    const info = { ...version, type: "extension_info", ...direct, in_reply_to: "info-1", version: "1.2.3" };
    expect(decodeServerFrameV2(info)).toEqual(info);
    expect(decodeServerFrameV2({ ...info, version: "v".repeat(256) })).toHaveProperty("version", "v".repeat(256));
    for (const value of ["", null, 1, "v".repeat(257)]) {
      expectCode(() => decodeServerFrameV2({ ...info, version: value }), "schema");
    }
    expectCode(() => decodeServerFrameV2({ ...info, extra: true }), "schema");
    expectCode(() => decodeClientFrameV2(info), "direction");
    expectCode(() => decodeServerFrameV2(request), "direction");
  });

  test("requires session and nullable leaf identity on scoped client requests", () => {
    const frame = { ...version, type: "user_message", id: "U1", ...channel, leaf_id: null, client_request_id: "R1", text: "hello" };
    expect(decodeClientFrameV2(frame)).toMatchObject({ session_id: channel.session_id, leaf_id: null });
    const { session_id: _session, ...missingSession } = frame;
    const { leaf_id: _leaf, ...missingLeaf } = frame;
    expectCode(() => decodeClientFrameV2(missingSession), "schema");
    expectCode(() => decodeClientFrameV2(missingLeaf), "schema");
  });

  test("defaults session_sync limit to 80 and rejects values outside 1..80", () => {
    const frameWithoutLimit: Extract<ClientFrame, { type: "session_sync" }> = {
      ...version,
      type: "session_sync",
      id: "SYNC1",
      ...channel,
      before: null,
    };
    const decoded = decodeClientFrameV2(frameWithoutLimit);
    expect(decoded).toMatchObject({ type: "session_sync", limit: 80 });
    expectCode(() => decodeClientFrameV2({ ...decoded, limit: 0 }), "schema");
    expectCode(() => decodeClientFrameV2({ ...decoded, limit: 81 }), "schema");
  });
});

describe("shared session protocol sizes and encoding", () => {
  const event = {
    event_id: "event-1",
    event_seq: 1,
    ...session,
    timestamp: 0,
    group_id: "group-1",
    kind: "assistant" as const,
    blocks: [{ type: "text" as const, text: "done" }],
    status: "complete" as const,
  };
  const fragment = {
    ...version,
    type: "timeline_event_fragment" as const,
    ...session,
    event_id: "event-1",
    index: 0,
    data_base64: "aGk=",
    final: true,
  };
  const history = {
    ...version,
    type: "session_history_chunk" as const,
    ...direct,
    in_reply_to: "SYNC1",
    ...session,
    leaf_id: "head-1",
    chunk_index: 0,
    events: [event],
    fragments: [],
    final_chunk: true as const,
    eos: true as const,
  };

  test("validates fragment, history chunk and timeline window limits", () => {
    expect(MAX_FRAGMENT_BYTES).toBe(50 * 1024);
    expect(MAX_HISTORY_CHUNK_BYTES).toBe(512 * 1024);
    expect(MAX_WINDOW_BYTES).toBe(32 * 1024 * 1024);
    expect(validateFragmentSizeV2(fragment)).toBe(2);
    expect(validateHistoryChunkSizeV2(history)).toBeGreaterThan(0);
    expect(validateWindowSizeV2([event])).toBeGreaterThan(0);
  });

  test("rejects malformed UTF-8 before JSON or schema validation", () => {
    expectCode(() => decodeClientFrameV2(new Uint8Array([0xc3, 0x28])), "invalid");
  });

  test("keeps text and byte encoders equivalent after shared validation", () => {
    const client = { ...version, type: "ping" as const, id: "PING1", ...channel };
    const server = { ...version, type: "pong" as const, ...direct, in_reply_to: "PING1" };
    expect(new TextDecoder().decode(encodeClientFrameV2(client))).toBe(encodeClientFrameTextV2(client));
    expect(new TextDecoder().decode(encodeServerFrameV2(server))).toBe(encodeServerFrameTextV2(server));
    expect(decodeServerFrameV2(encodeServerFrameV2(server))).toEqual(server);
  });
});

describe("published file protocol contract", () => {
  const fileChannel = { channel_id: "channel-1", session_id: "session-1" };
  const fileReply = { ...direct, in_reply_to: "open-1", session_id: "session-1" };

  test("keeps file reads channel-scoped and chunks canonical", () => {
    const open = { ...version, type: "file_open" as const, id: "open-1", ...fileChannel, publication_id: "event-1" };
    const read = { ...version, type: "file_read" as const, id: "read-1", ...fileChannel, transfer_id: "transfer-1", offset: 0 };
    expect(decodeClientFrameV2(open)).toEqual(open);
    expect(decodeClientFrameV2(read)).toEqual(read);
    expectCode(() => decodeClientFrameV2({ ...open, leaf_id: "generation-1" }), "schema");
    expectCode(() => decodeServerFrameV2(open), "direction");

    const digest = "a".repeat(64);
    const final = { ...version, ...fileReply, type: "file_chunk" as const, transfer_id: "transfer-1", offset: 0, data_base64: "aGk=", final: true, total_bytes: 2, sha256: digest };
    expect(decodeServerFrameV2(final)).toEqual(final);
    expectCode(() => decodeServerFrameV2({ ...final, data_base64: "aGl=" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...final, total_bytes: 3 }), "schema");

    const empty = { ...final, data_base64: "", total_bytes: 0 };
    expect(decodeServerFrameV2(empty)).toEqual(empty);
    expectCode(() => decodeServerFrameV2({ ...empty, offset: 2 }), "schema");
    expectCode(() => decodeClientFrameV2(final), "direction");

    expect(FILE_CHUNK_BYTES).toBe(64 * 1024);
    expect(FILE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  test("keeps source_path out of the wire payload", () => {
    const published = {
      event_id: "event-1", session_id: "session-1", leaf_id: "generation-1", timestamp: 0,
      kind: "custom" as const,
      payload: { custom_type: PUBLISHED_FILE_TYPE, data: { file_name: "report.txt", mime_type: "text/plain", byte_length: 3, tool_call_id: "tool-1" } },
      truncated: false,
    };
    expect(publishedFileFromEvent(parseTimelineEventV2(published))).toMatchObject({ publication_id: "event-1", file_name: "report.txt" });
    const leaked = { ...published, payload: { ...published.payload, data: { ...published.payload.data, source_path: "/tmp/report.txt" } } };
    expect(publishedFileFromEvent(parseTimelineEventV2(leaked))).toBeNull();
  });
});
