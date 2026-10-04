import { mkdtemp, open, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectFile } from "./content-type.js";

let directory: string;
let sequence = 0;
let handles: FileHandle[];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "pi-reach-type-")));
  handles = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.map((handle) => handle.close()));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(bytes: Buffer | string): Promise<FileHandle> {
  const path = join(directory, `${sequence++}`);
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  handles.push(handle);
  return handle;
}
async function inspect(bytes: Buffer | string, name = "file.bin") {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return inspectFile(await fixture(buffer), buffer.length, name);
}
function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 6;
  return Buffer.concat([head, Buffer.from("000000014944415400000000000000000049454e4400000000", "hex")]);
}
function gif(width: number, height: number): Buffer {
  const head = Buffer.alloc(19);
  head.write("GIF89a", 0, "ascii");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[10] = 0x80;
  const frame = Buffer.from("2c00000000000000000002024401003b", "hex");
  frame.writeUInt16LE(width, 5);
  frame.writeUInt16LE(height, 7);
  return Buffer.concat([head, frame]);
}
function jpeg(width: number, height: number): Buffer {
  const head = Buffer.from("ffd8ffe000040000ffc0000b080000000001011100", "hex");
  head.writeUInt16BE(height, 13);
  head.writeUInt16BE(width, 15);
  return head;
}
function webp(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(20 + data.length + (data.length & 1));
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(head.length - 8, 4);
  head.write("WEBP", 8, "ascii");
  head.write(type, 12, "ascii");
  head.writeUInt32LE(data.length, 16);
  data.copy(head, 20);
  return head;
}
function webpx(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  const extended = webp("VP8X", data);
  const bytes = Buffer.concat([extended, webp("VP8L", lossless).subarray(12)]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

describe("inspectFile", () => {
  it.each([
    ["PNG", png(640, 480), "image/png"],
    ["JPEG", jpeg(640, 480), "image/jpeg"],
    ["GIF", gif(640, 480), "image/gif"],
    ["WebP extended", webpx(640, 480), "image/webp"],
  ])("recognizes %s dimensions from bytes, not extension", async (_name, bytes, mimeType) => {
    expect(await inspect(bytes as Buffer, "fake.md")).toEqual({ mimeType, preview: { kind: "image", width: 640, height: 480 } });
  });

  it("recognizes WebP lossy and lossless dimensions", async () => {
    const lossy = Buffer.alloc(10);
    Buffer.from("9d012a", "hex").copy(lossy, 3);
    lossy.writeUInt16LE(640, 6);
    lossy.writeUInt16LE(480, 8);
    const lossless = Buffer.alloc(5);
    lossless[0] = 0x2f;
    lossless.writeUInt32LE(639 | (479 << 14), 1);
    for (const bytes of [webp("VP8 ", lossy), webp("VP8L", lossless)]) {
      expect(await inspect(bytes)).toEqual({ mimeType: "image/webp", preview: { kind: "image", width: 640, height: 480 } });
    }
    lossless[4] = 0xe0;
    expect((await inspect(webp("VP8L", lossless))).preview.kind).toBe("none");
  });

  it.each([
    [png(5000, 4000), "image/png", "image"],
    [png(5001, 4000), "image/png", "none"],
    [gif(5001, 4000), "image/gif", "none"],
    [jpeg(5001, 4000), "image/jpeg", "none"],
    [webpx(5001, 4000), "image/webp", "none"],
    [png(0, 10), "image/png", "none"],
    [gif(0, 10), "image/gif", "none"],
    [png(0xffffffff, 10), "image/png", "none"],
  ])("keeps MIME and enforces dimensions/pixel budget %#", async (bytes, mimeType, kind) => {
    expect(await inspect(bytes as Buffer)).toMatchObject({ mimeType, preview: { kind } });
  });

  it.each([
    [png(10, 10).subarray(0, 24), "image/png"],
    [gif(10, 10).subarray(0, 8), "image/gif"],
    [jpeg(10, 10).subarray(0, 17), "image/jpeg"],
    [webpx(10, 10).subarray(0, 24), "image/webp"],
    [Buffer.from("ffd8ffda0002", "hex"), "image/jpeg"],
  ])("does not invent dimensions for truncated/malformed image %#", async (bytes, mimeType) => {
    expect(await inspect(bytes as Buffer)).toEqual({ mimeType, preview: { kind: "none" } });
  });

  it("rejects invalid PNG IHDR, missing GIF table and invalid WebP header", async () => {
    const invalidPng = png(10, 10);
    invalidPng[24] = 3;
    const invalidGif = gif(10, 10);
    invalidGif[10] = 0x87;
    const invalidWebp = webpx(10, 10);
    invalidWebp[20] = 0x80;
    for (const bytes of [invalidPng, invalidGif, invalidWebp]) expect((await inspect(bytes)).preview.kind).toBe("none");
  });

  it.each(["", "hello\n世界\t🌍\r\n", "\ufeff# 标题", "<script>alert(1)</script>", "<svg><script/></svg>"])("treats valid text and executable markup only as escaped text: %s", async (text) => {
    expect(await inspect(text, "file.html")).toEqual({ mimeType: "text/plain", preview: { kind: "text" } });
  });

  it("uses Markdown extension only after content passes UTF-8/binary checks", async () => {
    for (const name of ["notes.MD", "notes.markdown"]) {
      expect(await inspect("# hello", name)).toEqual({ mimeType: "text/markdown", preview: { kind: "text" } });
    }
    expect(await inspect(Buffer.from([0, 1]), "fake.md")).toEqual({ mimeType: "application/octet-stream", preview: { kind: "none" } });
    expect((await inspect("<svg/>", "file.svg")).preview.kind).toBe("text");
  });

  it.each([
    Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xe4, 0xb8]), Buffer.from([0, 65]), Buffer.from([65, 0x7f]),
    Buffer.from([0x1b, 91, 109]), Buffer.from("a\u0085b"), Buffer.from([0xff, 0xfe, 65, 0]),
  ])("refuses malformed UTF-8 and binary controls %#", async (bytes) => {
    expect(await inspect(bytes, "text.txt")).toEqual({ mimeType: "application/octet-stream", preview: { kind: "none" } });
  });

  it("allows incomplete UTF-8 only at a budget-truncated tail, with strictly bounded handle.read", async () => {
    for (const text of ["世", "🌍"]) {
      for (let cut = 1; cut < Buffer.byteLength(text); cut++) {
        const bytes = Buffer.concat([Buffer.alloc(256 * 1024 - cut, 65), Buffer.from(text)]);
        const handle = await fixture(bytes);
        const read = vi.spyOn(handle, "read");
        expect(await inspectFile(handle, bytes.length, "large.txt")).toMatchObject({ preview: { kind: "text" } });
        const totalRequested = read.mock.calls.reduce((sum, args) => sum + Number(args[2]), 0);
        expect(totalRequested).toBeLessThanOrEqual(256 * 1024);
        expect(read.mock.calls.every((args) => Number(args[3]) + Number(args[2]) <= 256 * 1024)).toBe(true);
      }
    }
    const malformed = Buffer.concat([Buffer.alloc(256 * 1024 - 2, 65), Buffer.from([0xe0, 0x80, 0x80])]);
    expect((await inspect(malformed)).preview.kind).toBe("none");
  });

  it("handles partial reads and preserves the caller's handle position/ownership", async () => {
    const handle = await fixture("hello world");
    const originalRead = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) =>
      originalRead(buffer, offset, Math.min(length, 2), position)) as typeof handle.read);
    expect(await inspectFile(handle, 11, "file.txt")).toMatchObject({ preview: { kind: "text" } });
    const byte = Buffer.alloc(1);
    await originalRead(byte, 0, 1, null);
    expect(byte.toString()).toBe("h");
    expect((await handle.stat()).isFile()).toBe(true);
  });

  it("retains PDF/ZIP MIME without executing content, ignoring deceptive suffixes", async () => {
    expect(await inspect("%PDF-1.7\n", "file.md")).toEqual({ mimeType: "application/pdf", preview: { kind: "none" } });
    for (const magic of ["504b0304", "504b0506", "504b0708"]) {
      expect(await inspect(Buffer.from(magic, "hex"), "file.png")).toEqual({ mimeType: "application/zip", preview: { kind: "none" } });
    }
    expect((await inspect("not an image", "fake.png")).mimeType).toBe("text/plain");
  });

  it("requires exact byte signatures rather than lossy ASCII aliases", async () => {
    for (const bytes of [gif(10, 10), webpx(10, 10), Buffer.from("%PDF-1.7")]) {
      bytes[0] = bytes[0]! | 0x80;
      expect((await inspect(bytes)).mimeType).toBe("application/octet-stream");
    }
    const badChunk = png(10, 10);
    badChunk[12] = badChunk[12]! | 0x80;
    expect(await inspect(badChunk)).toEqual({ mimeType: "image/png", preview: { kind: "none" } });
  });

  it("retains JPEG MIME when dimension metadata lies outside the header budget", async () => {
    const segment = Buffer.alloc(65537);
    segment.set([0xff, 0xe1, 0xff, 0xff]);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array<Buffer>(5).fill(segment), jpeg(10, 10).subarray(2)]);
    const handle = await fixture(bytes);
    const read = vi.spyOn(handle, "read");
    expect(await inspectFile(handle, bytes.length, "late.jpg")).toEqual({ mimeType: "image/jpeg", preview: { kind: "none" } });
    expect(read.mock.calls.reduce((sum, args) => sum + Number(args[2]), 0)).toBeLessThanOrEqual(256 * 1024);
  });

  it("reports premature EOF/read errors and leaves the caller-owned handle open", async () => {
    const handle = await fixture("short");
    await expect(inspectFile(handle, 10, "file.txt")).rejects.toMatchObject({ code: "file_changed" });
    expect((await handle.stat()).isFile()).toBe(true);
    const error = new Error("read failed");
    vi.spyOn(handle, "read").mockRejectedValueOnce(error);
    await expect(inspectFile(handle, 5, "file.txt")).rejects.toBe(error);
    await expect(inspectFile(handle, -1, "file.txt")).rejects.toMatchObject({ code: "io_error" });
  });
});
