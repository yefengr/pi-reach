import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
  DecodeError,
  FILE_AUTO_IMAGE_BYTES,
  FILE_CHUNK_BYTES,
  FILE_MAX_BYTES,
  FILE_MAX_IMAGE_PIXELS,
  PUBLISHED_FILE_TYPE,
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameTextV2,
  encodeServerFrameTextV2,
  filePreviewSchema,
  parseTimelineEventV2,
  publishedFileDescriptorSchema,
  publishedFileFromEvent,
  publishedFileMetadataSchema,
  publishedFilePayloadSchema,
} from "./index.js";

const version = { protocol_version: 2 as const };
const direct = { target_channel_id: "channel-1" };
const channel = { channel_id: "channel-1", session_id: "session-1" };
const sha256 = "0123456789abcdef".repeat(4);

const metadata = {
  file_name: "report.txt",
  mime_type: "text/plain",
  byte_length: 3,
  tool_call_id: "tool-1",
};

function base64OfBytes(count: number): string {
  return Buffer.alloc(count).toString("base64");
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

describe("published file metadata", () => {
  test("pins the shared file limits and custom type", () => {
    expect(PUBLISHED_FILE_TYPE).toBe("pi-reach:published-file-v1");
    expect(FILE_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(FILE_CHUNK_BYTES).toBe(64 * 1024);
    expect(FILE_AUTO_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(FILE_MAX_IMAGE_PIXELS).toBe(20_000_000);
  });

  test("keeps metadata strict on file name, MIME and byte length", () => {
    expect(publishedFileMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, byte_length: 0 }).success).toBe(true);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, byte_length: FILE_MAX_BYTES }).success).toBe(true);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, file_name: "" }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, file_name: "n".repeat(256) }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, file_name: "a\u0000b" }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, file_name: "line\nbreak" }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, mime_type: "text" }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, mime_type: "text/plain; charset=utf-8" }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, byte_length: -1 }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, byte_length: FILE_MAX_BYTES + 1 }).success).toBe(false);
    expect(publishedFileMetadataSchema.safeParse({ ...metadata, extra: true }).success).toBe(false);
  });

  test("keeps publication_id outside the metadata and rejects source_path on the wire", () => {
    const descriptor = { publication_id: "event-1", ...metadata };
    expect(publishedFileDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(publishedFileDescriptorSchema.safeParse(metadata).success).toBe(false);
    expect(publishedFileDescriptorSchema.safeParse({ ...descriptor, source_path: "/tmp/report.txt" }).success).toBe(false);

    const payload = { custom_type: PUBLISHED_FILE_TYPE, data: metadata };
    expect(publishedFilePayloadSchema.parse(payload)).toEqual(payload);
    expect(publishedFilePayloadSchema.safeParse({ custom_type: PUBLISHED_FILE_TYPE, data: { ...metadata, source_path: "/tmp/report.txt" } }).success).toBe(false);
    expect(publishedFilePayloadSchema.safeParse({ custom_type: "pi-reach:other-v1", data: metadata }).success).toBe(false);
    expect(publishedFilePayloadSchema.safeParse({ custom_type: PUBLISHED_FILE_TYPE }).success).toBe(false);
    expect(publishedFilePayloadSchema.safeParse({ ...payload, group_id: "group-1" }).success).toBe(false);
  });

  test("derives a descriptor from a custom event and ignores everything else", () => {
    const event = parseTimelineEventV2({
      event_id: "event-1",
      session_id: "session-1",
      leaf_id: "generation-1",
      timestamp: 0,
      group_id: "group-1",
      kind: "custom",
      payload: { custom_type: PUBLISHED_FILE_TYPE, data: metadata },
      truncated: false,
    });
    expect(publishedFileFromEvent(event)).toEqual({ publication_id: "event-1", ...metadata });

    const assistant = parseTimelineEventV2({
      event_id: "event-2",
      session_id: "session-1",
      leaf_id: "generation-1",
      timestamp: 1,
      group_id: "group-1",
      kind: "assistant",
      blocks: [{ type: "text", text: "done" }],
      status: "complete",
    });
    expect(publishedFileFromEvent(assistant)).toBeNull();

    const otherCustom = parseTimelineEventV2({
      event_id: "event-3",
      session_id: "session-1",
      leaf_id: "generation-1",
      timestamp: 2,
      group_id: "group-1",
      kind: "custom",
      payload: { custom_type: "pi-reach:other-v1", data: metadata },
      truncated: false,
    });
    expect(publishedFileFromEvent(otherCustom)).toBeNull();

    const leakedPath = parseTimelineEventV2({
      event_id: "event-4",
      session_id: "session-1",
      leaf_id: "generation-1",
      timestamp: 3,
      group_id: "group-1",
      kind: "custom",
      payload: { custom_type: PUBLISHED_FILE_TYPE, data: { ...metadata, source_path: "/tmp/report.txt" } },
      truncated: false,
    });
    expect(publishedFileFromEvent(leakedPath)).toBeNull();
  });

  test("bounds image previews by pixel budget and stays a closed union", () => {
    expect(filePreviewSchema.parse({ kind: "text" })).toEqual({ kind: "text" });
    expect(filePreviewSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
    expect(filePreviewSchema.parse({ kind: "image", width: 5000, height: 4000 })).toEqual({ kind: "image", width: 5000, height: 4000 });
    expect(filePreviewSchema.safeParse({ kind: "image", width: 5000, height: 4001 }).success).toBe(false);
    expect(filePreviewSchema.safeParse({ kind: "image", width: 0, height: 10 }).success).toBe(false);
    expect(filePreviewSchema.safeParse({ kind: "image", width: -1, height: 10 }).success).toBe(false);
    expect(filePreviewSchema.safeParse({ kind: "image", width: 1.5, height: 10 }).success).toBe(false);
    expect(filePreviewSchema.safeParse({ kind: "video" }).success).toBe(false);
    expect(filePreviewSchema.safeParse({ kind: "text", bytes: 1 }).success).toBe(false);
  });
});

