import { expect, test } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerAttachmentMenu, MessageComposer } from "./message-composer";
import { PwaUiProvider } from "./pwa-ui-provider";

const commonProps = {
  attachments: [], canAttach: true, sendingAttachments: false, isOnline: true, stopping: false,
  onDraftChange: () => {}, onSend: () => {}, onStop: () => {}, onAddFiles: () => {},
  onRemoveAttachment: () => {}, onRetryAttachment: () => {}, commandModels: [], commandCurrentModel: null,
  commandCurrentModelFallback: null, commandThinking: "off" as const, commandPendingAction: null,
  onNewSession: () => {}, onCompactSession: () => {}, onSetModel: () => {}, onSetThinking: () => {}, onCommandsOpen: () => {},
};
function renderComposer(overrides: Partial<ComponentProps<typeof MessageComposer>> = {}) {
  return renderToStaticMarkup(<PwaUiProvider><MessageComposer {...commonProps} draft="" isWorking={false} {...overrides} /></PwaUiProvider>);
}
function button(html: string, label: string) {
  return html.match(new RegExp(`<button\\b(?=[^>]*\\baria-label="${label}")[^>]*>(?:(?!<\\/button>)[\\s\\S])*?<\\/button>`))?.[0] ?? "";
}
const attachment = { id: "file", fileName: "notes.txt", byteLength: 1024, status: "draft" as const };

test("renders Mantine textarea, attachment menu and a disabled empty Send", () => {
  const html = renderComposer();
  expect(html).toContain('rows="1"');
  expect(html).toContain('placeholder="Message your agent…"');
  expect(button(html, "Add attachments")).toMatch(/pwa-composer-icon/);
  expect(button(html, "Pi commands")).toMatch(/aria-expanded="false"/);
  expect(button(html, "Send message")).toMatch(/disabled=""/);
  expect(button(html, "Send message")).toMatch(/lucide-arrow-up/);
  expect(html).not.toContain("pwa-composer-menu-panel");
  expect(html).not.toContain("pwa-composer-hint");
  expect(html).toContain('multiple=""');
  expect(html).toContain('accept="image/*"');
});

test("renders the opened Mantine attachment menu", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><ComposerAttachmentMenu disabled={false} opened onChange={() => {}} onChooseFiles={() => {}} onUseCamera={() => {}} withinPortal={false} /></PwaUiProvider>);
  expect(button(html, "Add attachments")).toContain('aria-expanded="true"');
  expect(html).toContain("Choose files");
  expect(html).toContain("Use camera");
  expect(html).toContain('role="menuitem"');
  expect(html).toContain("bottom:auto");
});

test("keeps offline text editable and places its one hint outside and before the card", () => {
  const html = renderComposer({ isOnline: false, canAttach: false, attachments: [attachment] });
  expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain('disabled=""');
  expect(button(html, "Pi commands")).toContain('disabled=""');
  expect(button(html, "Send message")).toContain('disabled=""');
  expect(html.indexOf("pwa-composer-hint")).toBeLessThan(html.indexOf("pwa-attachment-cards"));
  expect(html.indexOf("pwa-attachment-cards")).toBeLessThan(html.indexOf('class="pwa-composer-card"'));
  const explicit = renderComposer({ isOnline: false, attachmentNotice: "Uploads paused" });
  expect(explicit).toContain("Uploads paused");
  expect(explicit).not.toContain("You can send once");
});

test("locks adding/text/sending during upload without disabling individual cancellation", () => {
  const html = renderComposer({ attachments: [{ ...attachment, status: "uploading", receivedBytes: 512 }], sendingAttachments: true });
  expect(button(html, "Cancel notes.txt")).not.toContain('disabled=""');
  expect(button(html, "Add attachments")).toContain('disabled=""');
  expect(button(html, "Send message")).toContain('disabled=""');
  expect(html.match(/<textarea[^>]*>/)?.[0]).toContain('disabled=""');
});

test.each(["", "Continue this task"])("shows only Stop while working with draft %s", draft => {
  const html = renderComposer({ isWorking: true, draft });
  expect(button(html, "Stop current task")).toMatch(/pwa-composer-stop/);
  expect(button(html, "Stop current task")).toMatch(/data-variant="filled"/);
  expect(html).not.toContain('aria-label="Send message"');
  expect(html.match(/<textarea[^>]*>/)?.[0]).not.toContain('disabled=""');
});

test("shows one disabled pending Stop", () => {
  const html = renderComposer({ isWorking: true, stopping: true });
  expect(button(html, "Stopping current task")).toContain('disabled=""');
  expect(button(html, "Stopping current task")).toContain("pwa-spin");
  expect(html).not.toContain('aria-label="Send message"');
});

test("allows an attachment-only message but disables it when capability is unavailable", () => {
  expect(button(renderComposer({ attachments: [attachment] }), "Send message")).not.toContain('disabled=""');
  expect(button(renderComposer({ attachments: [attachment], canAttach: false }), "Send message")).toContain('disabled=""');
});
