import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests import the module after stubbing `os.homedir` so the fallback
// path writes inside a temp dir instead of the dev's real ~/.pi/pi-reach.
// vi.mock must run before the real module load.
const _tmpHome = mkdtempSync(join(tmpdir(), "pi-storage-"));
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: () => _tmpHome };
});

// Re-import after the mock is installed.
const storage = await import("./storage.js");
const {
  getOrCreateEd25519Keypair,
  KeyringUnavailableError,
  _setKeyStoreBackendForTest,
  _setKeyringExpectedForTest,
  _setKeyringRetryForTest,
  _unlinkIdentityFileForTest,
  _IDENTITY_FILE_FOR_TEST,
  _IDENTITY_LOCK_FILE_FOR_TEST,
  _setNativeBindingErrorForTest,
  _setIdentityLockTimingForTest,
  IdentityFileError,
  IdentityLockTimeoutError,
  KeyringIdentityError,
  KeyringMutationTimeoutError,
} = storage;
import type { KeyStoreBackend } from "./storage.js";

// ── In-memory backend for isolation / round-trip tests ──────────────────────

class InMemoryBackend implements KeyStoreBackend {
  readonly store = new Map<string, string>();
  readonly reads: { service: string; account: string }[] = [];
  readonly writes: { service: string; account: string; value: string }[] = [];
  readonly deletes: { service: string; account: string }[] = [];
  private _failOn?: "read" | "write" | "delete";
  private _failAllOn?: "read" | "write" | "delete";

  failNext(op: "read" | "write" | "delete" | undefined) {
    this._failOn = op;
  }

  /** Persistent failure — every op of this kind throws (simulates a keyring
   *  that's locked/unavailable for the whole call, surviving retries). */
  failAll(op: "read" | "write" | "delete" | undefined) {
    this._failAllOn = op;
  }

  async read(service: string, account: string) {
    this.reads.push({ service, account });
    if (this._failAllOn === "read") throw new Error("simulated keyring locked");
    if (this._failOn === "read") {
      this._failOn = undefined;
      throw new Error("simulated keyring unavailable");
    }
    return this.store.get(`${service}|${account}`);
  }
  async write(service: string, account: string, value: string) {
    this.writes.push({ service, account, value });
    if (this._failOn === "write") {
      this._failOn = undefined;
      throw new Error("simulated keyring write failure");
    }
    this.store.set(`${service}|${account}`, value);
  }
  async delete(service: string, account: string) {
    this.deletes.push({ service, account });
    const key = `${service}|${account}`;
    const had = this.store.has(key);
    this.store.delete(key);
    return had;
  }
}

const NEW_SERVICE = "dev.pireach.pi";
const ACCOUNT = "longterm-ed25519";

beforeEach(async () => {
  // Silence the fallback console output during tests so the
  // vitest output isn't polluted.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Zero retry delay so persistent-failure tests don't sleep.
  _setKeyringRetryForTest(3, 0);
  await _unlinkIdentityFileForTest();
  // peers.json now gates identity minting (issues #95/#69), so a container left
  // by a previous test would make an unrelated "fresh install" case throw.
  rmSync(join(_tmpHome, ".pi", "pi-reach", "peers.json"), { force: true });
  rmSync(_IDENTITY_LOCK_FILE_FOR_TEST, { force: true });
});

afterEach(() => {
  _setKeyStoreBackendForTest(null);
  _setKeyringExpectedForTest(null);
  _setKeyringRetryForTest(null);
  _setIdentityLockTimingForTest(null);
  _setNativeBindingErrorForTest(null);
  delete process.env.PI_REACH_ALLOW_FILE_IDENTITY;
  vi.restoreAllMocks();
});

