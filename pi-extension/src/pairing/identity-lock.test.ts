import { linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { link } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  IdentityLockPublicationError,
  IdentityLockTimeoutError,
  withIdentityLock,
} from "./identity-lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-reach-identity-lock-"));
  roots.push(root);
  return join(root, "remote");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("identity initialization lock", () => {
  test.each(["EPERM", "ENOTSUP", "EACCES"])("explains hard-link publication failure (%s) without running the operation", async (code) => {
    const directory = temporaryDirectory();
    const operation = vi.fn(async () => undefined);
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("sensitive-underlying-detail"), { code }));
    const error = await withIdentityLock(directory, operation).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentityLockPublicationError);
    expect((error as Error).message).toContain("local filesystem supporting hard links");
    expect((error as Error).message).toContain("directory permissions");
    expect((error as Error).message).not.toContain("sensitive-underlying-detail");
    expect((error as Error).cause).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });

  test("serializes concurrent holders and creates a private directory", async () => {
    const directory = temporaryDirectory();
    const events: string[] = [];

    const first = withIdentityLock(directory, async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push("first:end");
    });
    const second = withIdentityLock(directory, async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.all([first, second]);
    expect([
      ["first:start", "first:end", "second:start", "second:end"],
      ["second:start", "second:end", "first:start", "first:end"],
    ]).toContainEqual(events);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  test("times out without stealing or deleting an existing lock", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const lockPath = join(directory, "identity.lock");
    const marker = "operator-owned-stale-lock";
    writeFileSync(lockPath, marker, { mode: 0o600 });

    await expect(withIdentityLock(
      directory,
      async () => undefined,
      { waitTimeoutMs: 20, pollIntervalMs: 5 },
    )).rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(readFileSync(lockPath, "utf8")).toBe(marker);
  });

  test.each([["empty", ""], ["invalid JSON", "{broken-json"]])("automatically recovers aged malformed locks (%s)", async (_label, raw) => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const lockPath = join(directory, "identity.lock");
    writeFileSync(lockPath, raw, { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath, old, old);
    await expect(withIdentityLock(directory, async () => "recovered", {
      waitTimeoutMs: 100, pollIntervalMs: 5,
    })).resolves.toBe("recovered");
  });

  test.each([undefined, "EPERM", "EUNKNOWN"])("never steals an aged live or uncertain process lock (%s)", async (code) => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    const raw = JSON.stringify({ pid: process.pid, token: "12345678-1234-4123-8123-123456789abc", createdAt: new Date(0).toISOString() });
    writeFileSync(path, raw);
    utimesSync(path, new Date(0), new Date(0));
    if (code) vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("probe failed"), { code }); });
    await expect(withIdentityLock(directory, async () => undefined, { waitTimeoutMs: 30, pollIntervalMs: 5 }))
      .rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test("keeps an old-version empty write window until completion", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    writeFileSync(path, "");
    const waiting = withIdentityLock(directory, async () => undefined, { waitTimeoutMs: 100, pollIntervalMs: 5 });
    writeFileSync(path, JSON.stringify({ pid: process.pid, token: "live", createdAt: new Date().toISOString() }));
    await expect(waiting).rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
  });

  test("does not recover symlinks", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    const target = join(directory, "target");
    writeFileSync(target, "");
    utimesSync(target, new Date(0), new Date(0));
    symlinkSync(target, path);
    await expect(withIdentityLock(directory, async () => undefined, { waitTimeoutMs: 20 }))
      .rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  test("recovers dead claims on the same inode but leaves unrelated files alone", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    writeFileSync(path, "");
    utimesSync(path, new Date(0), new Date(0));
    const claim = join(directory, "identity-lock-2147483647-12345678-1234-4123-8123-123456789abc.tmp");
    linkSync(path, claim);
    const unrelated = join(directory, "identity-lock-2147483647-12345678-1234-4123-8123-123456789abd.tmp");
    writeFileSync(unrelated, "unrelated");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
    await withIdentityLock(directory, async () => undefined, { waitTimeoutMs: 200 });
    expect(readdirSync(directory)).toEqual([unrelated.split("/").at(-1)]);
  });

  test.each([["empty", ""], ["invalid JSON", "{broken-json"]])("synchronized processes recover %s without overlapping owners", async (_label, raw) => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    writeFileSync(path, raw);
    utimesSync(path, new Date(0), new Date(0));
    const fixture = fileURLToPath(new URL("./identity-lock-recovery.fixture.mjs", import.meta.url));
    const workers = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ["--import", "tsx", fixture, directory], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("worker exited before barrier")));
      });
      const done = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
      });
      return { child, ready, done };
    });
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      for (const worker of workers) worker.child.send("go");
      expect(await Promise.all(workers.map((worker) => worker.done))).toEqual(Array(6).fill(0));
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      for (const worker of workers) worker.child.kill();
    }
  }, 15_000);

  test("recovery logs contain only the reason, not malformed lock contents", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    writeFileSync(path, "sensitive-malformed-content");
    utimesSync(path, new Date(0), new Date(0));
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withIdentityLock(directory, async () => undefined);
    expect(log.mock.calls).toEqual([["[pi-reach] Recovered identity initialization lock: aged malformed lock"]]);
  });

  test("a live claim prevents recovery of its inode", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    writeFileSync(path, "");
    utimesSync(path, new Date(0), new Date(0));
    const claim = join(directory, `identity-lock-${process.pid}-12345678-1234-4123-8123-123456789abc.tmp`);
    linkSync(path, claim);
    await expect(withIdentityLock(directory, async () => undefined, { waitTimeoutMs: 30, pollIntervalMs: 5 }))
      .rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(statSync(path).ino).toBe(statSync(claim).ino);
    rmSync(claim);
    await withIdentityLock(directory, async () => undefined);
  });

  test("a lock replaced during stale inspection is never deleted", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const path = join(directory, "identity.lock");
    const token = "12345678-1234-4123-8123-123456789abc";
    writeFileSync(path, JSON.stringify({ pid: 2147483647, token, createdAt: new Date(0).toISOString() }));
    const replacement = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid !== 2147483647) return true;
      const temporary = join(directory, "replacement");
      writeFileSync(temporary, replacement);
      renameSync(temporary, path);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    await expect(withIdentityLock(directory, async () => undefined, { waitTimeoutMs: 30, pollIntervalMs: 5 }))
      .rejects.toBeInstanceOf(IdentityLockTimeoutError);
    expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  test("manual exact lock removal allows a later initialization", async () => {
    const directory = temporaryDirectory();
    await withIdentityLock(directory, async () => undefined);
    const lockPath = join(directory, "identity.lock");
    writeFileSync(lockPath, "confirmed-stale", { mode: 0o600 });

    await expect(withIdentityLock(
      directory,
      async () => undefined,
      { waitTimeoutMs: 10, pollIntervalMs: 2 },
    )).rejects.toBeInstanceOf(IdentityLockTimeoutError);

    rmSync(lockPath);
    await expect(withIdentityLock(directory, async () => "recovered")).resolves.toBe("recovered");
  });
});
