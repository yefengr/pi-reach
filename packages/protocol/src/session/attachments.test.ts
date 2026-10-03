import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_IN_FLIGHT,
  ATTACHMENT_MAX_MESSAGE_BYTES,
  ATTACHMENT_MESSAGE_TYPE,
  ATTACHMENT_METADATA_TYPE,
  ATTACHMENT_PREVIEW_MAX_BYTES,
  ATTACHMENT_PREVIEW_MAX_DIMENSION,
  DecodeError,
  attachmentDescriptorSchema,
  attachmentIdsSchema,
  attachmentMessageBindingSchema,
  attachmentMetadataSchema,
  decodeClientFrameV2,
  decodeServerFrameV2,
  encodeClientFrameTextV2,
  encodeServerFrameTextV2,
  type ClientFrame,
} from "./index.js";

const version = { protocol_version: 2 as const };
const direct = { target_channel_id: "channel-1" };
const channel = { channel_id: "channel-1", session_id: "session-1", leaf_id: "generation-1" };
const upload = { channel_id: "channel-1", session_id: "session-1", upload_scope: "scope-1" };
const sha256 = "a".repeat(64);

function base64OfBytes(count: number): string {
  return Buffer.alloc(count).toString("base64");
}

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attachment_id: "attachment-1",
    file_name: "photo.jpg",
    mime_type: "image/jpeg",
    byte_length: 3,
    sha256,
    ...overrides,
  };
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