// ── Keyring path ────────────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair — keyring path", () => {
  test("returns existing entry from new service without writing", async () => {
    const backend = new InMemoryBackend();
    const original = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(2)).toString("base64"),
    });
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, original);
    _setKeyStoreBackendForTest(backend);

    const kp = await getOrCreateEd25519Keypair();
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
    );
    expect(backend.writes.length).toBe(0);
    expect(backend.deletes.length).toBe(0);
  });

  test("generates + saves a fresh keypair when the service has no entry", async () => {
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(backend.writes.length).toBe(1);
    expect(backend.writes[0]!.service).toBe(NEW_SERVICE);
    expect(backend.writes[0]!.account).toBe(ACCOUNT);
    expect(backend.deletes.length).toBe(0);
  });

  test("idempotent across two calls — second call returns same key without write", async () => {
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    const first = await getOrCreateEd25519Keypair();
    const second = await getOrCreateEd25519Keypair();

    expect(Buffer.from(first.publicKey).toString("base64")).toBe(
      Buffer.from(second.publicKey).toString("base64"),
    );
    expect(backend.writes.length).toBe(1);  // only the first call wrote
  });

  test("same-process concurrent first calls share one persisted identity", async () => {
    class DelayedBackend extends InMemoryBackend {
      override async write(service: string, account: string, value: string) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await super.write(service, account, value);
      }
    }
    const backend = new DelayedBackend();
    _setKeyStoreBackendForTest(backend);

    const [first, second, third] = await Promise.all([
      getOrCreateEd25519Keypair(),
      getOrCreateEd25519Keypair(),
      getOrCreateEd25519Keypair(),
    ]);
    const publicKeys = [first, second, third].map((keypair) =>
      Buffer.from(keypair.publicKey).toString("base64"));

    expect(new Set(publicKeys).size).toBe(1);
    expect(backend.writes).toHaveLength(1);
  });

  test("ordinary keyring write failure releases the lock for a clean retry", async () => {
    const backend = new InMemoryBackend();
    backend.failNext("write");
    _setKeyStoreBackendForTest(backend);

    await expect(getOrCreateEd25519Keypair()).rejects.toThrow("simulated keyring write failure");
    expect(existsSync(_IDENTITY_LOCK_FILE_FOR_TEST)).toBe(false);
    await expect(getOrCreateEd25519Keypair()).resolves.toMatchObject({
      publicKey: expect.any(Uint8Array),
    });
    expect(backend.writes).toHaveLength(2);
  });

  test("late keyring write timeout holds the lock until the native write settles", async () => {
    class LateWriteBackend implements KeyStoreBackend {
      stored: string | undefined;
      writes = 0;
      settled = false;

      async read(service: string): Promise<string | undefined> {
        return service === NEW_SERVICE ? this.stored : undefined;
      }

      async write(_service: string, _account: string, value: string): Promise<void> {
        this.writes += 1;
        const settled = new Promise<void>((resolve) => {
          setTimeout(() => {
            this.stored = value;
            this.settled = true;
            resolve();
          }, 40);
        });
        throw new KeyringMutationTimeoutError("write(test)", 1, settled);
      }

      async delete(): Promise<boolean> {
        return false;
      }
    }

    const backend = new LateWriteBackend();
    _setKeyStoreBackendForTest(backend);
    _setIdentityLockTimingForTest(500, 5);

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(KeyringMutationTimeoutError);
    expect(backend.settled).toBe(false);
    const recovered = await getOrCreateEd25519Keypair();

    expect(backend.writes).toBe(1);
    expect(backend.settled).toBe(true);
    expect(Buffer.from(recovered.publicKey).toString("base64")).toBe(
      (JSON.parse(backend.stored!) as { pk: string }).pk,
    );
  });

  test("an existing lock times out without generating or being removed", async () => {
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(_IDENTITY_LOCK_FILE_FOR_TEST, "crashed-initializer", { mode: 0o600 });
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);
    _setIdentityLockTimingForTest(20, 5);

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(readFileSync(_IDENTITY_LOCK_FILE_FOR_TEST, "utf8")).toBe("crashed-initializer");
    expect(backend.writes).toHaveLength(0);

    rmSync(_IDENTITY_LOCK_FILE_FOR_TEST);
    await expect(getOrCreateEd25519Keypair()).resolves.toBeDefined();
  });

  test("a malformed identity file fails closed without exposing stored secret text", async () => {
    const sentinel = "SECRET-LIKE-IDENTITY-SENTINEL";
    const malformed = `{"pk":"invalid","sk":"${sentinel}"`;
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(_IDENTITY_FILE_FOR_TEST, malformed, { mode: 0o600 });
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    const error = await getOrCreateEd25519Keypair().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(IdentityFileError);
    expect(String(error)).not.toContain(sentinel);
    expect(String((error as { cause?: unknown }).cause ?? "")).not.toContain(sentinel);
    expect(backend.reads).toHaveLength(0);
    expect(readFileSync(_IDENTITY_FILE_FOR_TEST, "utf8")).toBe(malformed);
  });

  test.each([
    ["missing fields", `{"pk": "${Buffer.alloc(32, 1).toString("base64")}"`],
    ["wrong lengths", JSON.stringify({ pk: Buffer.alloc(31, 1).toString("base64"), sk: Buffer.alloc(64, 2).toString("base64") })],
    ["non-canonical base64", JSON.stringify({ pk: `${Buffer.alloc(32, 1).toString("base64")}\n`, sk: Buffer.alloc(64, 2).toString("base64") })],
  ])("malformed file identity %s fails closed", async (_case, malformed) => {
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(_IDENTITY_FILE_FOR_TEST, malformed, { mode: 0o600 });
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(IdentityFileError);
    expect(backend.reads).toHaveLength(0);
    expect(readFileSync(_IDENTITY_FILE_FOR_TEST, "utf8")).toBe(malformed);
  });

  test.each([NEW_SERVICE])(
    "malformed stored identity in %s fails closed without exposing secret text",
    async (service) => {
      const sentinel = "SECRET-LIKE-KEYRING-SENTINEL";
      const backend = new InMemoryBackend();
      backend.store.set(`${service}|${ACCOUNT}`, `{"pk":"invalid","sk":"${sentinel}"`);
      _setKeyStoreBackendForTest(backend);

      const error = await getOrCreateEd25519Keypair().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(KeyringIdentityError);
      expect(String(error)).not.toContain(sentinel);
      expect(String((error as { cause?: unknown }).cause ?? "")).not.toContain(sentinel);
      expect(backend.writes).toHaveLength(0);
      expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false);
    },
  );
});

