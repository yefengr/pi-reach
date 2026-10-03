import { z } from "zod";
import {
  idSchema,
  imageMimeSchema,
  strictObject,
  textSchema,
} from "./schema.js";

/** Hard per-file upload ceiling; also the maximum decoded original size. */
export const ATTACHMENT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Hard per-message ceiling across every descriptor in one metadata record. */
export const ATTACHMENT_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_CHUNK_BYTES = 64 * 1024;
export const ATTACHMENT_MAX_IN_FLIGHT = 2;
export const ATTACHMENT_PREVIEW_MAX_BYTES = 32 * 1024;
export const ATTACHMENT_PREVIEW_MAX_DIMENSION = 320;

/** custom_type used by the display-only attachment metadata custom event payload. */
export const ATTACHMENT_METADATA_TYPE = "pi-reach:attachments-v1" as const;
/** custom_type used by the branch-anchored metadata/message binding custom event payload. */
export const ATTACHMENT_MESSAGE_TYPE = "pi-reach:attachment-message-v1" as const;

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

function canonicalBase64Schema(minBytes: number, maxBytes: number): z.ZodString {
  const maxChars = 4 * Math.ceil(maxBytes / 3);
  return z
    .string()
    .min(4)
    .max(maxChars)
    .regex(BASE64_PATTERN)
    .superRefine((value, ctx) => {
      const decoded = decodeCanonicalBase64(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: "value must be canonical Base64" });
        return;
      }
      if (decoded.byteLength < minBytes) {
        ctx.addIssue({ code: "custom", message: `decoded value must be at least ${minBytes} bytes` });
      }
      if (decoded.byteLength > maxBytes) {
        ctx.addIssue({ code: "custom", message: `decoded value must be at most ${maxBytes} bytes` });
      }
    });
}

/**
 * Chunk payload for `attachment_chunk`; canonical Base64 whose decoded size is 1..64 KiB.
 * Declared only as a codec-level constraint; the offset contract is enforced by the store.
 */
export const attachmentChunkDataSchema = canonicalBase64Schema(1, ATTACHMENT_CHUNK_BYTES);

/** Display-only file name; never used to derive a path. Rejects NUL and control characters. */
export const attachmentFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\p{Cc}]+$/u);

export const attachmentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** 0 is a valid original size (empty files still upload). */
export const attachmentByteLengthSchema = z
  .number()
  .int()
  .nonnegative()
  .finite()
  .max(ATTACHMENT_MAX_FILE_BYTES);

export const attachmentPreviewSchema = strictObject({
  mime_type: z.literal("image/jpeg"),
  data: canonicalBase64Schema(1, ATTACHMENT_PREVIEW_MAX_BYTES),
  byte_length: z.number().int().min(1).finite().max(ATTACHMENT_PREVIEW_MAX_BYTES),
  width: z.number().int().min(1).finite().max(ATTACHMENT_PREVIEW_MAX_DIMENSION),
  height: z.number().int().min(1).finite().max(ATTACHMENT_PREVIEW_MAX_DIMENSION),
}).superRefine((preview, ctx) => {
  const decoded = decodeCanonicalBase64(preview.data);
  if (decoded !== null && decoded.byteLength !== preview.byte_length) {
    ctx.addIssue({
      code: "custom",
      path: ["byte_length"],
      message: "byte_length must equal the decoded preview byte length",
    });
  }
});
export type AttachmentPreview = z.infer<typeof attachmentPreviewSchema>;

export const attachmentDescriptorSchema = strictObject({
  attachment_id: idSchema,
  file_name: attachmentFileNameSchema,
  mime_type: imageMimeSchema,
  byte_length: attachmentByteLengthSchema,
  sha256: attachmentSha256Schema,
  preview: attachmentPreviewSchema.optional(),
});
export type AttachmentDescriptor = z.infer<typeof attachmentDescriptorSchema>;

export const attachmentIdsSchema = z
  .array(idSchema)
  .min(1)
  .max(ATTACHMENT_MAX_COUNT)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "attachment ids must be unique" });
    }
  });

/** Display metadata carried in a `custom` timeline payload; never enters model input. */
export const attachmentMetadataSchema = strictObject({
  version: z.literal(1),
  client_request_id: idSchema,
  sender_ref: idSchema,
  text: textSchema,
  attachments: z
    .array(attachmentDescriptorSchema)
    .min(1)
    .max(ATTACHMENT_MAX_COUNT),
}).superRefine((metadata, ctx) => {
  const ids = metadata.attachments.map((attachment) => attachment.attachment_id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["attachments"], message: "attachment ids must be unique" });
  }
  const totalBytes = metadata.attachments.reduce((sum, attachment) => sum + attachment.byte_length, 0);
  if (totalBytes > ATTACHMENT_MAX_MESSAGE_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["attachments"],
      message: `attachment total must not exceed ${ATTACHMENT_MAX_MESSAGE_BYTES} bytes`,
    });
  }
});
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

/** Binds a metadata record to the committed message id so branches keep their attachment ancestor. */
export const attachmentMessageBindingSchema = strictObject({
  version: z.literal(1),
  client_request_id: idSchema,
  sender_ref: idSchema,
  message_id: idSchema,
});
export type AttachmentMessageBinding = z.infer<typeof attachmentMessageBindingSchema>;
