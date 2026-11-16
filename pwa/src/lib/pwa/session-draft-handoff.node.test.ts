import { expect, test } from "vitest";
import { handoffDraftText, type SessionDraftHandoff } from "./session-draft-handoff";

const handoff: SessionDraftHandoff = { sourceKey: "source", text: "unsent", version: 4, attachments: { target: "source-files", revision: 0 } };

test("successful text handoff removes only the source copy and leaves unrelated drafts intact", () => {
  const original = { source: "unsent", other: "keep" };
  expect(handoffDraftText(original, handoff, "target", 4)).toEqual({ target: "unsent", other: "keep" });
  expect(original).toEqual({ source: "unsent", other: "keep" });
});

test.each([
  [{ source: "changed" }, "target", 4],
  [{ source: "unsent" }, "target", 5],
  [{ source: "unsent", target: "new input" }, "target", 4],
  [{ source: "unsent", target: " " }, "target", 4],
  [{ source: "unsent" }, "source", 4],
] as const)("conflicting source or target never consumes text (%j, %s, %s)", (drafts, target, version) => {
  expect(handoffDraftText(drafts, handoff, target, version)).toBeNull();
});

test("duplicate handoff cannot resurrect the original text", () => {
  const first = handoffDraftText({ source: "unsent" }, handoff, "target", 4)!;
  expect(handoffDraftText({ ...first, target: "new editing" }, handoff, "target", 4)).toBeNull();
});
