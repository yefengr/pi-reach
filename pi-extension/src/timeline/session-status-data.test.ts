import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { sessionStatusSchema } from "@pi-reach/protocol/session";
import { readSessionStatus, readStatusBranch, SessionStatusExtensions, type StatusContext } from "./session-status-data.js";

function usage(input: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output: 2, cacheRead, cacheWrite, cost: { total: 0.25 } };
}
test("all SDK usage entry variants accumulate across branches and compaction; latest is assistant only", () => {
  const entries = [
    { type: "usage", usage: usage(10, 10) },
    { type: "message", message: { role: "assistant", usage: usage(20, 20) } },
    { type: "message", message: { role: "toolResult", usage: usage(30, 30) } },
    { type: "branch_summary", usage: usage(40, 40) }, { type: "compaction", usage: usage(50, 50) },
    { type: "message", message: { role: "user", usage: usage(1000) } },
    { type: "message", message: { role: "assistant", usage: usage(10, 30, 10) } },
  ];
  const ctx = { sessionManager: { getEntries: () => entries, getSessionId: () => "s", getLeafId: () => "tip" },
    getContextUsage: () => ({ tokens: 71, contextWindow: 100 }), cwd: process.cwd() } as unknown as StatusContext;
  const snapshot = readSessionStatus(ctx, { compaction: { enabled: false } }, [], "main");
  expect(snapshot.status).toMatchObject({ context: { tokens: 71, level: "high", auto_compact: false }, usage: {
    input: 160, output: 12, cache_read: 180, cache_write: 10, cost: 1.5,
    cache_hit_rate_session: 180 / 350 * 100, cache_hit_rate_latest: 60,
  } });
  expect(sessionStatusSchema.safeParse(snapshot.status).success).toBe(true);
  entries.push({ type: "message", message: { role: "assistant", usage: usage(0) } });
  expect(readSessionStatus(ctx, {}, [], null).status.usage.cache_hit_rate_latest).toBeNull();
});

test.each([[70, "normal"], [70.1, "high"], [90, "high"], [90.1, "full"], [null, null]] as const)(
  "context threshold %s stays aligned with terminal", (tokens, level) => {
    const session = SessionManager.inMemory(process.cwd());
    const ctx = { sessionManager: session, getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: 0 }), cwd: process.cwd() };
    const snapshot = readSessionStatus({ ...ctx, getContextUsage: () => ({ tokens: tokens === null ? null : tokens * 1000, contextWindow: 100_000, percent: 0 }) }, {}, [], null);
    expect(snapshot.status.context).toMatchObject({ level, auto_compact: true });
    expect(snapshot.status.usage.cache_hit_rate_session).toBeNull();
    expect(snapshot.status.usage.cache_hit_rate_latest).toBeNull();
    expect(readSessionStatus({ ...ctx, getContextUsage: () => undefined }, {}, [], null).status.context).toBeNull();
  });

test("extension reports sanitize, normalize, replace, clear, bound lengths and deterministic count", () => {
  const store = new SessionStatusExtensions();
  store.update({ version: 1, key: "ci", label: "\x1b[31mCI\x1b[0m", text: "\t passing\n  now\x00", tone: "warning", section: "future" });
  expect(store.snapshot()).toEqual([{ key: "ci", label: "CI", text: "passing now", tone: "warning" }]);
  store.update({ version: 1, key: "ci", label: "CI", text: "next", section: "usage", tone: "future" });
  expect(store.snapshot()[0]).toEqual({ key: "ci", label: "CI", text: "next", section: "usage" });
  expect(store.update({ version: 2, key: "ci", label: "CI", text: "invalid" })).toBe(false);
  expect(store.update({ version: 1, key: "x".repeat(65), label: "CI", text: "invalid" })).toBe(false);
  expect(store.update({ version: 1, key: "bad", label: "费用", text: "$1", section: "usage" })).toBe(false);
  store.update({ version: 1, key: "ci", label: "CI", text: " \n\t" });
  expect(store.snapshot()).toEqual([]);
  for (let index = 15; index >= 0; index--) store.update({ version: 1, key: String(index).padStart(2, "0"), label: "名".repeat(20), text: "文".repeat(200) });
  expect(store.snapshot()).toHaveLength(12);
  expect(store.snapshot()[0]).toMatchObject({ key: "00", label: "名".repeat(12), text: "文".repeat(160) });
  expect(store.snapshot().every((item) => sessionStatusSchema.shape.extensions.element.safeParse(item).success)).toBe(true);
  store.clear(); expect(store.snapshot()).toEqual([]);
});

test("extensions retain only the first 12 keys and require discarded sources to report again", () => {
  const store = new SessionStatusExtensions();
  const report = (key: string, text = "value") => store.update({ version: 1, key, label: "Label", text });
  const keys = ["z", "a", "Z", "A", "é", "10", "2", "b", "c", "d", "e", "f", "g", "h"];
  for (const key of keys) report(key);
  expect(store.snapshot().map((item) => item.key)).toEqual([...keys].sort().slice(0, 12));
  expect(report("z", "discarded update")).toBe(false);
  expect(report("é")).toBe(false);
  expect(report("A")).toBe(false);
  expect(report("A", "updated")).toBe(true);
  expect(store.snapshot().find((item) => item.key === "A")?.text).toBe("updated");
  expect(report("0")).toBe(true);
  expect(store.snapshot().map((item) => item.key)).toEqual(["0", ...keys.sort().slice(0, 11)]);
  expect(report("0", "")).toBe(true);
  expect(store.snapshot()).toHaveLength(11);
  expect(store.snapshot().some((item) => item.key === "h")).toBe(false);
  expect(report("h")).toBe(true);
  expect(store.snapshot()).toHaveLength(12);
  expect(report("h", "")).toBe(true);
  expect(report("h", "")).toBe(false);
  expect(store.snapshot().some((item) => item.key === "z" || item.key === "é")).toBe(false);
  expect(report("z", "reported again")).toBe(true);
  expect(store.snapshot().at(-1)).toMatchObject({ key: "z", text: "reported again" });
});

test("Git status reads ordinary repo, worktree, detached and non-repo without watchers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reach-status-"));
  const repo = join(root, "repo"), worktree = join(root, "worktree");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
  try {
    git("init", "-b", "status-main", repo);
    git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture");
    const branch = readStatusBranch(repo);
    expect(branch).toBeInstanceOf(Promise);
    expect(await branch).toBe("status-main");
    git("-C", repo, "worktree", "add", "-b", "status-worktree", worktree);
    expect(await readStatusBranch(worktree)).toBe("status-worktree");
    git("-C", repo, "checkout", "--detach"); expect(await readStatusBranch(repo)).toBe("detached");
    expect(await readStatusBranch(root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
