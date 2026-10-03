import { constants, chmodSync, lstatSync, mkdirSync, rmdirSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, parse, resolve, sep } from "node:path";
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

export interface OwnedDirectory {
  path: string;
  inode?: number;
  device?: number;
}

/** mkdir 与 identity 获取同步相邻；既有目录绝不成为本次上传的资源。 */
export function createOwnedDirectory(path: string, recordCreated: (directory: OwnedDirectory) => void): OwnedDirectory {
  assertDirectories(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if (nodeErrorHasCode(error, "EEXIST")) throw new AttachmentStoreError("invalid_upload");
    throw error;
  }
  // mkdir 成功即转移资源，identity 获取失败也不得让有界账本漏掉已创建目录。
  const directory: OwnedDirectory = { path };
  recordCreated(directory);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AttachmentStoreError("invalid_upload");
  directory.inode = stat.ino;
  directory.device = stat.dev;
  return directory;
}

export function assertOwnedDirectory(directory: OwnedDirectory): void {
  // 缺失创建时证据不能靠后续 stat 补齐，也不能因路径消失就提交成功清理。
  if (directory.inode === undefined || directory.device === undefined) throw new AttachmentStoreError("invalid_upload");
  assertDirectories(dirname(directory.path));
  const stat = lstatSync(directory.path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== directory.inode || stat.dev !== directory.device) {
    throw new AttachmentStoreError("invalid_upload");
  }
}

/** 只移除仍归本次上传所有的空目录，绝不递归删除或接管替换目录。 */
export function removeOwnedDirectory(directory: OwnedDirectory): void {
  try {
    assertOwnedDirectory(directory);
    rmdirSync(directory.path);
  } catch (error) {
    if (!nodeErrorHasCode(error, "ENOENT")) throw error;
  }
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
