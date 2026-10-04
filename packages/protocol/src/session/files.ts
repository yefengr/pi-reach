import { z } from "zod";
import { idSchema, strictObject } from "./schema.js";
import type { TimelineEvent } from "./schema.js";

/** custom_type of the published-file metadata custom event payload. */
export const PUBLISHED_FILE_TYPE = "pi-reach:published-file-v1" as const;
/** Hard ceiling for one published file's original bytes; also the total transfer size. */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Decoded bytes carried by one read chunk. */
export const FILE_CHUNK_BYTES = 64 * 1024;
/** Largest image the client may fetch automatically for preview. */
export const FILE_AUTO_IMAGE_BYTES = 10 * 1024 * 1024;
/** Total decoded pixels allowed for an image preview. */
export const FILE_MAX_IMAGE_PIXELS = 20_000_000;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BINARY_STRING_CHUNK = 8192;

function toBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BINARY_STRING_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_STRING_CHUNK));
  }
  return binary;
}

function encodeCanonicalBase64(bytes: Uint8Array): string {
  return btoa(toBinaryString(bytes));
}

/**
 * Decodes a string only when it is *canonical* Base64: valid alphabet/padding and
 * no non-zero trailing bits. Returns null for anything that would re-encode differently.
 */
function decodeCanonicalBase64(value: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return encodeCanonicalBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

/** Decoded byte length of a canonical Base64 string, or null when it is not canonical. */
export function canonicalBase64ByteLength(value: string): number | null {
  const bytes = decodeCanonicalBase64(value);
  return bytes === null ? null : bytes.byteLength;
}

function canonicalBase64Schema(maxBytes: number): z.ZodString {
  const maxChars = 4 * Math.ceil(maxBytes / 3);
  return z
    .string()
    .max(maxChars)
    .regex(BASE64_PATTERN)
    .superRefine((value, ctx) => {
      const decoded = decodeCanonicalBase64(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: "value must be canonical Base64" });
        return;
      }
      if (decoded.byteLength > maxBytes) {
        ctx.addIssue({ code: "custom", message: `decoded value must be at most ${maxBytes} bytes` });
      }
    });
}

/**
 * Read-chunk payload; canonical Base64 whose decoded size is 0..64 KiB. The empty
 * value is only valid for the empty final chunk of a zero-length file.
 */
export const fileChunkDataSchema = canonicalBase64Schema(FILE_CHUNK_BYTES);

/** Display-only file name; never used to derive a path. Rejects NUL and control characters. */
export const fileFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\p{Cc}]+$/u);

export const fileMimeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.+-]+\/[\w.+-]+$/);

/** 0 is a valid original size (empty files are still readable). */
export const fileByteLengthSchema = z
  .number()
  .int()
  .nonnegative()
  .finite()
  .max(FILE_MAX_BYTES);

export const fileSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Read offset inside the original file; never a byte range. */
export const fileOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .finite()
  .max(FILE_MAX_BYTES);

/** Fixed local failure codes; they never carry paths, exception text or retry hints. */
export const fileErrorCodeSchema = z.enum([
  "not_available",
  "permission_denied",
  "not_regular_file",
  "too_large",
  "file_changed",
  "invalid_transfer",
  "offset_mismatch",
  "busy",
  "io_error",
]);
export type FileErrorCode = z.infer<typeof fileErrorCodeSchema>;

const publishedFileMetadataShape = {
  file_name: fileFileNameSchema,
  mime_type: fileMimeSchema,
  byte_length: fileByteLengthSchema,
  tool_call_id: idSchema,
};
export const publishedFileMetadataSchema = strictObject(publishedFileMetadataShape);
export type PublishedFileMetadata = z.infer<typeof publishedFileMetadataSchema>;

/** Wires the metadata to its custom entry id; `publication_id` is never duplicated in `data`. */
export const publishedFileDescriptorSchema = strictObject({
  publication_id: idSchema,
  ...publishedFileMetadataShape,
});
export type PublishedFileDescriptor = z.infer<typeof publishedFileDescriptorSchema>;

/**
 * Wire payload of the published-file custom event. `source_path` and the local
 * `group_id` stay outside the wire metadata and are rejected here as unknown fields.
 */
export const publishedFilePayloadSchema = strictObject({
  custom_type: z.literal(PUBLISHED_FILE_TYPE),
  data: publishedFileMetadataSchema,
});
export type PublishedFilePayload = z.infer<typeof publishedFilePayloadSchema>;

const positiveSafeIntSchema = z
  .number()
  .int()
  .positive()
  .finite()
  .max(Number.MAX_SAFE_INTEGER);

const imagePreviewSchema = strictObject({
  kind: z.literal("image"),
  width: positiveSafeIntSchema,
  height: positiveSafeIntSchema,
}).superRefine((preview, ctx) => {
  if (preview.width * preview.height > FILE_MAX_IMAGE_PIXELS) {
    ctx.addIssue({
      code: "custom",
      path: ["height"],
      message: `image preview must not exceed ${FILE_MAX_IMAGE_PIXELS} pixels`,
    });
  }
});

/** Server-advertised preview capability for the current file content. */
export const filePreviewSchema = z.union([
  imagePreviewSchema,
  strictObject({ kind: z.literal("text") }),
  strictObject({ kind: z.literal("none") }),
]);
export type FilePreview = z.infer<typeof filePreviewSchema>;

/** Resolves a published file from a `custom` timeline event; `publication_id` is the event id. */
export function publishedFileFromEvent(event: TimelineEvent): PublishedFileDescriptor | null {
  if (event.kind !== "custom") return null;
  const payload = publishedFilePayloadSchema.safeParse(event.payload);
  if (!payload.success) return null;
  return { publication_id: event.event_id, ...payload.data.data };
}
