import { describe, expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseMarkerV2 } from "../protocol/v2/marker.js";
import { runEndStatus } from "./run_end.js";
import { TimelineRuntime, TIMELINE_MARKER } from "./runtime.js";

function userMessage(text: string, timestamp = 1): Record<string, unknown> {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, stopReason = "stop", timestamp = 2): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp };
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function runOnce(runtime: TimelineRuntime, session: SessionManager, messages: Record<string, unknown>[]): void {
  runtime.onAgentStart();
  for (const message of messages) {
    runtime.onMessageStart(message, session);
    session.appendMessage(message as never);
    runtime.onMessageEnd(message, session);
  }
  runtime.onAgentEnd(messages);
}

describe("runEndStatus", () => {
  test("maps the final assistant stop reason of the run", () => {
    expect(runEndStatus([userMessage("hi"), assistantMessage("done")])).toBe("complete");
    expect(runEndStatus([assistantMessage("tool", "toolUse"), assistantMessage("partial", "aborted")])).toBe("interrupted");
    expect(runEndStatus([assistantMessage("", "error")])).toBe("error");
    expect(runEndStatus([userMessage("hi")])).toBe("interrupted");
    expect(runEndStatus(undefined)).toBe("interrupted");
  });
});

describe("TimelineRuntime run_end", () => {
  test("persists a run_end marker and publishes it after the run's formal events", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runOnce(runtime, session, [userMessage("hi"), assistantMessage("done")]);
    await nextMacrotask();

    const published = runtime.getPublishedEvents();
    expect(published.map((event) => [event.kind, event.event_seq])).toEqual([["user", 1], ["assistant", 2], ["run_end", 3]]);
    const runEnd = published[2]!;
    expect(runEnd).toMatchObject({ kind: "run_end", status: "complete", group_id: published[1]!.group_id });
    expect(runtime.recover(session).find((event) => event.event_id === runEnd.event_id)).toEqual(runEnd);

    const markers = session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TIMELINE_MARKER);
    const last = markers.at(-1)!;
    expect(last.id).toBe(runEnd.event_id);
    expect(parseMarkerV2((last as { data: unknown }).data)).toEqual({ version: 2, group_id: runEnd.group_id, kind: "run_end", status: "complete" });
  });

  test("closes each run with its own group and status", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runOnce(runtime, session, [userMessage("one"), assistantMessage("first")]);
    runOnce(runtime, session, [userMessage("two"), assistantMessage("stopped", "aborted")]);
    await nextMacrotask();

    const runEnds = runtime.recover(session).filter((event) => event.kind === "run_end");
    expect(runEnds.map((event) => event.kind === "run_end" && event.status)).toEqual(["complete", "interrupted"]);
    expect(new Set(runEnds.map((event) => event.kind === "run_end" && event.group_id)).size).toBe(2);
  });

  test("writes nothing when the run produced no timeline group", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runtime.attach(session);
    runtime.onAgentStart();
    runtime.onAgentEnd([]);
    await nextMacrotask();

    expect(runtime.getPublishedEvents()).toEqual([]);
    expect(session.getBranch()).toEqual([]);
  });

  test("does not publish a run_end after the session is reset", async () => {
    const session = SessionManager.inMemory(process.cwd());
    const runtime = new TimelineRuntime();
    runOnce(runtime, session, [userMessage("hi"), assistantMessage("done")]);
    runtime.resetSession(SessionManager.inMemory(process.cwd()));
    await nextMacrotask();

    expect(runtime.getPublishedEvents()).toEqual([]);
  });
});
