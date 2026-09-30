import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateEd25519Keypair, type Ed25519Keypair } from "./crypto.js";
import {
  ensurePrivateIdentityDirectory,
  IdentityLockTimeoutError,
  withIdentityLock,
} from "./identity-lock.js";
import {
  NapiKeyringBackend,
  nativeBindingUnavailable,
  type KeyStoreBackend,
} from "./identity-keyring.js";
import { listPeers } from "./owner_storage.js";

export {
  addPeer,
  listPeers,
  listOwnerPubkeys,
  snapshotOwnerPubkeys,
  conditionalRemovePeer,
  conditionalRollbackPeer,
  removePeer,
} from "./owner_storage.js";
export type {
  PeerRecord,
  OwnerStorageToken,
  OwnerStorageSnapshotRecord,
  ConditionalPeerRemoval,
  PeerWriteReceipt,
  ConditionalPeerRollback,
} from "./owner_storage.js";
export {
  _setKeyringOperationTimeoutForTest,
  _setNativeBindingErrorForTest,
  KeyringMutationTimeoutError,
  KeyringReadTimeoutError,
} from "./identity-keyring.js";
export type { KeyStoreBackend } from "./identity-keyring.js";
export { IdentityLockTimeoutError } from "./identity-lock.js";

const KEYRING_SERVICE = "dev.pireach.pi";
const ACCOUNT = "longterm-ed25519";
const PI_DIR = join(homedir(), ".pi", "pi-reach");
const IDENTITY_FILE = join(PI_DIR, "identity.json");
const IDENTITY_LOCK_FILE = join(PI_DIR, "identity.lock");

let keyringReadAttempts = 3;
let keyringRetryDelayMs = 300;
let identityLockWaitTimeoutMs = 15_000;
let identityLockPollIntervalMs = 50;

export class KeyringUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "Platform keyring is unreadable and no file-backed identity exists. " +
      "Refusing to generate a NEW identity (that would break existing pairing). " +
      "Unlock your keychain / start your secret service and retry. " +
      "Set PI_REACH_ALLOW_FILE_IDENTITY=1 to force a file-backed identity. " +
      `Cause: ${String(cause)}`,
    );
    this.name = "KeyringUnavailableError";
  }
}

export class PairedIdentityMissingError extends Error {
  constructor(pairedCount: number, cause: unknown) {
    super(
      `No identity could be read, but ${pairedCount} device(s) are already paired. ` +
      "Refusing to generate a NEW identity - that would revoke every paired device. " +
      "Fix this process's keyring access, or pin the established identity to " +
      "~/.pi/pi-reach/identity.json (0600). " +
      `Cause: ${String(cause)}`,
    );
    this.name = "PairedIdentityMissingError";
  }
}

type IdentityFileErrorCategory = "read_failed" | "invalid_format";

export class IdentityFileError extends Error {
  readonly identityPath: string;
  readonly category: IdentityFileErrorCategory;

  constructor(identityPath: string, category: IdentityFileErrorCategory) {
    super(`Identity file at ${identityPath} is unsafe to use (${category}). Refusing to replace it.`);
    this.name = "IdentityFileError";
    this.identityPath = identityPath;
    this.category = category;
  }
}

export class KeyringIdentityError extends Error {
  readonly service: string;

  constructor(service: string) {
    super(`Stored identity in platform keyring service ${service} is invalid. Refusing to replace it.`);
    this.name = "KeyringIdentityError";
    this.service = service;
  }
}

let backend: KeyStoreBackend | null = null;
let keyringExpectedOverride: boolean | null = null;

function getBackend(): KeyStoreBackend {
  if (!backend) backend = new NapiKeyringBackend();
  return backend;
}

export function _setKeyStoreBackendForTest(value: KeyStoreBackend | null): void {
  backend = value;
}

function keyringExpectedAvailable(): boolean {
  if (keyringExpectedOverride !== null) return keyringExpectedOverride;
  if (nativeBindingUnavailable()) return false;
  return process.platform === "darwin" || process.platform === "win32";
}

export function _setKeyringExpectedForTest(value: boolean | null): void {
  keyringExpectedOverride = value;
}

export function _setKeyringRetryForTest(attempts: number | null, delayMs?: number): void {
  keyringReadAttempts = attempts ?? 3;
  keyringRetryDelayMs = delayMs ?? 300;
}

export function _setIdentityLockTimingForTest(waitTimeoutMs: number | null, pollIntervalMs?: number): void {
  identityLockWaitTimeoutMs = waitTimeoutMs ?? 15_000;
  identityLockPollIntervalMs = pollIntervalMs ?? 50;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

interface SerializedKeypair {
  pk: string;
  sk: string;
}

function serialize(kp: Ed25519Keypair): string {
  const payload: SerializedKeypair = {
    pk: Buffer.from(kp.publicKey).toString("base64"),
    sk: Buffer.from(kp.secretKey).toString("base64"),
  };
  return JSON.stringify(payload);
}

function decodeCanonicalBase64(value: unknown, field: keyof SerializedKeypair): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`invalid ${field}`);
  return decoded;
}

