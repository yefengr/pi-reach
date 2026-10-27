import {
  attachmentDescriptorSchema, publishedFileDescriptorSchema,
  type AttachmentDescriptor, type PublishedFileDescriptor,
} from "@pi-reach/protocol/session";

/** 已发送附件的取回描述；缩略图不随任务保存，摘要用于校验取回的原件。 */
export type AttachmentFileDescriptor = Pick<AttachmentDescriptor, "attachment_id" | "file_name" | "mime_type" | "byte_length" | "sha256">;
/** 发布文件与已发送附件共用获取、缓存和阅读器；来源只决定打开请求。 */
export type FileSourceDescriptor = PublishedFileDescriptor | AttachmentFileDescriptor;
export type FileOpenOperation = { type: "file_open"; publication_id: string } | { type: "file_attachment_open"; attachment_id: string };

// 发布文件沿用 event ID 作为键；附件加前缀，两类 ID 不会互相覆盖缓存或阅读器 pin。
const ATTACHMENT_KEY_PREFIX = "attachment:";

export function isAttachmentFile(descriptor: FileSourceDescriptor): descriptor is AttachmentFileDescriptor {
  return "attachment_id" in descriptor;
}

export function fileKey(descriptor: FileSourceDescriptor): string {
  return isAttachmentFile(descriptor) ? `${ATTACHMENT_KEY_PREFIX}${descriptor.attachment_id}` : descriptor.publication_id;
}

export function attachmentFile(descriptor: AttachmentDescriptor): AttachmentFileDescriptor {
  const { attachment_id, file_name, mime_type, byte_length, sha256 } = descriptor;
  return { attachment_id, file_name, mime_type, byte_length, sha256 };
}

export function validFileSource(descriptor: FileSourceDescriptor): boolean {
  return isAttachmentFile(descriptor)
    ? attachmentDescriptorSchema.safeParse(descriptor).success
    : publishedFileDescriptorSchema.safeParse(descriptor).success;
}

export function fileOpenOperation(descriptor: FileSourceDescriptor): FileOpenOperation {
  return isAttachmentFile(descriptor)
    ? { type: "file_attachment_open", attachment_id: descriptor.attachment_id }
    : { type: "file_open", publication_id: descriptor.publication_id };
}
