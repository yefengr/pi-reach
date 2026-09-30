import { beforeEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { ExtensionOwner, resetExtensionOwnerForTest } from "./extension_owner.js";

const context = (sessionId: string, sessionFile = `/sessions/${sessionId}.jsonl`) => ({
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  ui: { notify: vi.fn() },
}) as unknown as ExtensionContext;
const start = (reason: SessionStartEvent["reason"], previousSessionFile?: string): SessionStartEvent => ({ type: "session_start", reason, previousSessionFile });

beforeEach(resetExtensionOwnerForTest);

test.each(["reload", "new", "resume", "fork"] as const)("hands the primary endpoint to a replacement instance on %s", (reason) => {
  const primary = new ExtensionOwner();
  expect(primary.activate(start("startup"), context("primary"))).toBe(true);
  primary.release({ type: "session_shutdown", reason });
  const lateChild = new ExtensionOwner();
  expect(lateChild.activate(start("startup"), context("child"))).toBe(false);
  lateChild.release({ type: "session_shutdown", reason: "quit" });
  const replacement = new ExtensionOwner();
  const id = reason === "reload" ? "primary" : "replacement";
  expect(replacement.activate(start(reason, reason === "reload" ? undefined : "/sessions/primary.jsonl"), context(id))).toBe(true);
  expect(primary.isCurrent()).toBe(false);
  expect(replacement.isCurrent()).toBe(true);
  primary.release({ type: "session_shutdown", reason: "quit" });
  expect(replacement.isCurrent()).toBe(true);
  expect(lateChild.activate(start(reason, "/sessions/primary.jsonl"), context(id))).toBe(false);
});

test("does not transfer a reload to another session or a resume to another file", () => {
  const primary = new ExtensionOwner();
  primary.activate(start("startup"), context("primary"));
  primary.release({ type: "session_shutdown", reason: "reload" });
  expect(new ExtensionOwner().activate(start("reload"), context("child"))).toBe(false);
  const reloaded = new ExtensionOwner();
  expect(reloaded.activate(start("reload"), context("primary"))).toBe(true);
  reloaded.release({ type: "session_shutdown", reason: "resume", targetSessionFile: "/sessions/target.jsonl" });
  expect(new ExtensionOwner().activate(start("resume", "/sessions/primary.jsonl"), context("wrong"))).toBe(false);
  expect(new ExtensionOwner().activate(start("resume", "/sessions/other.jsonl"), context("target"))).toBe(false);
  expect(new ExtensionOwner().activate(start("resume", "/sessions/primary.jsonl"), context("target"))).toBe(true);
});

test("rejected child callbacks and commands cannot mutate the endpoint even after primary shutdown", async () => {
  const primary = new ExtensionOwner();
  const child = new ExtensionOwner();
  primary.activate(start("startup"), context("primary"));
  child.activate(start("startup"), context("child"));
  let callback: (() => void) | undefined;
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const onEvent = vi.fn();
  const onCommand = vi.fn();
  const api = child.guard({
    on: (_name: string, handler: () => void) => { callback = handler; },
    registerCommand: (_name: string, value: { handler: typeof command }) => { command = value.handler; },
  } as unknown as ExtensionAPI);
  api.on("agent_start", onEvent);
  api.registerCommand("pi-reach stop", { handler: onCommand });
  callback?.();
  await command?.("", context("child"));
  primary.release({ type: "session_shutdown", reason: "quit" });
  expect(child.activate(start("startup"), context("child"))).toBe(false);
  callback?.();
  await command?.("", context("child"));
  expect(onEvent).not.toHaveBeenCalled();
  expect(onCommand).not.toHaveBeenCalled();
});
