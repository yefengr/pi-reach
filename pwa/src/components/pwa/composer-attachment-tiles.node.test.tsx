import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerAttachmentItem } from "./attachment-cards";
import { ComposerAttachmentTiles } from "./composer-attachment-tiles";
import { PwaUiProvider } from "./pwa-ui-provider";

const file: ComposerAttachmentItem = { id: "file", fileName: "notes.txt", byteLength: 1024, status: "draft" };
function markup(items: ComposerAttachmentItem[], interactive = true) {
  return renderToStaticMarkup(<PwaUiProvider><ComposerAttachmentTiles items={items} onRemove={interactive ? () => {} : undefined} onRetry={interactive ? () => {} : undefined} /></PwaUiProvider>);
}

test("renders nothing without attachments and names each tile with a native hint", () => {
  expect(markup([])).not.toContain("pwa-attachment-tiles");
  const html = markup([file]);
  expect(html).toContain('aria-label="notes.txt"');
  expect(html).toContain(">TXT<");
  expect(html).toContain("1 KiB");
  expect(html).toContain('aria-label="Remove notes.txt"');
  // 方块上不显示文件名，悬停时由原生提示给出。
  expect(html).toContain('title="notes.txt"');
});

test("a finished upload looks like a draft and carries no check mark", () => {
  const html = markup([{ ...file, status: "complete" }]);
  expect(html).toContain('aria-label="notes.txt, uploaded"');
  expect(html).not.toContain("lucide-check");
  expect(html).not.toContain('role="progressbar"');
});

test("uploading and paused tiles show a ring with the percentage; cancellation stays available", () => {
  const uploading = markup([{ ...file, status: "uploading", receivedBytes: 512 }]);
  expect(uploading).toContain('role="progressbar"');
  expect(uploading).toContain('aria-valuenow="50"');
  expect(uploading).toContain('class="pwa-attachment-tile-percent">50<');
  expect(uploading).toContain('aria-label="Cancel notes.txt"');
  const paused = markup([{ ...file, status: "paused", receivedBytes: 256 }]);
  expect(paused).toContain('aria-valuenow="25"');
  expect(paused).toContain("notes.txt，Paused");
  const preparing = markup([{ ...file, status: "preparing" }]);
  expect(preparing).toContain('data-status="preparing"');
  expect(preparing).not.toContain('role="progressbar"');
  expect(preparing).toContain('aria-label="Cancel notes.txt"');
});

test("a failed tile offers retry and exposes the short reason to assistive technology", () => {
  const html = markup([{ ...file, status: "failed", errorText: "Disk full" }]);
  expect(html).toContain('aria-label="Retry notes.txt"');
  expect(html).toContain("lucide-refresh-cw");
  expect(html).toContain("notes.txt，Disk full");
  expect(markup([{ ...file, status: "failed" }], false)).not.toContain("<button");
});

test("only a valid preview becomes the tile image; long or missing extensions are omitted", () => {
  const invalid = markup([{ ...file, preview: { mime_type: "image/jpeg", data: "YQ==", byte_length: 2, width: 1, height: 1 } }]);
  expect(invalid).not.toContain("<img");
  const valid = markup([{ ...file, preview: { mime_type: "image/jpeg", data: "YQ==", byte_length: 1, width: 1, height: 1 } }]);
  expect(valid).toContain('src="data:image/jpeg;base64,YQ=="');
  expect(markup([{ ...file, fileName: "archive.longextension" }])).not.toContain("pwa-attachment-tile-ext");
  expect(markup([{ ...file, fileName: "Makefile" }])).not.toContain("pwa-attachment-tile-ext");
});
