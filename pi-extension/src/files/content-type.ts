import type { FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { FileAccessError } from "./safe-open.js";
import { ImageStructureReader, MAX_INSPECTION_READS, staticGif, staticPng, staticWebp, type Dimensions } from "./image-structure.js";

const HEAD_MAX_BYTES = 256 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
type Preview = ({ kind: "image" } & Dimensions) | { kind: "text" } | { kind: "none" };
type Inspection = { mimeType: string; preview: Preview };
const NONE: Preview = { kind: "none" };

function image(mimeType: string, dimensions: Dimensions | undefined): Inspection {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return { mimeType, preview: NONE };
  }
  return { mimeType, preview: { kind: "image", ...dimensions } };
}

function jpegDimensions(head: Buffer): Dimensions | undefined {
  let offset = 2;
  while (offset < head.length) {
    if (head[offset++] !== 0xff) return undefined;
    while (head[offset] === 0xff) offset++;
    if (offset >= head.length) return undefined;
    const marker = head[offset++]!;
    if (marker === 0xd9 || marker === 0xda || marker === 0x00 || marker === 0xd8) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > head.length) return undefined;
    const length = head.readUInt16BE(offset);
    if (length < 2 || offset + length > head.length) return undefined;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (length < 8) return undefined;
      const components = head[offset + 7]!;
      if (components < 1 || components > 4 || length !== 8 + 3 * components || ![8, 12, 16].includes(head[offset + 2]!)) return undefined;
      return { width: head.readUInt16BE(offset + 5), height: head.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

function isText(head: Buffer, truncated: boolean): boolean {
  for (const byte of head) {
    if ((byte < 0x20 && ![9, 10, 13].includes(byte)) || byte === 0x7f) return false;
  }
  try {
    // 仅因头预算截断时允许末尾码点未完整；完整文件仍须 fatal 验证尾部。
    const text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: truncated });
    return !/[\u0080-\u009f]/u.test(text);
  } catch { return false; }
}

/** 有界头识别不是完整解码认证；HTML/SVG 与所有文本都只能由消费端转义显示。 */
export async function inspectFile(handle: FileHandle, byteLength: number, fileName: string): Promise<Inspection> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new FileAccessError("io_error");
  const buffer = Buffer.alloc(Math.min(byteLength, HEAD_MAX_BYTES));
  let offset = 0;
  let reads = 0;
  // 保留短 read 的续读语义；实读头字节受 buffer 限制，重试另受操作预算限制。
  while (offset < buffer.length && reads < MAX_INSPECTION_READS) {
    const requested = buffer.length - offset;
    reads++;
    const { bytesRead } = await handle.read(buffer, offset, requested, offset);
    if (bytesRead === 0) throw new FileAccessError("file_changed");
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) throw new FileAccessError("io_error");
    offset += bytesRead;
  }
  const head = buffer.subarray(0, offset);
  const completeHead = offset === buffer.length;
  const reader = new ImageStructureReader(handle, head, byteLength, reads);
  if (head.length >= 8 && head.toString("hex", 0, 8) === "89504e470d0a1a0a") return image("image/png", completeHead ? await staticPng(reader) : undefined);
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return image("image/jpeg", completeHead ? jpegDimensions(head) : undefined);
  if (head.length >= 6 && ["GIF87a", "GIF89a"].includes(head.toString("latin1", 0, 6))) return image("image/gif", completeHead ? staticGif(head, byteLength) : undefined);
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return image("image/webp", completeHead ? await staticWebp(reader) : undefined);
  }
  if (head.length >= 5 && head.toString("latin1", 0, 5) === "%PDF-") return { mimeType: "application/pdf", preview: NONE };
  if (head.length >= 4 && ["504b0304", "504b0506", "504b0708"].includes(head.toString("hex", 0, 4))) return { mimeType: "application/zip", preview: NONE };
  if (!completeHead || !isText(head, byteLength > head.length)) return { mimeType: "application/octet-stream", preview: NONE };
  const markdown = [".md", ".markdown"].includes(extname(fileName).toLowerCase());
  return { mimeType: markdown ? "text/markdown" : "text/plain", preview: { kind: "text" } };
}