describe("attachment constants and metadata payloads", () => {
  test("pins the shared attachment limits and custom types", () => {
    expect(ATTACHMENT_MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(ATTACHMENT_MAX_MESSAGE_BYTES).toBe(100 * 1024 * 1024);
    expect(ATTACHMENT_MAX_COUNT).toBe(10);
    expect(ATTACHMENT_CHUNK_BYTES).toBe(64 * 1024);
    expect(ATTACHMENT_MAX_IN_FLIGHT).toBe(2);
    expect(ATTACHMENT_PREVIEW_MAX_BYTES).toBe(32 * 1024);
    expect(ATTACHMENT_PREVIEW_MAX_DIMENSION).toBe(320);
    expect(ATTACHMENT_METADATA_TYPE).toBe("pi-reach:attachments-v1");
    expect(ATTACHMENT_MESSAGE_TYPE).toBe("pi-reach:attachment-message-v1");
  });

  test("accepts descriptors with and without previews and rejects display/path attacks", () => {
    expect(attachmentDescriptorSchema.parse(descriptor())).toMatchObject({ attachment_id: "attachment-1" });
    expect(
      attachmentDescriptorSchema.parse(
        descriptor({
          preview: {
            mime_type: "image/jpeg",
            data: base64OfBytes(ATTACHMENT_PREVIEW_MAX_BYTES),
            byte_length: ATTACHMENT_PREVIEW_MAX_BYTES,
            width: ATTACHMENT_PREVIEW_MAX_DIMENSION,
            height: ATTACHMENT_PREVIEW_MAX_DIMENSION,
          },
        }),
      ),
    ).toMatchObject({ attachment_id: "attachment-1" });
    expect(attachmentDescriptorSchema.safeParse(descriptor({ file_name: "a\u0000b" })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ file_name: "line\nbreak" })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ file_name: "" })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ file_name: "n".repeat(256) })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ byte_length: -1 })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ byte_length: ATTACHMENT_MAX_FILE_BYTES + 1 })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ sha256: "A".repeat(64) })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ extra: true })).success).toBe(false);
  });

  test("keeps preview declared length and dimension limits closed", () => {
    const preview = (overrides: Record<string, unknown> = {}) => ({
      mime_type: "image/jpeg",
      data: "aGk=",
      byte_length: 2,
      width: 10,
      height: 10,
      ...overrides,
    });
    expect(attachmentDescriptorSchema.safeParse(descriptor({ preview: preview() })).success).toBe(true);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ preview: preview({ byte_length: 3 }) })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ preview: preview({ data: base64OfBytes(ATTACHMENT_PREVIEW_MAX_BYTES + 1), byte_length: ATTACHMENT_PREVIEW_MAX_BYTES + 1 }) })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ preview: preview({ width: ATTACHMENT_PREVIEW_MAX_DIMENSION + 1 }) })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ preview: preview({ height: 0 }) })).success).toBe(false);
    expect(attachmentDescriptorSchema.safeParse(descriptor({ preview: preview({ mime_type: "image/png" }) })).success).toBe(false);
  });

  test("enforces attachment id count, uniqueness and metadata totals", () => {
    expect(attachmentIdsSchema.safeParse(["a"]).success).toBe(true);
    expect(attachmentIdsSchema.safeParse([]).success).toBe(false);
    expect(attachmentIdsSchema.safeParse(["a", "a"]).success).toBe(false);
    expect(attachmentIdsSchema.safeParse(Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => `a${index}`)).success).toBe(false);

    const metadata = (attachments: Array<Record<string, unknown>>, text = "hello") => ({
      version: 1,
      client_request_id: "request-1",
      sender_ref: "sender-1",
      text,
      attachments,
    });
    expect(attachmentMetadataSchema.safeParse(metadata([descriptor()])).success).toBe(true);
    expect(attachmentMetadataSchema.safeParse(metadata([descriptor()], "")).success).toBe(true);
    expect(attachmentMetadataSchema.safeParse(metadata([])).success).toBe(false);
    expect(attachmentMetadataSchema.safeParse(metadata([descriptor(), descriptor()])).success).toBe(false);
    const tooMany = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => descriptor({ attachment_id: `a${index}`, byte_length: 0 }));
    expect(attachmentMetadataSchema.safeParse(metadata(tooMany)).success).toBe(false);
    const oversized = Array.from({ length: 3 }, (_, index) =>
      descriptor({ attachment_id: `big-${index}`, byte_length: ATTACHMENT_MAX_FILE_BYTES }),
    );
    expect(attachmentMetadataSchema.safeParse(metadata(oversized)).success).toBe(false);
    expect(attachmentMetadataSchema.safeParse({ ...metadata([descriptor()]), version: 2 }).success).toBe(false);
    expect(attachmentMetadataSchema.safeParse({ ...metadata([descriptor()]), extra: true }).success).toBe(false);
  });

  test("binds metadata to a committed message id", () => {
    const binding = { version: 1, client_request_id: "request-1", sender_ref: "sender-1", message_id: "message-1" };
    expect(attachmentMessageBindingSchema.parse(binding)).toEqual(binding);
    expect(attachmentMessageBindingSchema.safeParse({ ...binding, extra: true }).success).toBe(false);
    expect(attachmentMessageBindingSchema.safeParse({ ...binding, version: 0 }).success).toBe(false);
  });
});

