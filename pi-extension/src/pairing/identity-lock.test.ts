import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  IdentityLockTimeoutError,
  withIdentityLock,
} from "./identity-lock.js";

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-reach-identity-lock-"));
  roots.push(root);
  return join(root, "remote");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("identity initialization lock", () => {
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
