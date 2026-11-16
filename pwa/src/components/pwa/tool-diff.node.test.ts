import { expect, test } from "vitest";
import type { JsonValue, TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import { toolDiffView } from "./tool-diff";
import type { ToolValue } from "./tool-presentation";

const base = { event_id: "e", session_id: "s", leaf_id: "g", group_id: "group", timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false, status: "complete" as const };
function event(tool: string, args: JsonValue, result: JsonValue): Extract<TimelineEvent, { kind: "tool"; status: "complete"; args: JsonValue }> {
  return { ...base, tool, args, result };
}
function failed(tool: string, args: JsonValue, error: string, result?: JsonValue): ToolValue {
  return { ...base, tool, args, status: "error", error, ...(result === undefined ? {} : { result }) } as unknown as ToolValue;
}

const PATCH = [
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -10,3 +10,3 @@ function demo",
  " context line",
  "-old line",
  "+new line",
  " tail",
  "@@ -30,2 +30,2 @@",
  " keep",
  "--- looks like a file header",
  "+++ looks like an added header",
].join("\n");

const NATIVE = [
  "-18 old first",
  "-19 old second",
  " 20 context",
  "+18 new first",
  "    ...",
  "-40 old last",
  "+38 new last",
].join("\n");

test("prefers the real unified patch and renders a unified row model", () => {
  const view = toolDiffView(event("edit", { path: "a.ts", oldText: "old line", newText: "new line" }, {
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
    details: { patch: PATCH, diff: NATIVE },
  }));
  expect(view).toBeDefined();
  expect(view?.text).toBe(PATCH);
  expect(view?.rows).toEqual([
    { kind: "line", sign: " ", text: "context line", oldLine: 10, newLine: 10 },
    { kind: "line", sign: "-", text: "old line", oldLine: 11 },
    { kind: "line", sign: "+", text: "new line", newLine: 11 },
    { kind: "line", sign: " ", text: "tail", oldLine: 12, newLine: 12 },
    { kind: "omission" },
    { kind: "line", sign: " ", text: "keep", oldLine: 30, newLine: 30 },
    { kind: "line", sign: "-", text: "-- looks like a file header", oldLine: 31 },
    { kind: "line", sign: "+", text: "++ looks like an added header", newLine: 31 },
  ]);
  expect(view?.added).toBe(2);
  expect(view?.removed).toBe(2);
});

test("never renders hunk or file headers as content lines", () => {
  const view = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: PATCH } }));
  const texts = view?.rows.flatMap((row) => (row.kind === "line" ? [row.text] : [])) ?? [];
  expect(texts.some((text) => text.startsWith("@@") || text.startsWith("--- a/") || text.startsWith("+++ b/"))).toBe(false);
});

test("does not put an omission marker between contiguous hunks", () => {
  const patch = ["@@ -1,1 +1,2 @@", " a", "+b", "@@ -2,1 +3,1 @@", "-c", "+d"].join("\n");
  const view = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch } }));
  expect(view?.rows.map((row) => (row.kind === "line" ? row.sign : "omission"))).toEqual([" ", "+", "-", "+"]);
  expect(view?.rows).toContainEqual({ kind: "line", sign: "+", text: "b", newLine: 2 });
  expect(view?.rows).toContainEqual({ kind: "line", sign: "-", text: "c", oldLine: 2 });
});

test("accepts one paired file header before multiple hunks and rejects orphan headers", () => {
  const orphanOld = "--- a/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: orphanOld } }))).toBeUndefined();

  const orphanNew = "+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: orphanNew } }))).toBeUndefined();

  const repeatedOld = "--- a/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: repeatedOld } }))).toBeUndefined();

  const headers = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-old", "+new", "@@ -5,1 +5,1 @@", "-x", "+y"].join("\n");
  const view = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: headers } }));
  expect(view?.rows.map((row) => (row.kind === "line" ? row.sign : "omission"))).toEqual(["-", "+", "omission", "-", "+"]);
  expect(view?.added).toBe(2);
  expect(view?.removed).toBe(2);
});

test("rejects file headers, meta, unknown backslashes and extra body after the first hunk", () => {
  for (const extra of ["+++ extra", "--- extra", "diff --git a/a.ts b/a.ts", "index 123..456"]) {
    const patch = `@@ -1,1 +1,1 @@\n-old\n+new\n${extra}`;
    expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch } })), extra).toBeUndefined();
  }

  const unknownBackslash = "@@ -1,1 +1,1 @@\n-old\n\\ unknown marker\n+new";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: unknownBackslash } }))).toBeUndefined();

  const exactMarker = "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file";
  const marked = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: exactMarker } }));
  expect(marked?.rows.map((row) => (row.kind === "line" ? row.sign : "omission"))).toEqual(["-", "+"]);
});

test("discards the whole standard diff when any hunk is damaged", () => {
  const patch = ["@@ -1,3 +1,3 @@", " a", "+b", "@@ -10,1 +10,1 @@", "-c", "+d"].join("\n");
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch } }))).toBeUndefined();
});

