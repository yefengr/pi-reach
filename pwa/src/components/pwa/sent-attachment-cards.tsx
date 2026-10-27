import { useMemo, useRef, useState } from "react";
import { ActionIcon, Progress, UnstyledButton } from "@mantine/core";
import { Download, X } from "lucide-react";
import type { AttachmentDescriptor } from "@pi-reach/protocol/session";
import { useI18n, type Messages } from "@/lib/i18n";
import { fileSaveName } from "@/lib/pwa/file-preview";
import { attachmentFile, fileKey } from "@/lib/pwa/file-source";
import { AttachmentThumbnail, attachmentSizeLabel } from "./attachment-cards";
import { IMAGE_MIME, TEXT_MIME, type PublishedFileRead } from "./published-file";
import { usePublishedFilesView } from "./published-files-context";
import "./attachment-cards.css";

type Props = { attachments: readonly AttachmentDescriptor[]; onRead: PublishedFileRead };

function fetchError(t: Messages, code: string | undefined): string | null {
  // 主动取消回到可获取状态，不显示失败。
  if (!code || code === "cancelled") return null;
  if (code === "unsupported") return t.attachments.fetchUpgrade;
  if (code === "file_changed" || code === "integrity_mismatch") return t.attachments.originalChanged;
  if (code === "too_large") return t.files.tooLarge;
  if (code === "not_available" || code === "permission_denied" || code === "not_regular_file") return t.files.unavailable;
  return t.files.failed;
}

/** 在线会话中已发送的附件：点击从电脑取回原件，图片与文本交给既有阅读器，其他类型只保存。 */
function SentAttachmentCard({ attachment, onRead }: { attachment: AttachmentDescriptor; onRead: PublishedFileRead }) {
  const { t, locale } = useI18n();
  const files = usePublishedFilesView();
  const file = useMemo(() => attachmentFile(attachment), [attachment]);
  const key = fileKey(file);
  const state = files?.getState(key);
  const pending = useRef(false);
  const [acquiring, setAcquiring] = useState(false);
  const name = file.file_name;
  const canFetch = files?.canFetch === true;
  const ready = state?.phase === "ready";
  const fetching = acquiring || state?.phase === "opening" || state?.phase === "reading";
  const previewable = state?.preview ? state.preview.kind !== "none" : IMAGE_MIME.test(file.mime_type) || TEXT_MIME.test(file.mime_type);
  const error = state?.phase === "error" ? fetchError(t, state.error) : null;
  const disabled = !canFetch || files?.active === true;

  const acquire = async (intent: "view" | "download", trigger?: HTMLButtonElement) => {
    if (!files || pending.current) return;
    if (!ready && disabled) return;
    pending.current = true;
    setAcquiring(true);
    try {
      if (!ready || intent === "download") await files.open(file, intent);
      if (intent !== "view" || !trigger?.isConnected) return;
      const result = files.getState(key);
      // 内容就绪才交给阅读器；不可预览的原件留在卡片上由保存入口处理。
      const readable = result?.phase === "ready" && (result.preview?.kind === "image" ? !!result.url : result.preview?.kind === "text" && result.text !== undefined);
      if (readable) onRead(file, trigger);
    } catch { /* 失败已写入 controller 状态并在卡片上显示。 */ }
    finally { pending.current = false; setAcquiring(false); }
  };

  const progress = file.byte_length > 0 ? Math.min(100, Math.round((state?.receivedBytes ?? 0) / file.byte_length * 100)) : 0;
  const status = state?.phase === "manual" ? t.files.noPreview : error ?? attachmentSizeLabel(file.byte_length, locale);
  const body = <>
    <AttachmentThumbnail preview={attachment.preview} fileName={name} />
    <div className="pwa-attachment-meta">
      <span className="pwa-attachment-name" title={name}>{name}</span>
      {fetching ? <div className="pwa-attachment-progress">
        <Progress value={progress} aria-label={t.files.fetching} aria-valuenow={progress} />
        <span role="status">{progress}%</span>
      </div> : <span className="pwa-attachment-status" title={status} role={error ? "alert" : undefined}>{status}</span>}
    </div>
  </>;
  return <div className="pwa-attachment-card" data-status={error ? "failed" : undefined} data-attachment-id={file.attachment_id} role="group" aria-label={name}>
    {previewable && (canFetch || ready)
      ? <UnstyledButton type="button" className="pwa-attachment-body pwa-attachment-open" aria-label={t.attachments.view(name)} title={t.attachments.view(name)}
        disabled={fetching || !ready && disabled} onClick={event => { void acquire("view", event.currentTarget); }}>{body}</UnstyledButton>
      : <div className="pwa-attachment-body">{body}</div>}
    <div className="pwa-attachment-actions">
      {fetching ? <ActionIcon type="button" aria-label={t.common.cancel} title={t.common.cancel} onClick={() => files?.cancel()}><X size={20} aria-hidden="true" /></ActionIcon>
        : ready && state?.url ? <ActionIcon component="a" href={state.url} download={fileSaveName(name)} aria-label={t.attachments.save(name)} title={t.attachments.save(name)}><Download size={20} aria-hidden="true" /></ActionIcon>
          : canFetch ? <ActionIcon type="button" disabled={disabled} aria-label={t.attachments.download(name)} title={t.attachments.download(name)} onClick={() => { void acquire("download"); }}><Download size={20} aria-hidden="true" /></ActionIcon>
            : null}
    </div>
  </div>;
}

export function SentAttachmentCards({ attachments, onRead }: Props) {
  const { t } = useI18n();
  return <section className="pwa-attachment-cards" aria-label={t.attachments.title}>
    <div className="pwa-attachment-list">
      {attachments.map(item => <SentAttachmentCard key={item.attachment_id} attachment={item} onRead={onRead} />)}
    </div>
  </section>;
}
