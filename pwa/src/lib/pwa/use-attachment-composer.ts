import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ATTACHMENT_PREVIEW_MAX_BYTES, ATTACHMENT_PREVIEW_MAX_DIMENSION, attachmentPreviewSchema, type AttachmentPreview } from "@pi-reach/protocol/session";
import type { ComposerAttachmentItem } from "@/components/pwa/attachment-cards";
import type { Messages } from "@/lib/i18n";
import { AttachmentComposer, type AttachmentReadyMessage } from "./attachment-composer";
import { AttachmentUploadClient } from "./attachment-upload";

// 草稿预览独立于上传准备，不读取原件完整 ArrayBuffer 或计算摘要。
async function draftPreview(file: File): Promise<AttachmentPreview | undefined> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, ATTACHMENT_PREVIEW_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4, 0.2]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob || blob.size > ATTACHMENT_PREVIEW_MAX_BYTES) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const parsed = attachmentPreviewSchema.safeParse({ mime_type: "image/jpeg", data: btoa(binary), byte_length: bytes.length, width: canvas.width, height: canvas.height });
      if (parsed.success) return parsed.data;
    }
  } catch { /* 不可解码的图片仍按原件上传。 */ }
  finally { bitmap?.close(); }
}

export function attachmentErrorText(code: string | undefined, t: Messages["attachments"]): string {
  switch (code) {
    case "too_large": return t.tooLarge;
    case "prepare_failed": return t.prepareFailed;
    case "no_space": return t.noSpace;
    case "integrity_mismatch": return t.integrityFailed;
    case "timeout": return t.timeout;
    case "not_found": return t.notFound;
    case "busy": return t.busy;
    case "invalid_scope": return t.scopeChangedNotice;
    case "unsupported": return t.upgrade;
    default: return t.writeFailed;
  }
}

export function pruneAttachmentPreviews(previews: ReadonlyMap<string, AttachmentPreview>, ids: readonly string[]): ReadonlyMap<string, AttachmentPreview> {
  const retained = new Set(ids);
  if ([...previews.keys()].every((id) => retained.has(id))) return previews;
  return new Map([...previews].filter(([id]) => retained.has(id)));
}

class ComposerBridge {
  private onReady: (message: AttachmentReadyMessage) => boolean = () => false;
  private onChange: () => void = () => {};
  callbacks(onReady: (message: AttachmentReadyMessage) => boolean, onChange: () => void) {
    this.onReady = onReady; this.onChange = onChange;
  }
  readonly composer = new AttachmentComposer({
    createClient: (onCapabilityChange) => new AttachmentUploadClient({ onCapabilityChange }),
    onChange: () => this.onChange(), onReady: (message) => this.onReady(message),
  });
}

export function useAttachmentComposer(onReady: (message: AttachmentReadyMessage) => boolean, t: Messages["attachments"]) {
  const [, render] = useState(0);
  const [bridge] = useState(() => new ComposerBridge());
  const [previews, setPreviews] = useState<ReadonlyMap<string, AttachmentPreview>>(() => new Map());
  useLayoutEffect(() => {
    bridge.callbacks(onReady, () => {
      setPreviews((current) => pruneAttachmentPreviews(current, bridge.composer.previewItemIds()));
      render((value) => value + 1);
    });
  }, [bridge, onReady]);
  const aliveRef = useRef(true);
  const composer = bridge.composer;
  useEffect(() => {
    const pageHide = (event: PageTransitionEvent) => { if (!event.persisted) composer.dispose(); };
    window.addEventListener("pagehide", pageHide);
    return () => { aliveRef.current = false; bridge.callbacks(() => false, () => {}); window.removeEventListener("pagehide", pageHide); composer.dispose(); };
  }, [bridge, composer]);
  const snapshot = composer.snapshot();
  const items: readonly ComposerAttachmentItem[] = snapshot.items.map((item) => ({
    ...item, preview: item.attachment?.preview ?? previews.get(item.id),
    ...(item.errorCode ? { errorText: attachmentErrorText(item.errorCode, t) } : {}),
  }));
  const notice = snapshot.committing ? t.committingNotice : snapshot.issue ? {
    too_many: t.tooMany, too_large: t.tooLarge, total_too_large: t.totalTooLarge, invalid_file: t.invalidFile,
    unsupported: t.upgrade, failed: t.failedNotice, disconnected: t.disconnectedNotice,
    scope_changed: t.scopeChangedNotice, send_failed: t.sendFailedNotice,
  }[snapshot.issue] : snapshot.capability.status === "unsupported" ? t.upgrade : null;
  const actions = useMemo(() => ({
    addFiles(files: readonly File[]) {
      const before = new Set(composer.snapshot().items.map((item) => item.id));
      if (composer.addFiles(files)) return;
      const added = composer.snapshot().items.filter((item) => !before.has(item.id));
      files.forEach((file, index) => {
        const item = added[index];
        if (!item) return;
        void draftPreview(file).then((preview) => {
          if (!preview || !aliveRef.current || !composer.previewItemIds().includes(item.id)) return;
          setPreviews((current) => new Map(current).set(item.id, preview));
        });
      });
    },
    remove(id: string) { composer.remove(id); setPreviews((current) => { const next = new Map(current); next.delete(id); return next; }); },
    retry(id: string) { composer.retry(id); },
  }), [composer]);
  return { composer, snapshot, items, notice, ...actions };
}