test("falls back to the native diff after rejecting a damaged patch", () => {
  const patch = ["@@ -1,3 +1,3 @@", " a", "+b", "@@ -10,1 +10,1 @@", "-c", "+d"].join("\n");
  const view = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch, diff: NATIVE } }));
  expect(view?.text).toBe(NATIVE);
  expect(view?.added).toBe(2);
  expect(view?.removed).toBe(3);
});

test("parses the native Pi diff with one-sided line numbers and omission rows", () => {
  const view = toolDiffView(event("edit", { path: "a.ts" }, { content: [{ type: "text", text: "Successfully replaced 2 block(s) in a.ts." }], details: { diff: NATIVE } }));
  expect(view).toBeDefined();
  expect(view?.text).toBe(NATIVE);
  expect(view?.rows).toEqual([
    { kind: "line", sign: "-", text: "old first", oldLine: 18 },
    { kind: "line", sign: "-", text: "old second", oldLine: 19 },
    { kind: "line", sign: " ", text: "context", oldLine: 20 },
    { kind: "line", sign: "+", text: "new first", newLine: 18 },
    { kind: "omission" },
    { kind: "line", sign: "-", text: "old last", oldLine: 40 },
    { kind: "line", sign: "+", text: "new last", newLine: 38 },
  ]);
  expect(view?.added).toBe(2);
  expect(view?.removed).toBe(3);
});

test("accepts padded native line numbers", () => {
  const view = toolDiffView(event("edit", { path: "a.ts" }, { details: { diff: "-   7 removed\n+   7 added" } }));
  expect(view?.rows).toEqual([
    { kind: "line", sign: "-", text: "removed", oldLine: 7 },
    { kind: "line", sign: "+", text: "added", newLine: 7 },
  ]);
});

test("falls back to result.diff and recognized returned diff text", () => {
  const fromResult = toolDiffView(event("edit", { path: "a.ts" }, { diff: NATIVE }));
  expect(fromResult?.text).toBe(NATIVE);

  const fromText = toolDiffView(event("edit", { path: "a.ts" }, [{ type: "text", text: PATCH }]));
  expect(fromText?.text).toBe(PATCH);
  expect(fromText?.added).toBe(2);

  // 前后带含糊正文的文本块不再被当作完整 patch。
  expect(toolDiffView(event("edit", { path: "a.ts" }, { content: [{ type: "text", text: "Done.\n" + PATCH }] }))).toBeUndefined();
});

test("rejects extra body lines and damaged later hunk headers after a complete hunk", () => {
  const extra = "@@ -1,1 +1,1 @@\n-old\n+new\n+extra";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: extra } }))).toBeUndefined();

  const damagedHeader = "@@ -1,1 +1,1 @@\n-old\n+new\n@@ -2,1 +2,1 @\n-old2\n+new2";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: damagedHeader } }))).toBeUndefined();

  const view = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: extra, diff: NATIVE } }));
  expect(view?.text).toBe(NATIVE);
  expect(view?.added).toBe(2);
  expect(view?.removed).toBe(3);
});

test("keeps a real returned diff for a failed edit", () => {
  const view = toolDiffView(failed("edit", { path: "a.ts" }, "Could not find the exact text in a.ts.", { details: { patch: PATCH } }));
  expect(view?.added).toBe(2);
  expect(view?.removed).toBe(2);
});

test("only parses diff views for recognized edit tools", () => {
  expect(toolDiffView(event("read", { path: "a.patch" }, [{ type: "text", text: PATCH }]))).toBeUndefined();
  expect(toolDiffView(event("write", { path: "a.ts", content: "body" }, { details: { patch: PATCH } }))).toBeUndefined();
  expect(toolDiffView(event("bash", { command: "git diff" }, { patch: PATCH }))).toBeUndefined();
});

test("validates hunk starts and line numbers as safe positive integers", () => {
  const zeroWithContent = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: "@@ -0,1 +1,1 @@\n-old\n+new" } }));
  expect(zeroWithContent).toBeUndefined();

  const zeroForEmptySide = toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: "@@ -0,0 +1,1 @@\n+new" } }));
  expect(zeroForEmptySide?.rows).toEqual([{ kind: "line", sign: "+", text: "new", newLine: 1 }]);

  const huge = "9007199254740992";
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: `@@ -${huge},1 +1,1 @@\n-old\n+new` } }))).toBeUndefined();
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { diff: `-${huge} removed\n+1 added` } }))).toBeUndefined();
});

test("never derives a diff from request arguments or non-diff results", () => {
  expect(toolDiffView(event("edit", { path: "a.ts", oldText: "-old", newText: "+new" }, "Applied"))).toBeUndefined();
  expect(toolDiffView(event("write", { path: "a.ts", content: "-old\n+new" }, "Successfully wrote to a.ts"))).toBeUndefined();
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: "not a diff" } }))).toBeUndefined();
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { patch: "--- a/a.ts\n+++ b/a.ts" } }))).toBeUndefined();
  expect(toolDiffView(event("edit", { path: "a.ts" }, { details: { diff: "- old without a number" } }))).toBeUndefined();
  expect(toolDiffView(event("edit", { path: "a.ts" }, "Successfully replaced 1 block(s) in a.ts."))).toBeUndefined();
});
