import { expect, test } from "vitest";
import { toolDetailResult } from "./tool_detail_result.js";

const content = [{ type: "text", text: "Executed edit receipt" }];

test("exact edit selects only returned diff metadata and preserves original content", () => {
  const details = { diff: "-1 old\n+1 new", patch: "@@ -1 +1 @@\n-old\n+new", firstChangedLine: 1,
    get full_output_path(): never { throw new Error("private path accessed"); },
    get unknown(): never { throw new Error("unknown metadata accessed"); } };
  const result = toolDetailResult("edit", { content, details }) as { content: unknown; details: unknown };
  expect(result).toEqual({ content, details: { diff: details.diff, patch: details.patch, firstChangedLine: 1 } });
  expect(result.content).toBe(content);
});

test.each(["Edit", "custom_edit", "write", "bash", "read"])("%s keeps its original content and does not inspect details", (tool) => {
  expect(toolDetailResult(tool, { content, get details(): never { throw new Error("metadata accessed"); } })).toBe(content);
});

test.each([undefined, null, [], "diff", {}, { diff: 1, patch: false, firstChangedLine: 0 },
  Object.create({ diff: "inherited" }) as unknown])("invalid edit metadata keeps legacy content: %j", (details) => {
  expect(toolDetailResult("edit", { content, details })).toBe(content);
});

test.each([0, -1, 1.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1])("invalid firstChangedLine %s is omitted", (firstChangedLine) => {
  expect(toolDetailResult("edit", { content, details: { diff: "actual", patch: null, firstChangedLine } }))
    .toEqual({ content, details: { diff: "actual" } });
});

test("valid optional fields are selected independently, including empty strings", () => {
  for (const details of [{ patch: "" }, { diff: "" }, { firstChangedLine: 2 }]) {
    expect(toolDetailResult("edit", { content, details })).toEqual({ content, details });
  }
  expect(toolDetailResult("edit", { content, edits: [{ oldText: "old", newText: "new" }] })).toBe(content);
  expect(toolDetailResult("edit", undefined)).toBeUndefined();
});