function deserializeUnsafe(stored: string): Ed25519Keypair {
  const parsed = JSON.parse(stored) as Partial<SerializedKeypair>;
  const publicKey = decodeCanonicalBase64(parsed.pk, "pk");
  const secretKey = decodeCanonicalBase64(parsed.sk, "sk");
  if (publicKey.length !== 32 || (secretKey.length !== 32 && secretKey.length !== 64)) throw new Error("invalid key length");
  return { publicKey, secretKey };
}

function deserializeKeyringIdentity(stored: string, service: string): Ed25519Keypair {
  try {
    return deserializeUnsafe(stored);
  } catch {
    throw new KeyringIdentityError(service);
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

async function readKeypairFromFile(): Promise<Ed25519Keypair | null> {
  let raw: string;
  try {
    raw = await readFile(IDENTITY_FILE, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw new IdentityFileError(IDENTITY_FILE, "read_failed");
  }

  try {
    return deserializeUnsafe(raw);
  } catch {
    throw new IdentityFileError(IDENTITY_FILE, "invalid_format");
  }
}

async function syncIdentityDirectory(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(PI_DIR, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeKeypairToFile(kp: Ed25519Keypair): Promise<void> {
  await ensurePrivateIdentityDirectory(PI_DIR);
  const temporaryPath = join(PI_DIR, `.identity.json.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | null = null;
  let published = false;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialize(kp), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, IDENTITY_FILE);
    published = true;
    await chmod(IDENTITY_FILE, 0o600);
    await syncIdentityDirectory();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published) {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      });
    }
  }
}

async function assertGenerationIsSafe(forceFile: boolean, cause: unknown): Promise<void> {
  if (forceFile) return;
  const paired = await listPeers();
  if (paired.length > 0) throw new PairedIdentityMissingError(paired.length, cause);
}

type KeyringResolution =
  | { readonly kind: "stored"; readonly stored: string }
  | { readonly kind: "empty" };

async function resolveKeyringReads(store: KeyStoreBackend): Promise<{
  resolution: KeyringResolution | null;
  error: unknown;
}> {
  let keyringError: unknown;
  for (let attempt = 0; attempt < keyringReadAttempts; attempt++) {
    try {
      const existing = await store.read(KEYRING_SERVICE, ACCOUNT);
      if (existing) return { resolution: { kind: "stored", stored: existing }, error: undefined };
      return { resolution: { kind: "empty" }, error: undefined };
    } catch (error) {
      keyringError = error;
      if (attempt < keyringReadAttempts - 1) {
        await sleep(keyringRetryDelayMs * (attempt + 1));
      }
    }
  }
  return { resolution: null, error: keyringError };
}

async function getOrCreateUnderLock(): Promise<Ed25519Keypair> {
  const existingFile = await readKeypairFromFile();
  if (existingFile) return existingFile;

  const store = getBackend();
  const { resolution, error: keyringError } = await resolveKeyringReads(store);
  const forceFile = process.env.PI_REACH_ALLOW_FILE_IDENTITY === "1";

  if (resolution?.kind === "stored") {
    return deserializeKeyringIdentity(resolution.stored, KEYRING_SERVICE);
  }

  if (resolution?.kind === "empty") {
    await assertGenerationIsSafe(forceFile, undefined);
    const fresh = generateEd25519Keypair();
    await store.write(KEYRING_SERVICE, ACCOUNT, serialize(fresh));
    return fresh;
  }

  const fromFile = await readKeypairFromFile();
  if (fromFile) return fromFile;

  if (keyringExpectedAvailable() && !forceFile) {
    throw new KeyringUnavailableError(keyringError);
  }
  await assertGenerationIsSafe(forceFile, keyringError);

  console.warn(
    nativeBindingUnavailable()
      ? "[pi-reach] @napi-rs/keyring native binding could not be loaded in this " +
        `runtime; using file-backed identity at ${IDENTITY_FILE} (0600) instead. ${String(keyringError)}`
      : "[pi-reach] keyring unavailable; using file-backed identity at " +
        `${IDENTITY_FILE}. ${String(keyringError)}`,
  );
  const fresh = generateEd25519Keypair();
  await writeKeypairToFile(fresh);
  return fresh;
}

/**
 * Returns the stable Host identity. Existing file identity wins; otherwise all
 * keyring reads, generation, and persistence run under the fixed
 * cross-process identity lock. Every source is read again after lock acquisition.
 */
export async function getOrCreateEd25519Keypair(): Promise<Ed25519Keypair> {
  const existingFile = await readKeypairFromFile();
  if (existingFile) return existingFile;

  return withIdentityLock(
    PI_DIR,
    getOrCreateUnderLock,
    {
      waitTimeoutMs: identityLockWaitTimeoutMs,
      pollIntervalMs: identityLockPollIntervalMs,
    },
  );
}

export const _IDENTITY_FILE_FOR_TEST = IDENTITY_FILE;
export const _IDENTITY_LOCK_FILE_FOR_TEST = IDENTITY_LOCK_FILE;
export const _unlinkIdentityFileForTest = async (): Promise<void> => {
  try {
    await unlink(IDENTITY_FILE);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
};