// ── Brand-specific keyring isolation ────────────────────────────────────────

describe("getOrCreateEd25519Keypair — isolated Pi Reach keyring", () => {
  test.each(["dev.example.pi", "dev.example.mac"])(
    "never reads, overwrites, or deletes the unrelated %s service",
    async (oldService) => {
      const backend = new InMemoryBackend();
      const oldIdentity = JSON.stringify({
        pk: Buffer.alloc(32, 7).toString("base64"),
        sk: Buffer.alloc(64, 8).toString("base64"),
      });
      backend.store.set(`${oldService}|${ACCOUNT}`, oldIdentity);
      _setKeyStoreBackendForTest(backend);

      const fresh = await getOrCreateEd25519Keypair();
      const repeated = await getOrCreateEd25519Keypair();

      expect(Buffer.from(fresh.publicKey).toString("base64")).not.toBe(Buffer.alloc(32, 7).toString("base64"));
      expect(repeated.publicKey).toEqual(fresh.publicKey);
      expect(backend.reads).toEqual([
        { service: NEW_SERVICE, account: ACCOUNT },
        { service: NEW_SERVICE, account: ACCOUNT },
      ]);
      expect(backend.writes).toHaveLength(1);
      expect(backend.writes[0]!.service).toBe(NEW_SERVICE);
      expect(backend.store.get(`${oldService}|${ACCOUNT}`)).toBe(oldIdentity);
      expect(backend.deletes).toEqual([]);
    },
  );
});

// ── Headless fallback ───────────────────────────────────────────────────────

