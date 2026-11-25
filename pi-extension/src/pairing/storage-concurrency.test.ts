import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
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
  readonly result: {
    publicKey?: string;
    peers?: { name: string; remote_epk: string; paired_at: string }[];
    errorName?: string;
    message?: string;
  };
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
  mode: "keyring" | "file" | "crash" | "crash-lock",
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

  test.each(["keyring", "file"] as const)("multiple processes recover a crashed first initializer using %s", async (mode) => {
    const paths = temporaryPaths();
    const remoteDirectory = join(paths.home, ".pi", "pi-reach");
    const lockPath = join(remoteDirectory, "identity.lock");

    const crashed = await runWorker(paths, "crash");
    expect(crashed.code).toBe(17);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(remoteDirectory, "peers.json"))).toBe(false);
    const recovered = await Promise.all(Array.from({ length: 6 }, () => runWorker(paths, mode, 5_000)));
    expect(recovered.map((worker) => worker.code)).toEqual(Array(6).fill(0));
    const publicKey = recovered[0]!.result.publicKey;
    expect(publicKey).toBeTruthy();
    expect(recovered.every((worker) => worker.result.publicKey === publicKey)).toBe(true);
    expect(recovered.every((worker) => worker.result.peers?.length === 0)).toBe(true);
    if (mode === "keyring") expect(readFileSync(paths.writeCount, "utf8").trim().split("\n")).toHaveLength(1);
    else expect(readdirSync(remoteDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  test.each(["keyring", "file"] as const)("preserves an existing paired %s identity during concurrent stale-lock recovery", async (mode) => {
    const paths = temporaryPaths();
    const initialized = await runWorker(paths, mode);
    expect(initialized.code).toBe(0);
    expect(initialized.result.publicKey).toBeTruthy();
    const remoteDirectory = join(paths.home, ".pi", "pi-reach");
    const identityPath = mode === "file" ? join(remoteDirectory, "identity.json") : paths.keyring;
    const originalIdentity = readFileSync(identityPath);
    const originalWriteCount = mode === "keyring" ? readFileSync(paths.writeCount, "utf8") : undefined;
    const peers = [{
      name: "Paired phone",
      remote_epk: Buffer.alloc(32, 7).toString("base64"),
      paired_at: new Date(0).toISOString(),
    }];
    const peersPath = join(remoteDirectory, "peers.json");
    const peersRaw = JSON.stringify({ peers });
    writeFileSync(peersPath, peersRaw);

    for (const lockKind of ["empty", "dead process"] as const) {
      const lockPath = join(remoteDirectory, "identity.lock");
      if (lockKind === "empty") {
        writeFileSync(lockPath, "");
        utimesSync(lockPath, new Date(0), new Date(0));
      } else {
        rmSync(lockPath, { force: true });
        // 专用模式直接持锁退出，不受既有文件身份的 fast path 影响。
        expect((await runWorker(paths, "crash-lock")).code).toBe(17);
      }
      // file 模式保持既有 fast path，不强制为了测试恢复而取锁。
      const readers = await Promise.all(Array.from({ length: 6 }, () => runWorker(paths, mode, 5_000)));
      expect(readers.map((worker) => worker.code)).toEqual(Array(6).fill(0));
      expect(readers.every((worker) => worker.result.publicKey === initialized.result.publicKey)).toBe(true);
      for (const reader of readers) expect(reader.result.peers).toEqual(peers);
      expect(readFileSync(identityPath).equals(originalIdentity)).toBe(true);
      expect(readFileSync(peersPath, "utf8")).toBe(peersRaw);
      if (mode === "keyring") expect(readFileSync(paths.writeCount, "utf8")).toBe(originalWriteCount);
      else expect(existsSync(paths.writeCount)).toBe(false);
    }
  }, 30_000);
});
