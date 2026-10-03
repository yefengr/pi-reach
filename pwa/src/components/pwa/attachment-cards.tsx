import { useId, useState } from "react";
import { ActionIcon, Progress, UnstyledButton } from "@mantine/core";
import { Check, ChevronDown, ChevronUp, File, RotateCcw, X } from "lucide-react";
import { attachmentPreviewSchema, type AttachmentDescriptor, type AttachmentPreview } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import "./attachment-cards.css";

export type ComposerAttachmentItem = {
  id: string;
  fileName: string;
  byteLength: number;
  preview?: AttachmentPreview;
  status: "draft" | "preparing" | "uploading" | "paused" | "complete" | "failed";
  receivedBytes?: number;
  errorText?: string;
};

type AttachmentCardsProps = {
  items: readonly ComposerAttachmentItem[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  disabled?: boolean;
  collapsible?: boolean;
};

/** 展示描述不含原件或路径；无操作回调时统一为只读卡片。 */
export function readonlyAttachmentItems(attachments: readonly AttachmentDescriptor[]): ComposerAttachmentItem[] {
  return attachments.map(item => ({ id: item.attachment_id, fileName: item.file_name, byteLength: item.byte_length, preview: item.preview, status: "draft" }));
}

function AttachmentThumbnail({ preview, fileName }: { preview?: AttachmentPreview; fileName: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const valid = attachmentPreviewSchema.safeParse(preview);
  const source = valid.success ? `data:image/jpeg;base64,${valid.data.data}` : null;
  if (source && source !== failedSource) return <img className="pwa-attachment-thumb" src={source} alt={fileName} onError={() => setFailedSource(source)} />;
  return <span className="pwa-attachment-thumb pwa-attachment-file" aria-hidden="true"><File size={20} /></span>;
}

function AttachmentCard({ item, onRemove, onRetry, disabled }: { item: ComposerAttachmentItem } & Omit<AttachmentCardsProps, "items" | "collapsible">) {
  const { t, locale } = useI18n();
  const progress = item.byteLength > 0 ? Math.min(100, Math.max(0, (item.receivedBytes ?? 0) / item.byteLength * 100)) : 0;
  const size = item.byteLength >= 1024 * 1024
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(item.byteLength / (1024 * 1024))} MiB`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(item.byteLength / 1024)} KiB`;
  const active = item.status === "preparing" || item.status === "uploading" || item.status === "paused";
  const removeLabel = active ? t.attachments.cancel(item.fileName) : t.attachments.remove(item.fileName);
  const status = item.status === "draft" ? size : item.status === "preparing" ? t.attachments.preparing
    : item.status === "paused" ? t.attachments.paused : item.status === "failed" ? item.errorText || t.attachments.writeFailed : null;
  return <div className="pwa-attachment-card" data-status={item.status} role="group" aria-label={item.status === "complete" ? t.attachments.ready(item.fileName) : item.fileName}>
    <AttachmentThumbnail preview={item.preview} fileName={item.fileName} />
    <div className="pwa-attachment-meta">
      <span className="pwa-attachment-name" title={item.fileName}>{item.fileName}</span>
      {item.status === "uploading" ? <div className="pwa-attachment-progress">
        <Progress value={progress} aria-label={t.attachments.progress(item.fileName)} aria-valuenow={Math.round(progress)} />
        <span>{Math.round(progress)}%</span>
      </div> : status ? <span className="pwa-attachment-status" title={status}>{status}</span> : null}
    </div>
    <div className="pwa-attachment-actions">
      {item.status === "complete" ? <Check className="pwa-attachment-ready" size={20} aria-hidden="true" /> : <>
        {item.status === "failed" && onRetry ? <ActionIcon type="button" disabled={disabled} aria-label={t.attachments.retry(item.fileName)} title={t.attachments.retry(item.fileName)} onClick={() => onRetry(item.id)}><RotateCcw size={20} /></ActionIcon> : null}
        {onRemove ? <ActionIcon type="button" disabled={disabled} aria-label={removeLabel} title={removeLabel} onClick={() => onRemove(item.id)}><X size={20} /></ActionIcon> : null}
      </>}
    </div>
  </div>;
}

export function AttachmentCards({ items, onRemove, onRetry, disabled = false, collapsible = false }: AttachmentCardsProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  // 上传中的单项取消必须始终可达；只折叠尚未发送的纯草稿。
  const canCollapse = collapsible && items.length > 2 && items.every(item => item.status === "draft");
  const visible = canCollapse && !expanded ? items.slice(0, 2) : items;
  if (!items.length) return null;
  return <section className="pwa-attachment-cards" aria-label={t.attachments.title}>
    <div id={listId} className="pwa-attachment-list">
      {visible.map(item => <AttachmentCard key={item.id} item={item} onRemove={onRemove} onRetry={onRetry} disabled={disabled} />)}
    </div>
    {canCollapse ? <UnstyledButton type="button" className="pwa-attachment-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}{expanded ? t.attachments.showLess : t.attachments.showMore(items.length)}
    </UnstyledButton> : null}
  </section>;
}
