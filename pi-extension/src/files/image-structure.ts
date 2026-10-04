import type { FileHandle } from "node:fs/promises";
import { FileAccessError } from "./safe-open.js";

export type Dimensions = { width: number; height: number };
export const MAX_INSPECTION_READS = 4096;
const MAX_STRUCTURE_STEPS = 4096;
const MAX_METADATA_BYTES = 64 * 1024;
const PNG_ANCILLARY = new Set(["cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "bKGD", "hIST", "tRNS", "pHYs", "sPLT", "tIME", "iTXt", "tEXt", "zTXt", "eXIf", "cICP", "mDCV", "cLLI"]);

/** 只读取结构元数据；压缩数据按长度跳过，不认证像素内容或 CRC。 */
export class ImageStructureReader {
  private steps = 0;
  private metadataBytes = 0;
  constructor(private readonly handle: FileHandle, readonly head: Buffer, readonly byteLength: number, private reads: number) {}

  step(): boolean { return ++this.steps <= MAX_STRUCTURE_STEPS; }

  async get(position: number, length: number): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(position) || position < 0 || length < 0 || position + length > this.byteLength) return undefined;
    if (position + length <= this.head.length) return this.head.subarray(position, position + length);
    const buffer = Buffer.alloc(length);
    let offset = Math.max(0, Math.min(length, this.head.length - position));
    if (offset) this.head.copy(buffer, 0, position, position + offset);
    while (offset < length) {
      const requested = length - offset;
      // 按请求字节计费，短 read 也不能反复请求而突破 metadata I/O 预算。
      if (this.reads >= MAX_INSPECTION_READS || this.metadataBytes + requested > MAX_METADATA_BYTES) return undefined;
      this.reads++;
      this.metadataBytes += requested;
      const { bytesRead } = await this.handle.read(buffer, offset, requested, position + offset);
      if (bytesRead === 0) throw new FileAccessError("file_changed");
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) throw new FileAccessError("io_error");
      offset += bytesRead;
    }
    return buffer;
  }
}

function pngHeader(head: Buffer): Dimensions | undefined {
  if (head.length < 33 || head.readUInt32BE(8) !== 13 || head.toString("latin1", 12, 16) !== "IHDR") return undefined;
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[head[25]!]?.includes(head[24]!) || head[26] !== 0 || head[27] !== 0 || head[28]! > 1) return undefined;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return undefined;
  return { width, height };
}

export async function staticPng(reader: ImageStructureReader): Promise<Dimensions | undefined> {
  const dimensions = pngHeader(reader.head);
  if (!dimensions) return undefined;
  let position = 33;
  let dataSeen = false;
  let dataStarted = false;
  let dataEnded = false;
  let paletteSeen = false;
  while (position < reader.byteLength && reader.step()) {
    const header = await reader.get(position, 8);
    if (!header) return undefined;
    const length = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    const end = position + 12 + length;
    if (length > 0x7fffffff || end > reader.byteLength) return undefined;
    // 动画声明在任何位置都不能放行；IEND 后也不得保留浏览器可解释的尾部。
    if (["acTL", "fcTL", "fdAT"].includes(type)) return undefined;
    if (type === "IEND") {
      if (length !== 0 || !dataSeen || end !== reader.byteLength) return undefined;
      return await reader.get(position + 8, 4) ? dimensions : undefined;
    }
    if (type === "IDAT") {
      if (dataEnded || (reader.head[25] === 3 && !paletteSeen)) return undefined;
      dataStarted = true;
      if (length > 0) dataSeen = true;
    } else {
      if (dataStarted) dataEnded = true;
      if (type === "PLTE") {
        if (paletteSeen || dataStarted || !length || length > 768 || length % 3 || [0, 4].includes(reader.head[25]!)) return undefined;
        paletteSeen = true;
      } else if (!PNG_ANCILLARY.has(type)) return undefined;
    }
    // 中间 payload/checksum 按长度跳过，最终 IEND checksum 稀疏读确认 EOF。
    position = end;
  }
  return undefined;
}

