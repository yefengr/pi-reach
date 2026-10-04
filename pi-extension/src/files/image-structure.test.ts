import type { FileHandle } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inspectFile } from "./content-type.js";
import { ImageStructureReader } from "./image-structure.js";

const HEAD_BYTES = 256 * 1024;
function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  return chunk;
}
function png(...chunks: Buffer[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), ...chunks, pngChunk("IEND")]);
}
function webpChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length & 1));
  chunk.write(type, 0, "latin1"); chunk.writeUInt32LE(data.length, 4); data.copy(chunk, 8);
  return chunk;
}
const lossless = Buffer.from("2f00000000", "hex");
function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
const gifHeader = Buffer.from("47494638396101000100800000000000ffffff", "hex");
const gifFrame = Buffer.from("2c0000000001000100000202440100", "hex");
const staticGif = Buffer.concat([gifHeader, gifFrame, Buffer.from([0x3b])]);
function access(bytes: Buffer, partial = Infinity) {
  const reads: { length: number; actual: number; position: number }[] = [];
  const handle = { read: async (target: Buffer, offset: number, length: number, position: number) => {
    const actual = Math.min(length, partial, Math.max(0, bytes.length - position));
    bytes.copy(target, offset, position, position + actual);
    reads.push({ length, actual, position });
    return { bytesRead: actual, buffer: target };
  } } as unknown as FileHandle;
  return { handle, reads };
}
async function inspect(bytes: Buffer) {
  return inspectFile(access(bytes).handle, bytes.length, "fake.txt");
}
function expectNone(bytes: Buffer, mimeType: string) {
  return expect(inspect(bytes)).resolves.toEqual({ mimeType, preview: { kind: "none" } });
}

