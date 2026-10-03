import { constants, chmodSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import { AttachmentStoreError, nodeErrorHasCode } from "./types.js";

export function assertDirectories(directory: string): void {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AttachmentStoreError("invalid_upload");
  }
}

export function ensurePrivateDirectory(directory: string): void {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!nodeErrorHasCode(error, "EEXIST")) throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AttachmentStoreError("invalid_upload");
  }
  chmodSync(absolute, 0o700);
}

export function assertRegularFile(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AttachmentStoreError("invalid_upload");
  return stat;
}

export async function createPrivateFile(path: string): Promise<FileHandle> {
  return open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
}

export async function readPrivateFile(path: string, maximumBytes: number): Promise<string> {
  assertRegularFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new AttachmentStoreError("io_error");
    // 限长读取，不能在 stat 后使用无界 readFile。
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maximumBytes) throw new AttachmentStoreError("io_error");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}