describe("published file frames", () => {
  const open = { ...version, type: "file_open" as const, id: "open-1", ...channel, publication_id: "event-1" };
  const read = { ...version, type: "file_read" as const, id: "read-1", ...channel, transfer_id: "transfer-1", offset: 0 };
  const close = { ...version, type: "file_close" as const, id: "close-1", ...channel, transfer_id: "transfer-1" };

  test("decodes channel/session-scoped requests without leaf or upload scope", () => {
    for (const frame of [open, read, close] as const) {
      expect(decodeClientFrameV2(frame)).toEqual(frame);
      expect(decodeClientFrameV2(encodeClientFrameTextV2(frame))).toEqual(frame);
    }
    expectCode(() => decodeClientFrameV2({ ...open, leaf_id: "generation-1" }), "schema");
    expectCode(() => decodeClientFrameV2({ ...open, upload_scope: "scope-1" }), "schema");
    expectCode(() => decodeClientFrameV2({ ...read, offset: FILE_MAX_BYTES + 1 }), "schema");
    expectCode(() => decodeClientFrameV2({ ...read, offset: -1 }), "schema");
    expectCode(() => decodeServerFrameV2(open), "direction");
    expectCode(() => decodeClientFrameV2({ ...open, protocol_version: 1 }), "version");
    expectCode(() => decodeClientFrameV2({ ...open, extra: true }), "schema");
  });

  test("decodes file_opened metadata for text and image previews", () => {
    const base = { ...version, ...direct, in_reply_to: "open-1", session_id: "session-1", type: "file_opened" as const,
      publication_id: "event-1", transfer_id: "transfer-1", file_name: "report.txt", mime_type: "text/plain", byte_length: 3 };
    const text = { ...base, preview: { kind: "text" as const } };
    const image = { ...base, preview: { kind: "image" as const, width: 5000, height: 4000 } };
    const none = { ...base, preview: { kind: "none" as const } };
    expect(decodeServerFrameV2(text)).toEqual(text);
    expect(decodeServerFrameV2(image)).toEqual(image);
    expect(decodeServerFrameV2(none)).toEqual(none);
    expect(decodeServerFrameV2(encodeServerFrameTextV2(image))).toEqual(image);
    expectCode(() => decodeServerFrameV2({ ...text, preview: { kind: "video" } }), "schema");
    expectCode(() => decodeServerFrameV2({ ...text, source_path: "/tmp/report.txt" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...text, byte_length: FILE_MAX_BYTES + 1 }), "schema");
    expectCode(() => decodeClientFrameV2(text), "direction");
  });

  test("decodes file_closed and fixed-code file_error responses", () => {
    const closed = { ...version, ...direct, in_reply_to: "close-1", session_id: "session-1", type: "file_closed" as const, transfer_id: "transfer-1" };
    const failure = { ...version, ...direct, in_reply_to: "read-1", session_id: "session-1", type: "file_error" as const, transfer_id: "transfer-1", code: "file_changed" as const };
    const bare = { ...version, ...direct, in_reply_to: "open-1", session_id: "session-1", type: "file_error" as const, code: "not_available" as const };
    expect(decodeServerFrameV2(closed)).toEqual(closed);
    expect(decodeServerFrameV2(failure)).toEqual(failure);
    expect(decodeServerFrameV2(bare)).toEqual(bare);
    for (const code of ["not_available", "permission_denied", "not_regular_file", "too_large", "file_changed", "invalid_transfer", "offset_mismatch", "busy", "io_error"]) {
      expect(decodeServerFrameV2({ ...bare, code })).toMatchObject({ code });
    }
    expectCode(() => decodeServerFrameV2({ ...bare, code: "unknown" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...failure, retryable: false }), "schema");
    expectCode(() => decodeServerFrameV2({ ...failure, message: "raw failure" }), "schema");
    expectCode(() => decodeClientFrameV2(failure), "direction");
  });
});