describe("static image structure qualification", () => {
  it("keeps structurally complete and real single-frame GIF", async () => {
    const real = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    for (const bytes of [staticGif, real]) expect((await inspect(bytes)).preview).toEqual({ kind: "image", width: 1, height: 1 });
  });

  it("rejects two or more GIF frames, including extensions between them", async () => {
    const comment = Buffer.from([0x21, 0xfe, 1, 65, 0]);
    for (const count of [2, 3, 100]) {
      await expectNone(Buffer.concat([gifHeader, ...Array<Buffer>(count).fill(gifFrame), Buffer.from([0x3b])]), "image/gif");
      await expectNone(Buffer.concat([gifHeader, gifFrame, comment, gifFrame, Buffer.from([0x3b])]), "image/gif");
    }
  });

  it("rejects small APNG and animated WebP despite a compliant canvas", async () => {
    for (const type of ["acTL", "fcTL", "fdAT"]) await expectNone(png(pngChunk(type, Buffer.alloc(26)), pngChunk("IDAT", Buffer.from([1]))), "image/png");
    for (const flag of [0, 2]) {
      const extended = Buffer.alloc(10); extended[0] = flag;
      await expectNone(webp(webpChunk("VP8X", extended), webpChunk("VP8L", lossless), webpChunk("ANIM", Buffer.alloc(6))), "image/webp");
      await expectNone(webp(webpChunk("VP8X", extended), webpChunk("ANMF", Buffer.alloc(16))), "image/webp");
    }
    const animated = Buffer.alloc(10); animated[0] = 2;
    await expectNone(webp(webpChunk("VP8X", animated), webpChunk("VP8L", lossless)), "image/webp");
  });

  it("finds animation metadata after the initial head, even after image data", async () => {
    const large = Buffer.alloc(HEAD_BYTES + 32);
    await expectNone(png(pngChunk("IDAT", large), pngChunk("acTL", Buffer.alloc(8))), "image/png");
    await expectNone(png(pngChunk("tEXt", large), pngChunk("fcTL", Buffer.alloc(26)), pngChunk("IDAT", Buffer.from([1]))), "image/png");
    await expectNone(webp(webpChunk("VP8L", Buffer.concat([lossless, large])), webpChunk("ANMF", Buffer.alloc(16))), "image/webp");
    await expectNone(webp(webpChunk("VP8X", Buffer.alloc(10)), webpChunk("VP8L", Buffer.concat([lossless, large])), webpChunk("ANIM", Buffer.alloc(6))), "image/webp");
  });

  it("qualifies large static PNG/WebP by sparse bounded metadata reads", async () => {
    const large = Buffer.alloc(HEAD_BYTES + 32);
    const extended = Buffer.alloc(10); extended[0] = 8;
    for (const bytes of [png(pngChunk("IDAT", large)), webp(webpChunk("VP8L", Buffer.concat([lossless, large]))),
      webp(webpChunk("VP8X", extended), webpChunk("VP8L", Buffer.concat([lossless, large])), webpChunk("EXIF", Buffer.from([1])))]) {
      const { handle, reads } = access(bytes);
      expect((await inspectFile(handle, bytes.length, "large.bin")).preview).toEqual({ kind: "image", width: 1, height: 1 });
      expect(reads.reduce((sum, read) => sum + read.actual, 0)).toBeLessThanOrEqual(HEAD_BYTES + 64 * 1024);
      expect(reads.length).toBeLessThanOrEqual(4096);
      expect(reads.filter(read => read.position >= HEAD_BYTES).reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("qualifies a real static PNG and a chunk header crossing the head boundary", async () => {
    const realPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9FEAAAAASUVORK5CYII=", "base64");
    for (const bytes of [realPng, png(pngChunk("IDAT", Buffer.alloc(HEAD_BYTES - 49)))]) {
      expect((await inspect(bytes)).preview).toEqual({ kind: "image", width: 1, height: 1 });
    }
  });

  it("rejects canvas/bitstream contradictions, metadata flags and nonzero padding", async () => {
    const mismatched = Buffer.alloc(10); mismatched[4] = 1;
    await expectNone(webp(webpChunk("VP8X", mismatched), webpChunk("VP8L", lossless)), "image/webp");
    for (const flag of [0x04, 0x08, 0x10, 0x20]) {
      const extended = Buffer.alloc(10); extended[0] = flag;
      await expectNone(webp(webpChunk("VP8X", extended), webpChunk("VP8L", lossless)), "image/webp");
    }
    await expectNone(webp(webpChunk("VP8X", Buffer.alloc(10)), webpChunk("VP8L", lossless), webpChunk("EXIF", Buffer.from([1]))), "image/webp");
    const nonzeroPadding = webp(webpChunk("VP8L", lossless)); nonzeroPadding[nonzeroPadding.length - 1] = 1;
    await expectNone(nonzeroPadding, "image/webp");
  });

  it("rejects GIF subimages outside the canvas or with excessive dimensions", async () => {
    for (const [offset, value] of [[1, 1], [5, 65535], [7, 65535], [5, 0]]) {
      const frame = Buffer.from(gifFrame); frame.writeUInt16LE(value!, offset);
      await expectNone(Buffer.concat([gifHeader, frame, Buffer.from([0x3b])]), "image/gif");
    }
  });

  it("rejects trailing bytes, unknown structures, missing data and bad lengths", async () => {
    for (const bytes of [png(), png(pngChunk("junk"), pngChunk("IDAT", Buffer.from([1]))),
      Buffer.concat([png(pngChunk("IDAT", Buffer.from([1]))), pngChunk("acTL")]),
      png(pngChunk("IDAT", Buffer.from([1]))).subarray(0, -1)]) await expectNone(bytes, "image/png");
    const badPng = png(pngChunk("IDAT", Buffer.from([1]))); badPng.writeUInt32BE(0xffffffff, 33);
    await expectNone(badPng, "image/png");
    for (const bytes of [webp(webpChunk("VP8X", Buffer.alloc(10))), webp(webpChunk("VP8L", lossless), webpChunk("JUNK", Buffer.alloc(0))),
      webp(webpChunk("VP8L", lossless), webpChunk("VP8L", lossless)), Buffer.concat([webp(webpChunk("VP8L", lossless)), Buffer.from([0])])]) await expectNone(bytes, "image/webp");
    const badWebp = webp(webpChunk("VP8L", lossless)); badWebp.writeUInt32LE(0xffffffff, 16);
    await expectNone(badWebp, "image/webp");
    for (const bytes of [staticGif.subarray(0, -1), Buffer.concat([staticGif, gifFrame]), Buffer.concat([gifHeader, Buffer.from([0x21, 0xff, 0])]),
      Buffer.concat([gifHeader, Buffer.from([0x01]), gifFrame, Buffer.from([0x3b])])]) await expectNone(bytes, "image/gif");
  });

  it("fails closed for structures exceeding traversal/head budgets", async () => {
    const chunk = pngChunk("tEXt", Buffer.from("key\0value"));
    expect((await inspect(png(...Array<Buffer>(4094).fill(chunk), pngChunk("IDAT", Buffer.from([1]))))).preview.kind).toBe("image");
    await expectNone(png(...Array<Buffer>(4095).fill(chunk), pngChunk("IDAT", Buffer.from([1]))), "image/png");
    await expectNone(png(...Array<Buffer>(5000).fill(chunk), pngChunk("IDAT", Buffer.from([1]))), "image/png");
    await expectNone(webp(webpChunk("VP8X", Buffer.alloc(10)), ...Array<Buffer>(5000).fill(webpChunk("EXIF", Buffer.alloc(0))), webpChunk("VP8L", lossless)), "image/webp");
    const comments = Buffer.concat([Buffer.from([0x21, 0xfe]), ...Array<Buffer>(5000).fill(Buffer.from([1, 65])), Buffer.from([0])]);
    await expectNone(Buffer.concat([gifHeader, comments, gifFrame, Buffer.from([0x3b])]), "image/gif");
    const largeComment = Buffer.concat([Buffer.from([0x21, 0xfe]), ...Array<Buffer>(1100).fill(Buffer.concat([Buffer.from([255]), Buffer.alloc(255)])), Buffer.from([0])]);
    await expectNone(Buffer.concat([gifHeader, largeComment, gifFrame, Buffer.from([0x3b])]), "image/gif");
  });

  it("bounds partial-read operations and metadata requests while keeping caller position", async () => {
    const large = png(pngChunk("IDAT", Buffer.alloc(HEAD_BYTES + 32)));
    const { handle, reads } = access(large, 1);
    expect(await inspectFile(handle, large.length, "large.png")).toEqual({ mimeType: "image/png", preview: { kind: "none" } });
    expect(reads.length).toBe(4096);
    expect(reads.reduce((sum, read) => sum + read.actual, 0)).toBeLessThanOrEqual(HEAD_BYTES + 64 * 1024);
    expect(reads.every(read => Number.isSafeInteger(read.position))).toBe(true);
    const sparse = access(large);
    const original = sparse.handle.read.bind(sparse.handle);
    sparse.handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) =>
      original(buffer, offset, position >= HEAD_BYTES ? Math.min(length, 1) : length, position)) as typeof sparse.handle.read;
    expect((await inspectFile(sparse.handle, large.length, "large.png")).preview.kind).toBe("image");
    expect(sparse.reads.filter(read => read.position >= HEAD_BYTES).reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(64 * 1024);
  });

  it("retains large UTF-8 text behavior after a recoverable short head read", async () => {
    const bytes = Buffer.alloc(HEAD_BYTES + 1, 65);
    const { handle, reads } = access(bytes, HEAD_BYTES - 1);
    expect(await inspectFile(handle, bytes.length, "large.md")).toEqual({ mimeType: "text/markdown", preview: { kind: "text" } });
    expect(reads).toHaveLength(2);
    expect(reads.reduce((sum, read) => sum + read.actual, 0)).toBe(HEAD_BYTES);
  });

  it("confirms the declared EOF even when the last large payload is skipped", async () => {
    const lossy = Buffer.from("0000009d012a01000100", "hex");
    for (const bytes of [png(pngChunk("IDAT", Buffer.alloc(HEAD_BYTES + 32))),
      webp(webpChunk("VP8 ", Buffer.concat([lossy, Buffer.alloc(HEAD_BYTES + 32)])))]) {
      const truncated = access(bytes.subarray(0, -1));
      await expect(inspectFile(truncated.handle, bytes.length, "file.bin")).rejects.toMatchObject({ code: "file_changed" });
    }
  });

  it("caps extra metadata requested bytes, including partial reads", async () => {
    const bytes = Buffer.alloc(128 * 1024);
    const full = access(bytes);
    const reader = new ImageStructureReader(full.handle, Buffer.alloc(0), bytes.length, 0);
    expect(await reader.get(0, 64 * 1024)).toHaveLength(64 * 1024);
    expect(await reader.get(64 * 1024, 1)).toBeUndefined();
    expect(full.reads.reduce((sum, read) => sum + read.length, 0)).toBe(64 * 1024);
    const partial = access(bytes, 32 * 1024);
    const shortReader = new ImageStructureReader(partial.handle, Buffer.alloc(0), bytes.length, 0);
    expect(await shortReader.get(0, 64 * 1024)).toBeUndefined();
    expect(partial.reads).toHaveLength(1);
    expect(partial.reads.reduce((sum, read) => sum + read.length, 0)).toBe(64 * 1024);
  });

  it("preserves sparse EOF/read error semantics", async () => {
    const bytes = png(pngChunk("IDAT", Buffer.alloc(HEAD_BYTES + 32)));
    const handle = access(bytes).handle;
    const original = handle.read.bind(handle);
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) =>
      position >= HEAD_BYTES ? { bytesRead: 0, buffer } : original(buffer, offset, length, position)) as typeof handle.read;
    await expect(inspectFile(handle, bytes.length, "file.png")).rejects.toMatchObject({ code: "file_changed" });
    const failure = new Error("metadata read failed");
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (position >= HEAD_BYTES) throw failure;
      return original(buffer, offset, length, position);
    }) as typeof handle.read;
    await expect(inspectFile(handle, bytes.length, "file.png")).rejects.toBe(failure);
  });
});
