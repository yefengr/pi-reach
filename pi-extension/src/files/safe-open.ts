import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";

export type FileAccessCode = "not_available" | "permission_denied" | "not_regular_file" | "too_large" | "file_changed" | "io_error";

export class FileAccessError extends Error {
  /** 仅当关闭失败时由调用者接管并重试回收；不能把该资源计作已释放。 */
  handle?: FileHandle;
  closeError?: unknown;

  constructor(public readonly code: FileAccessCode) {
    super(code);
    this.name = "FileAccessError";
  }
}

function nodeCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function accessError(error: unknown): FileAccessError {
  if (error instanceof FileAccessError) return error;
  switch (nodeCode(error)) {
    case "EACCES": case "EPERM": return new FileAccessError("permission_denied");
    case "ENOENT": case "ENOTDIR": return new FileAccessError("not_available");
    case "ELOOP": return new FileAccessError("file_changed");
    default: return new FileAccessError("io_error");
  }
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function parentIdentities(path: string): Promise<BigIntStats[]> {
  const directory = dirname(path);
  let current = parse(directory).root;
  const parents: BigIntStats[] = [];
  for (const part of ["", ...directory.slice(current.length).split(sep).filter(Boolean)]) {
    if (part) current = resolve(current, part);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FileAccessError("file_changed");
    parents.push(stat);
  }
  return parents;
}

function assertRegular(stat: BigIntStats, maxBytes: number): void {
  if (!stat.isFile()) throw new FileAccessError("not_regular_file");
  if (stat.size > BigInt(maxBytes)) throw new FileAccessError("too_large");
}

async function verifyOpenedPath(path: string, before: BigIntStats, parents: BigIntStats[], opened: BigIntStats): Promise<void> {
  try {
    const afterParents = await parentIdentities(path);
    if (afterParents.length !== parents.length || afterParents.some((stat, index) => !sameIdentity(stat, parents[index]!))) {
      throw new FileAccessError("file_changed");
    }
    const after = await lstat(path, { bigint: true });
    if (after.isSymbolicLink() || !sameFile(before, opened) || !sameFile(opened, after) || await realpath(path) !== path) {
      throw new FileAccessError("file_changed");
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(nodeCode(error) ?? "")) throw new FileAccessError("file_changed");
    throw error;
  }
}

/**
 * 返回的句柄由调用者关闭。路径检查不提供原子文件快照；后续读取仍须核验同一句柄属性。
 * NONBLOCK 防普通文件被 FIFO 替换时阻塞，不提供恶意文件系统内核 I/O 的硬取消。
 */
export async function openSourceFile(path: string, options: { resolveLinks: boolean; maxBytes: number }): Promise<{
  handle: FileHandle; path: string; stat: BigIntStats;
}> {
  let handle: FileHandle | undefined;
  try {
    // Windows 的 Node 打开标志没有等价的 no-follow/non-block 保证，明确 fail closed。
    if (!["darwin", "linux"].includes(process.platform) || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
      throw new FileAccessError("not_available");
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || !path || path.includes("\0")) {
      throw new FileAccessError("io_error");
    }
    if (!options.resolveLinks && (!isAbsolute(path) || resolve(path) !== path)) throw new FileAccessError("file_changed");
    const canonical = await realpath(path);
    if (!options.resolveLinks && canonical !== path) throw new FileAccessError("file_changed");
    const parents = await parentIdentities(canonical);
    const before = await lstat(canonical, { bigint: true });
    if (before.isSymbolicLink()) throw new FileAccessError("file_changed");
    assertRegular(before, options.maxBytes);
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat({ bigint: true });
    assertRegular(stat, options.maxBytes);
    await verifyOpenedPath(canonical, before, parents, stat);
    return { handle, path: canonical, stat };
  } catch (error) {
    const failure = accessError(error);
    if (handle) {
      try { await handle.close(); } catch (closeError) {
        failure.handle = handle;
        failure.closeError = closeError;
      }
    }
    throw failure;
  }
}
