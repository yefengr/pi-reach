import { expect, test } from "vitest";
import { getMessages } from "@/lib/i18n";
import type { AttachmentPreview } from "@pi-reach/protocol/session";
import { attachmentErrorText, pruneAttachmentPreviews } from "./use-attachment-composer";

test("preview pruning keeps every live target but drops removed and handed-off items", () => {
  const preview: AttachmentPreview = { mime_type: "image/jpeg", data: "aGk=", byte_length: 2, width: 1, height: 1 };
  const previews = new Map([["current", preview], ["other-target", preview], ["removed", preview], ["submitted", preview]]);
  const retained = pruneAttachmentPreviews(previews, ["current", "other-target"]);
  expect([...retained.keys()]).toEqual(["current", "other-target"]);
  expect(pruneAttachmentPreviews(retained, ["current", "other-target"])).toBe(retained);
  expect(pruneAttachmentPreviews(retained, []).size).toBe(0);
});

test("attachment errors use fixed bilingual-facing keys, never raw messages", () => {
  const t = getMessages().attachments;
  expect(attachmentErrorText("no_space", t)).toBe(t.noSpace);
  expect(attachmentErrorText("prepare_failed", t)).toBe(t.prepareFailed);
  expect(attachmentErrorText("integrity_mismatch", t)).toBe(t.integrityFailed);
  expect(attachmentErrorText("timeout", t)).toBe(t.timeout);
  expect(attachmentErrorText("not_found", t)).toBe(t.notFound);
  expect(attachmentErrorText("busy", t)).toBe(t.busy);
  expect(attachmentErrorText("unsupported", t)).toBe(t.upgrade);
  expect(attachmentErrorText("invalid_scope", t)).toBe(t.scopeChangedNotice);
  expect(attachmentErrorText("io_error /private/secret token=hidden", t)).toBe(t.writeFailed);
});
