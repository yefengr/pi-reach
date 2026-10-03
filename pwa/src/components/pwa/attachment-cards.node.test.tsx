import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentCards, type ComposerAttachmentItem } from "./attachment-cards";
import { PwaUiProvider } from "./pwa-ui-provider";

const file: ComposerAttachmentItem = { id: "file", fileName: "notes.txt", byteLength: 1024, status: "draft" };
function markup(items: ComposerAttachmentItem[], interactive = false) {
  return renderToStaticMarkup(<PwaUiProvider><AttachmentCards items={items} onRemove={interactive ? () => {} : undefined} onRetry={interactive ? () => {} : undefined} collapsible /></PwaUiProvider>);
}

test("empty and readonly cards never expose file operations", () => {
  expect(markup([])).not.toContain("pwa-attachment-cards");
  const html = markup([file]);
  expect(html).toContain("notes.txt");
  expect(html).toContain("1 KiB");
  expect(html).not.toContain("<button");
});

test("only uploading has a per-file progress bar; complete has just its check", () => {
  const uploading = markup([{ ...file, status: "uploading", receivedBytes: 512 }], true);
  expect(uploading).toContain('aria-valuenow="50"');
  expect(uploading).toContain("50%");
  expect(uploading).toContain('aria-label="Cancel notes.txt"');
  const complete = markup([{ ...file, status: "complete" }], true);
  expect(complete).toContain("lucide-check");
  expect(complete).not.toContain("<button");
  expect(complete).not.toContain("pwa-attachment-progress");
  const failed = markup([{ ...file, status: "failed", errorText: "Disk full" }], true);
  expect(failed).toContain("Disk full");
  expect(failed).toContain('aria-label="Retry notes.txt"');
  expect(failed).not.toContain("pwa-attachment-progress");
});

test("rejects invalid historical previews instead of accepting arbitrary data URLs", () => {
  const html = markup([{ ...file, preview: { mime_type: "image/jpeg", data: "YQ==", byte_length: 2, width: 1, height: 1 } }]);
  expect(html).not.toContain("<img");
  const valid = markup([{ ...file, preview: { mime_type: "image/jpeg", data: "YQ==", byte_length: 1, width: 1, height: 1 } }]);
  expect(valid).toContain('alt="notes.txt"');
  expect(valid).toContain('src="data:image/jpeg;base64,YQ=="');
});

test("collapsing a draft unmounts hidden controls but active uploads remain reachable", () => {
  const files = Array.from({ length: 4 }, (_, index) => ({ ...file, id: `file-${index}`, fileName: `file-${index}.txt` }));
  expect(markup(files, true)).not.toContain("file-2.txt");
  expect(markup(files.map(item => ({ ...item, status: "paused" })), true)).toContain("file-3.txt");
});
