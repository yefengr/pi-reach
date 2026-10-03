import {
  ATTACHMENT_PREVIEW_MAX_BYTES, ATTACHMENT_PREVIEW_MAX_DIMENSION,
  attachmentPreviewSchema, type AttachmentPreview,
} from "@pi-reach/protocol/session";
import { AttachmentUploadError, type PreparedAttachment } from "./attachment-upload-types";

export function attachmentBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

// 所有客户端共享准备队列，避免同时持有多个原件的完整 ArrayBuffer。
let preparationTail: Promise<unknown> = Promise.resolve();
export function prepareAttachmentFile(file: File): Promise<PreparedAttachment> {
  const preparation = preparationTail.then(async () => {
    try {
      const sha256 = await hashFile(file);
      const preview = await preparePreview(file);
      return preview ? { sha256, preview } : { sha256 };
    } catch {
      throw new AttachmentUploadError("prepare_failed");
    }
  });
  preparationTail = preparation.catch(() => undefined);
  return preparation;
}

async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function preparePreview(file: File): Promise<AttachmentPreview | undefined> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function"
    || typeof document === "undefined") return undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height) return undefined;
    const scale = Math.min(1, ATTACHMENT_PREVIEW_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4, 0.2]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob || blob.size > ATTACHMENT_PREVIEW_MAX_BYTES) continue;
      const result = attachmentPreviewSchema.safeParse({
        mime_type: "image/jpeg", data: attachmentBytesToBase64(new Uint8Array(await blob.arrayBuffer())),
        byte_length: blob.size, width: canvas.width, height: canvas.height,
      });
      if (result.success) return result.data;
    }
  } catch {
    // 预览只是尽力生成的显示元信息；解码失败不影响原件摘要和上传。
  } finally {
    bitmap?.close();
  }
  return undefined;
}