describe("getOrCreateEd25519Keypair — headless Linux fallback", () => {
  test("keyring read throws persistently (no keyring expected) → falls back to identity.json (chmod 0o600)", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);  // simulate headless Linux (no core keyring)

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey.length).toBe(32);

    // File exists at the expected path with restrictive perms.
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true);
    // POSIX-only: `chmod 0o600` is a no-op on Windows (NTFS perms aren't the
    // POSIX bits + Node reports a fixed mode), so only assert the perm bits
    // off Windows. The file-creation + fallback behavior is checked above.
    if (process.platform !== "win32") {
      const stat = statSync(_IDENTITY_FILE_FOR_TEST);
      const perms = stat.mode & 0o777;
      expect(perms & 0o077).toBe(0);  // group + other bits zero
    }

    // Round-trip: parse and check it deserializes to the same key.
    const parsed = JSON.parse(readFileSync(_IDENTITY_FILE_FOR_TEST, "utf8")) as { pk: string; sk: string };
    expect(Buffer.from(parsed.pk, "base64").length).toBe(32);
  });

  test("fallback second call returns the file-stored key (no regen)", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);
    const first = await getOrCreateEd25519Keypair();

    // Reset the backend so it would throw again on a fresh read.
    const backend2 = new InMemoryBackend();
    backend2.failAll("read");
    _setKeyStoreBackendForTest(backend2);
    const second = await getOrCreateEd25519Keypair();

    expect(Buffer.from(first.publicKey).toString("base64")).toBe(
      Buffer.from(second.publicKey).toString("base64"),
    );
  });

});

// ── Locked-keychain protection (the "lost pairing after a week idle" bug) ────

// ── Native binding cannot load (issue #113 — Bun-built pi) ──────────────────

describe("getOrCreateEd25519Keypair — @napi-rs/keyring binding unavailable", () => {
  test("a binding that never loads falls back to the file identity even on a core-keyring platform", async () => {
    // A load failure is deterministic: no unlock or retry will fix it, so the
    // "keyring is locked, refuse to regenerate" guard must not fire — that
    // would leave the user with no working path at all (issue #113).
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(null);  // real platform check (darwin/win32 on CI hosts)
    _setNativeBindingErrorForTest(new Error("Cannot find native binding."));

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true);

    // Second call is stable — same identity, read straight off the file.
    const again = await getOrCreateEd25519Keypair();
    expect(Buffer.from(again.publicKey).toString("base64"))
      .toBe(Buffer.from(kp.publicKey).toString("base64"));
  });

  test("with the binding loadable, a locked core keyring still refuses to regenerate", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(null);
    _setNativeBindingErrorForTest(null);
    // Only meaningful on a platform whose keyring is a core OS service.
    if (process.platform !== "darwin" && process.platform !== "win32") return;

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(KeyringUnavailableError);
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false);
  });
});

describe("getOrCreateEd25519Keypair — locked keyring does NOT regenerate", () => {
  test("transient read failure recovers via retry → uses keyring entry, no file written", async () => {
    const backend = new InMemoryBackend();
    const original = JSON.stringify({
      pk: Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
      sk: Buffer.from(new Uint8Array(64).fill(6)).toString("base64"),
    });
    backend.store.set(`${NEW_SERVICE}|${ACCOUNT}`, original);
    backend.failNext("read");  // first read throws, retry succeeds
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);  // macOS/Windows: keyring is core

    const kp = await getOrCreateEd25519Keypair();
    // Recovered the ORIGINAL paired key — not a freshly minted one.
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
    );
    expect(backend.reads.length).toBeGreaterThanOrEqual(2);  // retried
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false);  // no file regen
  });

  test("persistent failure on a core-keyring platform with no file → throws (refuses to regen)", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);  // macOS/Windows

    await expect(getOrCreateEd25519Keypair()).rejects.toBeInstanceOf(KeyringUnavailableError);
    // Critically: no new identity file was written (pairing not silently broken).
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false);
  });

  test("persistent failure but identity.json already exists → returns the FILE key (never throws, never regen)", async () => {
    // First, create a file identity via the headless path.
    const seed = new InMemoryBackend();
    seed.failAll("read");
    _setKeyStoreBackendForTest(seed);
    _setKeyringExpectedForTest(false);
    const fileKp = await getOrCreateEd25519Keypair();

    // Now the keyring is "core" but locked; the existing file must win.
    const locked = new InMemoryBackend();
    locked.failAll("read");
    _setKeyStoreBackendForTest(locked);
    _setKeyringExpectedForTest(true);
    const kp = await getOrCreateEd25519Keypair();

    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    );
  });

  test("PI_REACH_ALLOW_FILE_IDENTITY=1 opts into file identity even on a core-keyring platform", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(true);
    process.env.PI_REACH_ALLOW_FILE_IDENTITY = "1";

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey.length).toBe(32);
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true);
  });
});