describe("published file read chunks", () => {
  const base = { ...version, ...direct, in_reply_to: "read-1", session_id: "session-1", type: "file_chunk" as const, transfer_id: "transfer-1" };
  const chunk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...base, offset: 0, data_base64: "aGk=", final: false, ...overrides });

  test("accepts 1..64 KiB non-final chunks and canonical Base64 only", () => {
    const oneByte = chunk({ data_base64: base64OfBytes(1) });
    const full = chunk({ data_base64: base64OfBytes(FILE_CHUNK_BYTES) });
    expect(decodeServerFrameV2(oneByte)).toEqual(oneByte);
    expect(decodeServerFrameV2(full)).toEqual({ ...full, data_base64: base64OfBytes(FILE_CHUNK_BYTES) });
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: base64OfBytes(FILE_CHUNK_BYTES + 1) })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: "" })), "schema");
    // "aGl=" is valid Base64 but not canonical: dropping trailing bits re-encodes as "aGk=".
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: "aGl=" })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: "aGk" })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ total_bytes: 2 })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ sha256 })), "schema");
  });

  test("requires the final chunk to end at total_bytes with a digest", () => {
    const final = chunk({ final: true, total_bytes: 2, sha256 });
    expect(decodeServerFrameV2(final)).toEqual(final);
    expect(decodeServerFrameV2(encodeServerFrameTextV2(final))).toEqual(final);
    expectCode(() => decodeServerFrameV2(chunk({ final: true, total_bytes: 3, sha256 })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ final: true, total_bytes: 2 })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ final: true, total_bytes: 2, sha256: "A".repeat(64) })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ final: false, total_bytes: 2, sha256 })), "schema");
  });

  test("allows an empty final chunk only for an empty file at offset zero", () => {
    const empty = chunk({ data_base64: "", final: true, offset: 0, total_bytes: 0, sha256 });
    expect(decodeServerFrameV2(empty)).toEqual(empty);
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: "", final: true, offset: 2, total_bytes: 0, sha256 })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: "", final: true, offset: 0, total_bytes: 2, sha256 })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ data_base64: "", final: false })), "schema");
  });

  test("never reads past the 50 MiB original", () => {
    const last = chunk({ offset: FILE_MAX_BYTES - 2, final: true, total_bytes: FILE_MAX_BYTES, sha256 });
    expect(decodeServerFrameV2(last)).toEqual(last);
    expectCode(() => decodeServerFrameV2(chunk({ offset: FILE_MAX_BYTES - 1 })), "schema");
    expectCode(() => decodeServerFrameV2(chunk({ offset: FILE_MAX_BYTES + 1 })), "schema");
  });
});