function webpPayload(type: string, data: Buffer): Dimensions | undefined {
  if (type === "VP8 ") {
    if (data.length < 10 || data[0]! & 1 || data.toString("hex", 3, 6) !== "9d012a") return undefined;
    return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
  }
  if (data.length < 5 || data[0] !== 0x2f) return undefined;
  const bits = data.readUInt32LE(1);
  if (bits >>> 29 !== 0) return undefined;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

export async function staticWebp(reader: ImageStructureReader): Promise<Dimensions | undefined> {
  if (reader.head.readUInt32LE(4) + 8 !== reader.byteLength) return undefined;
  let position = 12;
  let canvas: Dimensions | undefined;
  let dimensions: Dimensions | undefined;
  let flags = 0;
  let imageType: string | undefined;
  const seen = new Set<string>();
  let losslessAlpha = false;
  while (position < reader.byteLength && reader.step()) {
    const header = await reader.get(position, 8);
    if (!header) return undefined;
    const type = header.toString("latin1", 0, 4);
    const length = header.readUInt32LE(4);
    const start = position + 8;
    const end = start + length + (length & 1);
    if (end > reader.byteLength || seen.has(type) || type === "ANIM" || type === "ANMF") return undefined;
    seen.add(type);
    if (type === "VP8X") {
      const data = length === 10 && position === 12 ? await reader.get(start, 10) : undefined;
      if (!data || data[0]! & 0xc3 || data[1] || data[2] || data[3]) return undefined;
      flags = data[0]!;
      canvas = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
    } else if (type === "VP8 " || type === "VP8L") {
      if (dimensions || (seen.has("ALPH") && type !== "VP8 ")) return undefined;
      const required = type === "VP8 " ? 10 : 5;
      const data = length >= required ? await reader.get(start, required) : undefined;
      if (!data) return undefined;
      dimensions = webpPayload(type, data);
      if (!dimensions || !dimensions.width || !dimensions.height) return undefined;
      imageType = type;
      losslessAlpha = type === "VP8L" && !!(data[4]! & 0x10);
      if (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height)) return undefined;
    } else if (type === "ICCP" || type === "ALPH" || type === "EXIF" || type === "XMP ") {
      if (!canvas || !length) return undefined;
      if ((type === "ICCP" || type === "ALPH") && dimensions) return undefined;
      if ((type === "EXIF" || type === "XMP ") && !dimensions) return undefined;
      if (type === "ALPH") {
        const data = await reader.get(start, 1);
        if (!data || data[0]! & 0xc0 || (data[0]! & 3) > 1 || ((data[0]! >> 4) & 3) > 1) return undefined;
      }
    } else return undefined;
    if (length & 1) {
      const padding = await reader.get(end - 1, 1);
      if (!padding || padding[0] !== 0) return undefined;
    }
    position = end;
  }
  if (position !== reader.byteLength || !dimensions) return undefined;
  if (canvas && (Boolean(flags & 0x20) !== seen.has("ICCP") || Boolean(flags & 0x08) !== seen.has("EXIF")
    || Boolean(flags & 0x04) !== seen.has("XMP ") || Boolean(flags & 0x10) !== (seen.has("ALPH") || losslessAlpha))) return undefined;
  if (!canvas && (seen.size !== 1 || (imageType !== "VP8 " && imageType !== "VP8L"))) return undefined;
  // 即使最后一个压缩 payload 没有 padding，也确认声明的文件末字节存在。
  return await reader.get(reader.byteLength - 1, 1) ? dimensions : undefined;
}

export function staticGif(head: Buffer, byteLength: number): Dimensions | undefined {
  // GIF 的压缩块不能稀疏跳过证明帧数；超过已有头预算时仅提供下载。
  if (head.length !== byteLength || head.length < 13) return undefined;
  const dimensions = { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  if (!dimensions.width || !dimensions.height) return undefined;
  const globalTable = !!(head[10]! & 0x80);
  let position = 13 + (globalTable ? 3 * 2 ** ((head[10]! & 7) + 1) : 0);
  let steps = 0;
  let frames = 0;
  let controlPending = false;
  const step = () => ++steps <= MAX_STRUCTURE_STEPS;
  const subblocks = (requireData: boolean): boolean => {
    let dataSeen = false;
    while (position < head.length && step()) {
      const length = head[position++]!;
      if (!length) return !requireData || dataSeen;
      dataSeen = true;
      position += length;
      if (position > head.length) return false;
    }
    return false;
  };
  while (position < head.length && step()) {
    const type = head[position++]!;
    if (type === 0x3b) return frames === 1 && !controlPending && position === head.length ? dimensions : undefined;
    if (type === 0x21) {
      const label = head[position++];
      if (label === 0xf9) {
        if (controlPending || position + 6 > head.length || head[position] !== 4 || head[position + 5] !== 0) return undefined;
        const packed = head[position + 1]!;
        if (packed & 0xe0 || ((packed >> 2) & 7) > 3) return undefined;
        controlPending = true;
        position += 6;
      } else if (label === 0xfe) {
        if (!subblocks(false)) return undefined;
      } else {
        // Plain Text 可产生额外渲染；应用扩展语义未知，不能证明静态。
        return undefined;
      }
      continue;
    }
    if (type !== 0x2c || ++frames !== 1 || position + 9 > head.length) return undefined;
    const left = head.readUInt16LE(position);
    const top = head.readUInt16LE(position + 2);
    const width = head.readUInt16LE(position + 4);
    const height = head.readUInt16LE(position + 6);
    const packed = head[position + 8]!;
    if (!width || !height || left + width > dimensions.width || top + height > dimensions.height || packed & 0x18) return undefined;
    const localTable = !!(packed & 0x80);
    if (!globalTable && !localTable) return undefined;
    position += 9 + (localTable ? 3 * 2 ** ((packed & 7) + 1) : 0);
    if (position >= head.length || head[position]! < 2 || head[position]! > 8) return undefined;
    position++;
    if (!subblocks(true)) return undefined;
    controlPending = false;
  }
  return undefined;
}