// ── Never mint a new identity over existing pairings (issues #95 / #69) ──────

describe("getOrCreateEd25519Keypair — paired devices block identity minting", () => {
  function seedPairedDevice(): void {
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(join(_tmpHome, ".pi", "pi-reach", "peers.json"), JSON.stringify({
      peers: [{ name: "Phone", remote_epk: "AAAA", paired_at: new Date(0).toISOString() }],
    }));
  }

  test("readable but empty keyring + existing pairings refuses to mint", async () => {
    seedPairedDevice();
    const backend = new InMemoryBackend();
    _setKeyStoreBackendForTest(backend);

    await expect(getOrCreateEd25519Keypair())
      .rejects.toBeInstanceOf(storage.PairedIdentityMissingError);
    expect(backend.writes).toHaveLength(0);
  });

  test("unreadable keyring + existing pairings → throws instead of minting (separate process case)", async () => {
    // A headless Linux process can resolve a different secret-service store than
    // the desktop session that paired; this keeps the fixture scoped to the current device.
    seedPairedDevice();
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);  // headless Linux — used to mint silently

    await expect(getOrCreateEd25519Keypair())
      .rejects.toBeInstanceOf(storage.PairedIdentityMissingError);
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(false);
  });

  test("PI_REACH_ALLOW_FILE_IDENTITY=1 still opts out of the guard", async () => {
    seedPairedDevice();
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);
    process.env.PI_REACH_ALLOW_FILE_IDENTITY = "1";

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true);
  });

  test("no pairings yet → a genuine first run still mints normally", async () => {
    const backend = new InMemoryBackend();
    backend.failAll("read");
    _setKeyStoreBackendForTest(backend);
    _setKeyringExpectedForTest(false);

    const kp = await getOrCreateEd25519Keypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true);
  });
});

// ── Corrupt peer record isolation ────────────────────────────────────────────

describe("peer record corruption isolation", () => {
  const peersPath = join(_tmpHome, ".pi", "pi-reach", "peers.json");

  function writePeers(peers: unknown): void {
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2));
  }

  test.each([null, 42, "not-an-array", { remote_epk: "not-an-array" }])(
    "treats a non-array peers value as empty: %j",
    async (peers) => {
      writePeers(peers);

      await expect(storage.listPeers()).resolves.toEqual([]);
      await expect(storage.listOwnerPubkeys()).resolves.toEqual([]);
    },
  );

  test("a false commit guard preserves the exact raw peer record", async () => {
    const rawHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    const peers = [
      { name: "Re-paired Owner", remote_epk: rawHandle, paired_at: "replacement" },
    ];
    writePeers(peers);

    await expect(storage.removePeer(rawHandle, () => false)).resolves.toBe(false);
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers });
  });

  test("removes only the exact raw handle while preserving corrupt entries", async () => {
    const urlSafeHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    const standardHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const originalPeers = [
      null,
      42,
      { name: "missing handle" },
      { name: "null handle", remote_epk: null, paired_at: "first" },
      { name: "URL-safe", remote_epk: urlSafeHandle, paired_at: "second" },
      { name: "standard", remote_epk: standardHandle, paired_at: "third" },
    ];
    writePeers(originalPeers);

    await expect(storage.listPeers()).resolves.toEqual(originalPeers);
    await expect(storage.listOwnerPubkeys()).resolves.toEqual([
      null,
      42,
      undefined,
      urlSafeHandle,
      standardHandle,
    ]);
    await expect(storage.removePeer(urlSafeHandle)).resolves.toBe(true);

    const expectedPeers = originalPeers.filter((peer) =>
      !peer ||
      typeof peer !== "object" ||
      (peer as { remote_epk?: unknown }).remote_epk !== urlSafeHandle,
    );
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({
      peers: expectedPeers,
    });
    await expect(storage.removePeer(urlSafeHandle)).resolves.toBe(false);
    await expect(storage.removePeer(standardHandle)).resolves.toBe(true);
  });
});

