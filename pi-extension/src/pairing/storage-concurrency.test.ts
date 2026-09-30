import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const workerPath = fileURLToPath(new URL("./storage-concurrency-worker.fixture.mjs", import.meta.url));
const extensionRoot = resolve(dirname(workerPath), "../..");
const roots: string[] = [];

interface WorkerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly result: { publicKey?: string; errorName?: string; message?: string };
}

function temporaryPaths() {
  const root = mkdtempSync(join(tmpdir(), "pi-reach-storage-process-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    keyring: join(root, "test-keyring.json"),
    writeCount: join(root, "keyring-writes.log"),
  };
}

function runWorker(
  paths: ReturnType<typeof temporaryPaths>,
  mode: "keyring" | "file" | "crash",
  lockWaitMs = 2_000,
): Promise<WorkerResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
      cwd: extensionRoot,
      env: {
        ...process.env,
        HOME: paths.home,
        USERPROFILE: paths.home,
        PI_REACH_ALLOW_FILE_IDENTITY: "",
        PI_REACH_TEST_HOME: paths.home,
        PI_REACH_TEST_IDENTITY_MODE: mode,
        PI_REACH_TEST_KEYRING_PATH: paths.keyring,
        PI_REACH_TEST_WRITE_COUNT_PATH: paths.writeCount,
        PI_REACH_TEST_LOCK_WAIT_MS: String(lockWaitMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("identity concurrency worker timed out"));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const trimmed = stdout.trim();
      const line = trimmed ? trimmed.split("\n").at(-1)! : "{}";
      resolveResult({ code, stdout, stderr, result: JSON.parse(line) as WorkerResult["result"] });
    });
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("identity initialization across processes", () => {
  test("keyring-backed first initialization writes once and returns one identity", async () => {
    const paths = temporaryPaths();
    const [first, second] = await Promise.all([
      runWorker(paths, "keyring"),
      runWorker(paths, "keyring"),
    ]);

    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.result.publicKey).toBeTruthy();
    expect(second.result.publicKey).toBe(first.result.publicKey);
    expect(readFileSync(paths.writeCount, "utf8").trim().split("\n")).toHaveLength(1);

    const later = await runWorker(paths, "keyring");
    expect(later.code).toBe(0);
    expect(later.result.publicKey).toBe(first.result.publicKey);
    expect(readFileSync(paths.writeCount, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("file fallback publishes atomically and concurrent callers return one identity", async () => {
    const paths = temporaryPaths();
    const [first, second] = await Promise.all([
      runWorker(paths, "file"),
      runWorker(paths, "file"),
    ]);

    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.result.publicKey).toBeTruthy();
    expect(second.result.publicKey).toBe(first.result.publicKey);
    const remoteDirectory = join(paths.home, ".pi", "pi-reach");
    expect(existsSync(join(remoteDirectory, "identity.json"))).toBe(true);
    expect(readdirSync(remoteDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const later = await runWorker(paths, "file");
    expect(later.result.publicKey).toBe(first.result.publicKey);
  });

  test("a crashed lock holder fails closed until an operator removes that exact lock", async () => {
    const paths = temporaryPaths();
    const remoteDirectory = join(paths.home, ".pi", "pi-reach");
    const lockPath = join(remoteDirectory, "identity.lock");

    const crashed = await runWorker(paths, "crash");
    expect(crashed.code).toBe(17);
    expect(existsSync(lockPath)).toBe(true);
    const crashedLock = readFileSync(lockPath, "utf8");

    const blocked = await runWorker(paths, "file", 30);
    expect(blocked.code).toBe(2);
    expect(blocked.result.errorName).toBe("IdentityLockTimeoutError");
    expect(readFileSync(lockPath, "utf8")).toBe(crashedLock);
    expect(existsSync(join(remoteDirectory, "identity.json"))).toBe(false);

    rmSync(lockPath);
    const recovered = await runWorker(paths, "file");
    expect(recovered.code).toBe(0);
    expect(recovered.result.publicKey).toBeTruthy();
  });
});
