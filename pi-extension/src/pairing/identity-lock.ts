import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const IDENTITY_LOCK_RELEASE_AFTER = Symbol("identity-lock-release-after");
/** 等待其他 Pi 进程释放身份锁的默认上限与轮询间隔。 */
export const IDENTITY_LOCK_WAIT_TIMEOUT_MS = 15_000;
export const IDENTITY_LOCK_POLL_INTERVAL_MS = 50;
export const IDENTITY_LOCK_WRITE_GRACE_MS = 1_000;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface IdentityLockDeferredRelease {
  readonly [IDENTITY_LOCK_RELEASE_AFTER]: Promise<void>;
}

export interface IdentityLockOptions {
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export class IdentityLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, waitTimeoutMs: number) {
    super(
      `Identity initialization lock remained held for ${waitTimeoutMs}ms at ${lockPath}. ` +
      "Another process may still be initializing the identity, or a previous process may " +
      "have left a lock whose ownership cannot safely be determined. Only confirmed dead " +
      "process locks or aged malformed locks are recovered automatically.",
    );
    this.name = "IdentityLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class IdentityLockPublicationError extends Error {
  constructor() {
    super(
      "Cannot publish the identity initialization lock. A local filesystem supporting hard links " +
      "and permission to create links in the identity directory are required. " +
      "Check the identity directory permissions and filesystem capabilities; no unsafe fallback was attempted.",
    );
    this.name = "IdentityLockPublicationError";
  }
}

interface HeldIdentityLock {
  readonly handle: FileHandle;
  readonly path: string;
  readonly token: string;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensurePrivateIdentityDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

function temporaryLockPath(directory: string): string {
  return join(directory, `identity-lock-${process.pid}-${randomUUID()}.tmp`);
}

async function tryAcquire(directory: string, lockPath: string): Promise<HeldIdentityLock | null> {
  const temporary = temporaryLockPath(directory);
  const handle = await open(temporary, "wx", 0o600);
  const token = randomUUID();
  let published = false;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    await handle.sync();
    try {
      await link(temporary, lockPath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "EEXIST")) return null;
      throw new IdentityLockPublicationError();
    }
    published = true;
    return { handle, path: lockPath, token };
  } finally {
    await unlink(temporary).catch(() => undefined);
    if (!published) await handle.close();
  }
}

interface LockSnapshot {
  readonly stat: Stats;
  readonly raw: string;
}

function sameObject(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function snapshot(path: string): Promise<LockSnapshot | null> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !sameObject(before, stat)) return null;
    const raw = await handle.readFile("utf8");
    const after = await handle.stat();
    if (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) return null;
    return { stat, raw };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ELOOP")) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function confirmedDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isNodeErrorWithCode(error, "ESRCH");
  }
}

function recoveryReason(value: LockSnapshot): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value.raw); } catch { /* 按旧版本写入窗口处理。 */ }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 &&
        typeof record.token === "string" && LOCK_TOKEN_PATTERN.test(record.token) &&
        typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)) &&
        new Date(record.createdAt).toISOString() === record.createdAt) {
      return confirmedDead(record.pid) ? "dead process" : null;
    }
    // 即使其他字段损坏，也不能抢占仍可能存活的明确持有者。
    if (typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 &&
        !confirmedDead(record.pid)) return null;
  }
  return Date.now() - value.stat.mtimeMs >= IDENTITY_LOCK_WRITE_GRACE_MS ? "aged malformed lock" : null;
}

async function cleanDeadClaims(directory: string, old: LockSnapshot): Promise<void> {
  for (const name of await readdir(directory)) {
    const match = /^identity-lock-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || !confirmedDead(pid)) continue;
    const path = join(directory, name);
    try {
      const stat = await lstat(path);
      if (stat.isFile() && sameObject(stat, old.stat)) await unlink(path);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    }
  }
}

async function recoverStaleLock(directory: string, lockPath: string): Promise<boolean> {
  const old = await snapshot(lockPath);
  if (!old) return false;
  const reason = recoveryReason(old);
  if (!reason) return false;
  await cleanDeadClaims(directory, old);
  const claim = temporaryLockPath(directory);
  try {
    await link(lockPath, claim);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    const claimed = await snapshot(claim);
    if (!claimed || !sameObject(old.stat, claimed.stat) || claimed.stat.nlink !== 2) return false;
    const current = await snapshot(lockPath);
    if (!current || !sameObject(old.stat, current.stat) || current.raw !== old.raw ||
        current.stat.mtimeMs !== old.stat.mtimeMs || !recoveryReason(current)) return false;
    // claim 保留到删除结束：其他恢复者的 nlink 检查不可能同时通过，
    // 而路径已被替换的恢复者也无法把新锁误认成旧 inode。
    await unlink(lockPath);
    console.warn(`[pi-reach] Recovered identity initialization lock: ${reason}`);
    return true;
  } finally {
    await unlink(claim).catch(() => undefined);
  }
}

async function acquireIdentityLock(
  directory: string,
  options: IdentityLockOptions,
): Promise<HeldIdentityLock> {
  await ensurePrivateIdentityDirectory(directory);
  const lockPath = join(directory, "identity.lock");
  const waitTimeoutMs = options.waitTimeoutMs ?? IDENTITY_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? IDENTITY_LOCK_POLL_INTERVAL_MS);
  const deadline = Date.now() + Math.max(0, waitTimeoutMs);

  while (true) {
    const held = await tryAcquire(directory, lockPath);
    if (held) return held;
    if (await recoverStaleLock(directory, lockPath)) continue;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new IdentityLockTimeoutError(lockPath, waitTimeoutMs);
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

async function releaseIdentityLock(lock: HeldIdentityLock): Promise<void> {
  try {
    let raw: string;
    try {
      raw = await readFile(lock.path, "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      throw error;
    }

    let token: unknown;
    try {
      token = (JSON.parse(raw) as { token?: unknown }).token;
    } catch {
      return;
    }
    if (token !== lock.token) return;
    await unlink(lock.path);
  } finally {
    await lock.handle.close();
  }
}

function deferredRelease(error: unknown): Promise<void> | null {
  if (typeof error !== "object" || error === null) return null;
  const settled = (error as Partial<IdentityLockDeferredRelease>)[IDENTITY_LOCK_RELEASE_AFTER];
  return settled instanceof Promise ? settled : null;
}

export async function withIdentityLock<T>(
  directory: string,
  operation: () => Promise<T>,
  options: IdentityLockOptions = {},
): Promise<T> {
  const lock = await acquireIdentityLock(directory, options);
  let releaseWasDeferred = false;
  try {
    return await operation();
  } catch (error) {
    const settled = deferredRelease(error);
    if (settled) {
      releaseWasDeferred = true;
      void settled.then(
        () => releaseIdentityLock(lock),
        () => releaseIdentityLock(lock),
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!releaseWasDeferred) await releaseIdentityLock(lock);
  }
}