// ── File identity wins over a READABLE keyring (masking bug) ─────────────────
//
// A file-backed/headless install pairs the mobile against the key in
// `~/.pi/pi-reach/identity.json`. If the platform keyring later becomes readable
// (D-Bus/libsecret installed, a desktop session, a stale entry from another
// install), consulting it FIRST would mask the file identity — returning a
// different key, or minting a fresh one over an empty keyring — and break the
// existing pairing. The file must win. (These cases differ from the
// "locked keyring" ones above: here the keyring READS FINE, it just isn't the
// paired identity.)

describe("getOrCreateEd25519Keypair — file identity wins over a readable keyring", () => {
  /** Seed a file-backed identity via the headless path and return its key. */
  async function seedFileIdentity() {
    const seed = new InMemoryBackend();
    seed.failAll("read");
    _setKeyStoreBackendForTest(seed);
    _setKeyringExpectedForTest(false);  // headless Linux → writes identity.json
    const fileKp = await getOrCreateEd25519Keypair();
    expect(existsSync(_IDENTITY_FILE_FOR_TEST)).toBe(true);
    return fileKp;
  }

  test("readable keyring holding a DIFFERENT entry → file identity still wins", async () => {
    const fileKp = await seedFileIdentity();

    // A fully-readable keyring now holds a DIFFERENT identity.
    const keyring = new InMemoryBackend();
    const otherPk = Buffer.from(new Uint8Array(32).fill(42)).toString("base64");
    keyring.store.set(`${NEW_SERVICE}|${ACCOUNT}`, JSON.stringify({
      pk: otherPk,
      sk: Buffer.from(new Uint8Array(64).fill(43)).toString("base64"),
    }));
    _setKeyStoreBackendForTest(keyring);
    _setKeyringExpectedForTest(true);  // even on a core-keyring platform

    const kp = await getOrCreateEd25519Keypair();
    // File identity wins — the mobile is paired against it.
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    );
    expect(Buffer.from(kp.publicKey).toString("base64")).not.toBe(otherPk);
    // The keyring is never consulted — the file short-circuits ahead of it.
    expect(keyring.reads.length).toBe(0);
    expect(keyring.writes.length).toBe(0);
    expect(keyring.deletes.length).toBe(0);
  });

  test("readable but EMPTY keyring → does NOT mint a fresh key over identity.json", async () => {
    const fileKp = await seedFileIdentity();

    // A readable but EMPTY keyring appears (e.g. libsecret installed later).
    const keyring = new InMemoryBackend();
    _setKeyStoreBackendForTest(keyring);
    _setKeyringExpectedForTest(true);

    const kp = await getOrCreateEd25519Keypair();
    expect(Buffer.from(kp.publicKey).toString("base64")).toBe(
      Buffer.from(fileKp.publicKey).toString("base64"),
    );
    // Critically: no fresh keypair was generated + written into the keyring
    // (that write is exactly what masked the file identity and broke pairing).
    expect(keyring.reads.length).toBe(0);
    expect(keyring.writes.length).toBe(0);
  });
});


