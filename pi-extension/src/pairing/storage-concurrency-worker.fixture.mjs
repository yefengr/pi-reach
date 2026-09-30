import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const testHome = process.env.PI_REACH_TEST_HOME;
if (!testHome || resolve(homedir()) !== resolve(testHome)) {
  throw new Error("isolated test home was not applied before loading identity storage");
}

const storage = await import("./storage.ts");
const mode = process.env.PI_REACH_TEST_IDENTITY_MODE;
const keyringPath = process.env.PI_REACH_TEST_KEYRING_PATH;
const writeCountPath = process.env.PI_REACH_TEST_WRITE_COUNT_PATH;

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

class SharedTestKeyring {
  async read(service) {
    if (service !== "dev.pireach.pi") return undefined;
    try {
      return await readFile(keyringPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async write(_service, _account, value) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendFile(writeCountPath, "write\n", { mode: 0o600 });
    await writeFile(keyringPath, value, { mode: 0o600 });
  }

  async delete() {
    return false;
  }
}

class UnavailableTestKeyring {
  async read() {
    throw new Error("test keyring unavailable");
  }

  async write() {
    throw new Error("unexpected test keyring write");
  }

  async delete() {
    return false;
  }
}

class CrashingTestKeyring {
  async read() {
    process.exit(17);
  }

  async write() {
    throw new Error("unexpected test keyring write");
  }

  async delete() {
    return false;
  }
}

storage._setKeyringRetryForTest(1, 0);
storage._setIdentityLockTimingForTest(
  Number(process.env.PI_REACH_TEST_LOCK_WAIT_MS ?? "2000"),
  5,
);
if (mode === "keyring") {
  storage._setKeyStoreBackendForTest(new SharedTestKeyring());
} else if (mode === "file") {
  storage._setKeyStoreBackendForTest(new UnavailableTestKeyring());
  storage._setKeyringExpectedForTest(false);
} else if (mode === "crash") {
  storage._setKeyStoreBackendForTest(new CrashingTestKeyring());
} else {
  throw new Error(`unknown test identity mode: ${String(mode)}`);
}

try {
  const keypair = await storage.getOrCreateEd25519Keypair();
  process.stdout.write(`${JSON.stringify({
    publicKey: Buffer.from(keypair.publicKey).toString("base64"),
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 2;
}
