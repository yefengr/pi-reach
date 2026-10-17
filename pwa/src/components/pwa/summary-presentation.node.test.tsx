import { expect, test } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { zh } from "@/lib/i18n/messages/zh";
import { summaryPresentation, summaryText, type SummaryEvent } from "./summary-presentation";

const base = { event_id: "summary", session_id: "session", leaf_id: "leaf", timestamp: 0, truncated: false };

test("extracts only a nonempty summary string without changing its language or format", () => {
  const text = "\n## Keep this instruction\n\n  original text  \n";
  expect(summaryText(text)).toBe(text);
  expect(summaryText({ summary: text, details: { secret: "hidden" }, internal_id: "hidden" })).toBe(text);
  for (const payload of [null, undefined, 1, true, [], {}, { summary: 1 }, { summary: {} }, { summary: " \n" }, { details: "not a summary" }]) expect(summaryText(payload)).toBeNull();
});

test.each([en, zh])("missing bodies use short localized fallback, never whole JSON", dictionary => {
  for (const kind of ["compaction", "branch_summary"] as const) {
    const presentation = summaryPresentation({ ...base, kind, payload: { details: "INTERNAL_SECRET" } }, dictionary.summaryReader);
    expect(presentation.text).toBe(dictionary.summaryReader.unavailable);
    expect(presentation.text).not.toContain("INTERNAL_SECRET");
  }
});

test.each([en, zh])("provider errors never expose or infer information from arbitrary message", dictionary => {
  const event: SummaryEvent = { ...base, group_id: "group", kind: "provider_error", message: "HTTP 429 Authorization: Bearer PRIVATE_TOKEN\nrequest body\nstack trace" };
  const presentation = summaryPresentation(event, dictionary.summaryReader);
  expect(presentation.text).toBe(`${dictionary.summaryReader.errorExplanation}\n\n${dictionary.summaryReader.recoveryAdvice}`);
  expect(presentation.text).not.toMatch(/429|PRIVATE_TOKEN|request body|stack trace/);
  expect(presentation.error).toBe(true);
});