describe("attachment client frames", () => {
  test("decodes capabilities, begin, chunk, finish, status and cancel requests", () => {
    const capabilitiesRequest = { ...version, type: "attachment_capabilities_request" as const, id: "cap-1", ...channel };
    const begin = {
      ...version,
      type: "attachment_begin" as const,
      id: "begin-1",
      ...upload,
      upload_id: "upload-1",
      file_name: "photo.jpg",
      mime_type: "image/jpeg",
      byte_length: 3,
      sha256,
      preview: { mime_type: "image/jpeg" as const, data: "aGk=", byte_length: 2, width: 1, height: 1 },
    };
    const chunk = { ...version, type: "attachment_chunk" as const, id: "chunk-1", ...upload, upload_id: "upload-1", offset: 0, data_base64: "aGk=" };
    const finish = { ...version, type: "attachment_finish" as const, id: "finish-1", ...upload, upload_id: "upload-1" };
    const status = { ...version, type: "attachment_status_request" as const, id: "status-1", ...upload, upload_id: "upload-1" };
    const cancel = { ...version, type: "attachment_cancel" as const, id: "cancel-1", ...upload, upload_id: "upload-1" };

    for (const frame of [capabilitiesRequest, begin, chunk, finish, status, cancel] as const) {
      expect(decodeClientFrameV2(frame)).toEqual(frame);
    }
  });

  test("keeps new client frames strict on direction, version and unknown fields", () => {
    const begin = { ...version, type: "attachment_begin" as const, id: "begin-1", ...upload, upload_id: "upload-1", file_name: "photo.jpg", mime_type: "image/jpeg", byte_length: 3, sha256 };
    expectCode(() => decodeClientFrameV2({ ...begin, extra: true }), "schema");
    expectCode(() => decodeClientFrameV2({ ...begin, upload_scope: undefined }), "schema");
    expectCode(() => decodeClientFrameV2({ ...begin, protocol_version: 1 }), "version");
    expectCode(() => decodeClientFrameV2({ ...begin, protocol_version: undefined }), "version");
    expectCode(() => decodeServerFrameV2(begin), "direction");
    expectCode(() => decodeClientFrameV2({ ...version, type: "attachment_capabilities", ...direct }), "direction");
    expectCode(() => decodeClientFrameV2({ ...version, type: "attachment_future" }), "unsupported");
  });

  test("rejects non-canonical chunk payloads and enforces 1..64 KiB decoded bytes", () => {
    const chunk = (overrides: Record<string, unknown> = {}) => ({
      ...version,
      type: "attachment_chunk" as const,
      id: "chunk-1",
      ...upload,
      upload_id: "upload-1",
      offset: 0,
      data_base64: "aGk=",
      ...overrides,
    });
    expect(decodeClientFrameV2(chunk())).toMatchObject({ data_base64: "aGk=" });
    expect(decodeClientFrameV2(chunk({ data_base64: base64OfBytes(ATTACHMENT_CHUNK_BYTES) }))).toMatchObject({ offset: 0 });
    expectCode(() => decodeClientFrameV2(chunk({ data_base64: base64OfBytes(ATTACHMENT_CHUNK_BYTES + 1) })), "schema");
    // "aGl=" is valid Base64 but not canonical: its trailing bits would re-encode as "aGk=".
    expectCode(() => decodeClientFrameV2(chunk({ data_base64: "aGl=" })), "schema");
    expectCode(() => decodeClientFrameV2(chunk({ data_base64: "aGk" })), "schema");
    expectCode(() => decodeClientFrameV2(chunk({ data_base64: "" })), "schema");
    expectCode(() => decodeClientFrameV2(chunk({ offset: -1 })), "schema");
    expectCode(() => decodeClientFrameV2(chunk({ offset: Number.MAX_SAFE_INTEGER + 1 })), "schema");
  });

  test("keeps user_message images and attachment_ids mutually exclusive", () => {
    const base = { ...version, type: "user_message" as const, id: "msg-1", ...channel, client_request_id: "request-1", text: "hello" };
    const legacy = { ...base, images: [{ data: "aGk=", mime: "image/jpeg" }] };
    expect(decodeClientFrameV2(legacy)).toMatchObject({ images: [{ mime: "image/jpeg" }] });
    expect(decodeClientFrameV2({ ...base, attachment_ids: ["attachment-1"] })).toMatchObject({ attachment_ids: ["attachment-1"] });
    expect(decodeClientFrameV2(base)).not.toHaveProperty("attachment_ids");
    expectCode(() => decodeClientFrameV2({ ...base, images: [{ data: "aGk=", mime: "image/jpeg" }], attachment_ids: ["attachment-1"] }), "schema");
    expectCode(() => decodeClientFrameV2({ ...base, attachment_ids: [] }), "schema");
    expectCode(() => decodeClientFrameV2({ ...base, attachment_ids: ["a", "a"] }), "schema");
  });
});

