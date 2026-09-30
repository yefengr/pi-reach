import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const IDENTITY_LOCK_RELEASE_AFTER = Symbol("identity-lock-release-after");

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
      "have exited unexpectedly. The lock is never removed automatically. Confirm that no " +
      "identity initialization or keyring operation is still running before removing it manually.",
    );
    this.name = "IdentityLockTimeoutError";
    this.lockPath = lockPath;
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

async function tryAcquire(lockPath: string): Promise<HeldIdentityLock | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) return null;
    throw error;
  }

  const token = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    await handle.sync();
    return { handle, path: lockPath, token };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

async function acquireIdentityLock(
  directory: string,
  options: IdentityLockOptions,
): Promise<HeldIdentityLock> {
  await ensurePrivateIdentityDirectory(directory);
  const lockPath = join(directory, "identity.lock");
  const waitTimeoutMs = options.waitTimeoutMs ?? 15_000;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const deadline = Date.now() + Math.max(0, waitTimeoutMs);

  while (true) {
    const held = await tryAcquire(lockPath);
    if (held) return held;

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
