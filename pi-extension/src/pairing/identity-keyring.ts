import {
  IDENTITY_LOCK_RELEASE_AFTER,
  type IdentityLockDeferredRelease,
} from "./identity-lock.js";

export interface KeyStoreBackend {
  read(service: string, account: string): Promise<string | undefined>;
  write(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export class KeyringReadTimeoutError extends Error {
  constructor(op: string, timeoutMs: number) {
    super(`keyring ${op} timed out after ${timeoutMs}ms`);
    this.name = "KeyringReadTimeoutError";
  }
}

export class KeyringMutationTimeoutError extends Error implements IdentityLockDeferredRelease {
  readonly [IDENTITY_LOCK_RELEASE_AFTER]: Promise<void>;

  constructor(op: string, timeoutMs: number, settled: Promise<void>) {
    super(`keyring ${op} timed out after ${timeoutMs}ms; the underlying operation is still pending`);
    this.name = "KeyringMutationTimeoutError";
    this[IDENTITY_LOCK_RELEASE_AFTER] = settled.then(
      () => undefined,
      () => undefined,
    );
  }
}

let keyringOperationTimeoutMs = 3_000;

export function _setKeyringOperationTimeoutForTest(timeoutMs: number | null): void {
  keyringOperationTimeoutMs = timeoutMs ?? 3_000;
}

export function _runKeyringOperationWithTimeoutForTest<T>(
  operation: Promise<T>,
  op: string,
  mutating: boolean,
  timeoutMs: number,
): Promise<T> {
  return withKeyringTimeout(operation, op, mutating, timeoutMs);
}

function withKeyringTimeout<T>(
  operation: Promise<T>,
  op: string,
  mutating: boolean,
  timeoutMs: number = keyringOperationTimeoutMs,
): Promise<T> {
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(mutating
        ? new KeyringMutationTimeoutError(op, timeoutMs, settled)
        : new KeyringReadTimeoutError(op, timeoutMs));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let asyncEntryCtor: typeof import("@napi-rs/keyring").AsyncEntry | null = null;
let nativeBindingError: unknown = null;

async function loadAsyncEntry(): Promise<typeof import("@napi-rs/keyring").AsyncEntry> {
  if (asyncEntryCtor) return asyncEntryCtor;
  if (nativeBindingError) throw nativeBindingError;
  try {
    const mod = await import("@napi-rs/keyring");
    asyncEntryCtor = mod.AsyncEntry;
    return asyncEntryCtor;
  } catch (error) {
    nativeBindingError = error;
    throw error;
  }
}

export function nativeBindingUnavailable(): boolean {
  return nativeBindingError !== null;
}

export function _setNativeBindingErrorForTest(error: unknown): void {
  asyncEntryCtor = null;
  nativeBindingError = error;
}

export class NapiKeyringBackend implements KeyStoreBackend {
  async read(service: string, account: string): Promise<string | undefined> {
    const AsyncEntry = await loadAsyncEntry();
    const entry = new AsyncEntry(service, account);
    return withKeyringTimeout(entry.getPassword(), `read(${service})`, false);
  }

  async write(service: string, account: string, value: string): Promise<void> {
    const AsyncEntry = await loadAsyncEntry();
    const entry = new AsyncEntry(service, account);
    await withKeyringTimeout(entry.setPassword(value), `write(${service})`, true);
  }

  async delete(service: string, account: string): Promise<boolean> {
    let entry: InstanceType<typeof import("@napi-rs/keyring").AsyncEntry>;
    try {
      const AsyncEntry = await loadAsyncEntry();
      entry = new AsyncEntry(service, account);
    } catch {
      return false;
    }

    try {
      return await withKeyringTimeout(entry.deleteCredential(), `delete(${service})`, true);
    } catch (error) {
      if (error instanceof KeyringMutationTimeoutError) throw error;
      return false;
    }
  }
}