describe("attachment server frames", () => {
  const base = { ...version, ...direct, in_reply_to: "request-1", session_id: "session-1", upload_scope: "scope-1" };

  test("decodes capabilities with the frozen literal limits", () => {
    const capabilities = {
      ...base,
      type: "attachment_capabilities" as const,
      max_file_bytes: ATTACHMENT_MAX_FILE_BYTES,
      max_message_bytes: ATTACHMENT_MAX_MESSAGE_BYTES,
      max_attachments: ATTACHMENT_MAX_COUNT,
      chunk_bytes: ATTACHMENT_CHUNK_BYTES,
      max_in_flight: ATTACHMENT_MAX_IN_FLIGHT,
    };
    expect(decodeServerFrameV2(capabilities)).toEqual(capabilities);
    expectCode(() => decodeServerFrameV2({ ...capabilities, max_file_bytes: 1 }), "schema");
    expectCode(() => decodeServerFrameV2({ ...capabilities, extra: true }), "schema");
    expectCode(() => decodeClientFrameV2(capabilities), "direction");
  });

  test("keeps attachment_state status union and received byte consistency strict", () => {
    const receiving = { ...base, type: "attachment_state" as const, upload_id: "upload-1", received_bytes: 0, status: "receiving" as const };
    const cancelled = { ...base, type: "attachment_state" as const, upload_id: "upload-1", received_bytes: 5, status: "cancelled" as const };
    const complete = { ...base, type: "attachment_state" as const, upload_id: "upload-1", received_bytes: 3, status: "complete" as const, attachment: descriptor() };

    expect(decodeServerFrameV2(receiving)).toEqual(receiving);
    expect(decodeServerFrameV2(cancelled)).toEqual(cancelled);
    expect(decodeServerFrameV2(complete)).toEqual(complete);
    expectCode(() => decodeServerFrameV2({ ...receiving, attachment: descriptor() }), "schema");
    expectCode(() => decodeServerFrameV2({ ...cancelled, attachment: descriptor() }), "schema");
    expectCode(() => decodeServerFrameV2({ ...complete, attachment: undefined }), "schema");
    expectCode(() => decodeServerFrameV2({ ...complete, received_bytes: 2 }), "schema");
    expectCode(() => decodeServerFrameV2({ ...complete, received_bytes: ATTACHMENT_MAX_FILE_BYTES + 1 }), "schema");
    expectCode(() => decodeServerFrameV2({ ...receiving, status: "unknown" }), "schema");
    expectCode(() => decodeClientFrameV2(receiving), "direction");
  });

  test("decodes attachment_error without dynamic message text", () => {
    const error = { ...base, type: "attachment_error" as const, upload_id: "upload-1", code: "too_large" as const, retryable: false };
    expect(decodeServerFrameV2(error)).toEqual(error);
    expect(decodeServerFrameV2({ ...base, type: "attachment_error", code: "not_found", retryable: true })).toMatchObject({ code: "not_found" });
    for (const code of ["invalid_scope", "not_found", "invalid_upload", "too_large", "busy", "no_space", "io_error", "integrity_mismatch", "offset_mismatch", "cancelled"]) {
      expect(decodeServerFrameV2({ ...base, type: "attachment_error", code, retryable: true })).toMatchObject({ code });
    }
    expectCode(() => decodeServerFrameV2({ ...error, code: "unknown" }), "schema");
    expectCode(() => decodeServerFrameV2({ ...error, message: "raw failure" }), "schema");
    expectCode(() => decodeClientFrameV2(error), "direction");
  });
});

describe("legacy wire compatibility", () => {
  test("keeps previously frozen frames byte-identical", () => {
    const ping = { ...version, type: "ping" as const, id: "ping-1", ...channel };
    expect(encodeClientFrameTextV2(ping)).toBe(JSON.stringify(ping));

    const userMessage = { ...version, type: "user_message" as const, id: "msg-1", ...channel, client_request_id: "request-1", text: "hello", images: [{ data: "aGk=", mime: "image/jpeg" }] };
    expect(encodeClientFrameTextV2(userMessage)).toBe(JSON.stringify(userMessage));
    expect(encodeClientFrameTextV2(userMessage)).not.toContain("attachment_ids");

    const pong = { protocol_version: 2 as const, target_channel_id: "channel-1", type: "pong" as const, in_reply_to: "ping-1" };
    expect(encodeServerFrameTextV2(pong)).toBe(JSON.stringify(pong));

    const queued: ClientFrame = { ...version, type: "queued_message_set", id: "queue-1", ...channel, text: "queued" };
    expect(encodeClientFrameTextV2(queued)).toBe(JSON.stringify(queued));
  });
});