describe("peer write receipts and conditional rollback", () => {
  const peersPath = join(_tmpHome, ".pi", "pi-reach", "peers.json");

  function writePeers(peers: unknown): void {
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2));
  }

  test("addPeer returns its record and canonical-slot token", async () => {
    const record = { name: "new", remote_epk: "receipt-owner", paired_at: "first" };

    await expect(storage.addPeer(record)).resolves.toMatchObject({ record });
    const receipt = await storage.addPeer(record);
    expect(receipt.token).toBeDefined();
    expect(receipt.previousRecord).toEqual(record);
  });

  test("rolls back an added record while its receipt remains current", async () => {
    const record = { name: "new", remote_epk: "rollback-added", paired_at: "first" };
    const receipt = await storage.addPeer(record);

    await expect(storage.conditionalRollbackPeer(receipt)).resolves.toMatchObject({
      outcome: "removed",
    });
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers: [] });
  });

  test("rolls back an overwritten record by restoring its raw predecessor", async () => {
    const previous = { name: "old", remote_epk: "rollback-overwritten", paired_at: "old" };
    const replacement = { name: "new", remote_epk: "rollback-overwritten", paired_at: "new" };
    writePeers([previous]);
    const receipt = await storage.addPeer(replacement);

    expect(receipt.previousRecord).toEqual(previous);
    await expect(storage.conditionalRollbackPeer(receipt)).resolves.toMatchObject({
      outcome: "restored",
    });
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers: [previous] });
  });

  test("a stale receipt cannot roll back a subsequent re-pair", async () => {
    const first = { name: "first", remote_epk: "rollback-stale", paired_at: "first" };
    const second = { name: "second", remote_epk: "rollback-stale", paired_at: "second" };
    const receipt = await storage.addPeer(first);
    await storage.addPeer(second);

    await expect(storage.conditionalRollbackPeer(receipt)).resolves.toMatchObject({
      outcome: "stale",
    });
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers: [second] });
  });

  test.each([
    ["false", () => false],
    ["throw", () => { throw new Error("authority unavailable"); }],
  ])("a %s authority guard does not write", async (_case, canCommit) => {
    const record = { name: "guarded", remote_epk: "rollback-guard", paired_at: "first" };
    const receipt = await storage.addPeer(record);

    await expect(storage.conditionalRollbackPeer(receipt, canCommit)).resolves.toMatchObject({
      outcome: "no_authority",
    });
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({ peers: [record] });
  });
});

describe("owner snapshot mutation tokens", () => {
  const peersPath = join(_tmpHome, ".pi", "pi-reach", "peers.json");
  const snapshotStorage = storage as typeof storage & {
    snapshotOwnerPubkeys(): Promise<readonly { rawOwnerPubkey: unknown; token: unknown }[]>;
    conditionalRemovePeer(remoteEpk: string, expectedToken: unknown): Promise<{ outcome: string }>;
  };

  function writePeers(peers: unknown): void {
    mkdirSync(join(_tmpHome, ".pi", "pi-reach"), { recursive: true });
    writeFileSync(peersPath, JSON.stringify({ peers }, null, 2));
  }

  test("stale re-pair token preserves the replacement record", async () => {
    const rawHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    const original = { name: "first", remote_epk: rawHandle, paired_at: "first" };
    const replacement = { name: "replacement", remote_epk: rawHandle, paired_at: "replacement" };
    writePeers([original]);

    const [snapshot] = await snapshotStorage.snapshotOwnerPubkeys();
    await storage.addPeer(replacement);
    await expect(snapshotStorage.conditionalRemovePeer(rawHandle, snapshot!.token))
      .resolves.toMatchObject({ outcome: "stale" });
    expect(readFileSync(peersPath, "utf8")).toBe(JSON.stringify({ peers: [replacement] }, null, 2));
  });

  test("current token removes only its exact raw representation", async () => {
    const urlSafeHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO_oMQ6yyQE";
    const standardHandle = "Bz02uLiwrmQZ0S8qiwtFJAt0KzUvrgepYO/oMQ6yyQE=";
    writePeers([
      { name: "url", remote_epk: urlSafeHandle, paired_at: "first" },
      { name: "standard", remote_epk: standardHandle, paired_at: "second" },
    ]);

    const snapshot = await snapshotStorage.snapshotOwnerPubkeys();
    const token = snapshot.find((entry) => entry.rawOwnerPubkey === urlSafeHandle)!.token;
    await expect(snapshotStorage.conditionalRemovePeer(urlSafeHandle, token))
      .resolves.toMatchObject({ outcome: "removed" });
    expect(JSON.parse(readFileSync(peersPath, "utf8"))).toEqual({
      peers: [{ name: "standard", remote_epk: standardHandle, paired_at: "second" }],
    });
  });
});
