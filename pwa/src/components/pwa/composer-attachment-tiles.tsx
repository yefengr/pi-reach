import { useLayoutEffect, useRef, useState } from "react";
import { ActionIcon, RingProgress } from "@mantine/core";
import { File, RefreshCw, X } from "lucide-react";
import { attachmentPreviewSchema } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import { attachmentSizeLabel, type ComposerAttachmentItem } from "./attachment-cards";
import { detachInPlace, useLeavingItems, withLeavingItems } from "./use-leaving-items";
import { FLIP_KEY_ATTRIBUTE, useFlipLayout } from "./use-flip-layout";
import { hideDuringOwnSend, presenceProps, usePresence } from "./use-presence";
import "./composer-attachment-tiles.css";

/** 圆圈进度的外径与线宽（DESIGN「会话附件」），与 72 方块的中央留白配套。 */
const RING_SIZE = 36;
const RING_THICKNESS = 3;
/** 扩展名超过该长度时视为没有可读扩展名，避免把长尾片段当作类型显示。 */
const MAX_EXTENSION_LENGTH = 5;

type Props = {
  items: readonly ComposerAttachmentItem[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  disabled?: boolean;
};

function fileExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  const extension = fileName.slice(dot + 1);
  return extension.length > MAX_EXTENSION_LENGTH ? null : extension.toUpperCase();
}

function uploadPercent(item: ComposerAttachmentItem): number {
  if (item.byteLength <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (item.receivedBytes ?? 0) / item.byteLength * 100)));
}

/** 图片预览铺满方块；没有预览或解码失败时显示文件图标、扩展名与大小。 */
function TileFace({ item }: { item: ComposerAttachmentItem }) {
  const { locale } = useI18n();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const valid = attachmentPreviewSchema.safeParse(item.preview);
  const source = valid.success ? `data:image/jpeg;base64,${valid.data.data}` : null;
  if (source && source !== failedSource) return <img className="pwa-attachment-tile-image" src={source} alt="" onError={() => setFailedSource(source)} />;
  const extension = fileExtension(item.fileName);
  return <span className="pwa-attachment-tile-file" aria-hidden="true">
    <File size={20} />
    {extension ? <span className="pwa-attachment-tile-ext">{extension}</span> : null}
    <span className="pwa-attachment-tile-size">{attachmentSizeLabel(item.byteLength, locale)}</span>
  </span>;
}

function AttachmentTile({ item, onRemove, onRetry, disabled, leaving = false }: { item: ComposerAttachmentItem; leaving?: boolean } & Omit<Props, "items">) {
  const { t } = useI18n();
  const tileRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (leaving) detachInPlace(tileRef.current); }, [leaving]);
  const active = item.status === "preparing" || item.status === "uploading" || item.status === "paused";
  const ringed = item.status === "uploading" || item.status === "paused";
  const percent = uploadPercent(item);
  const status = item.status === "preparing" ? t.attachments.preparing : item.status === "paused" ? t.attachments.paused
    : item.status === "failed" ? item.errorText || t.attachments.writeFailed : null;
  const tip = status ? `${item.fileName} · ${status}` : item.fileName;
  const removeLabel = active ? t.attachments.cancel(item.fileName) : t.attachments.remove(item.fileName);
  // 悬停说明用原生提示：触屏不弹出，与其他图标按钮、截断文字一致。
  return <div ref={tileRef} title={tip} className="pwa-attachment-tile" {...{ [FLIP_KEY_ATTRIBUTE]: item.id }} data-status={item.status} role="group"
      {...(leaving ? { "data-presence": "leaving", inert: true, "aria-hidden": true } : {})} aria-label={status ? `${item.fileName}，${status}` : item.status === "complete" ? t.attachments.ready(item.fileName) : item.fileName}>
      <span className="pwa-attachment-tile-face">
        <TileFace item={item} />
        {ringed ? <span className="pwa-attachment-tile-overlay">
          <RingProgress size={RING_SIZE} thickness={RING_THICKNESS} roundCaps rootColor="var(--pwa-neutral-active)"
            sections={[{ value: percent, color: item.status === "paused" ? "var(--pwa-running)" : "var(--pwa-accent)" }]}
            label={<span className="pwa-attachment-tile-percent">{percent}</span>}
            role="progressbar" aria-label={t.attachments.progress(item.fileName)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} />
        </span> : null}
        {item.status === "failed" && onRetry ? <span className="pwa-attachment-tile-overlay">
          <ActionIcon className="pwa-attachment-tile-retry" type="button" disabled={disabled} aria-label={t.attachments.retry(item.fileName)} onClick={() => onRetry(item.id)}><RefreshCw size={20} /></ActionIcon>
        </span> : null}
      </span>
      {onRemove ? <ActionIcon className="pwa-attachment-tile-remove" type="button" disabled={disabled} aria-label={removeLabel} onClick={() => onRemove(item.id)}>
        <span className="pwa-attachment-tile-badge"><X size={16} /></span>
      </ActionIcon> : null}
    </div>;
}

/**
 * 输入框卡片内的附件：72 方块单行横排，超出宽度横向滚动，不折叠；上传中的逐件取消始终可达。
 * 新方块淡入；单个方块离开时脱离布局、原位淡出，其余方块当场补位。附件行的出现与移除由包裹层过渡高度，
 * 移除最后一件时整行淡出、同时收拢。随消息提交的交接（本端发送过渡期间，附件改由气泡里的只读卡片呈现）
 * 直接移除，高度由发送过渡收回。
 */
export function ComposerAttachmentTiles({ items, onRemove, onRetry, disabled = false }: Props) {
  const { t } = useI18n();
  const slotRef = useRef<HTMLDivElement>(null);
  const tilesRef = useRef<HTMLElement>(null);
  const flip = useFlipLayout(tilesRef);
  const row = usePresence(items.length ? items : null, Object.is, { exit: "--pwa-duration-collapse-out", skipExit: () => hideDuringOwnSend(slotRef.current) });
  const leaving = useLeavingItems(items);
  const shown = row.rendered ?? [];
  if (!shown.length) return null;
  return <div ref={slotRef} className="pwa-composer-grow pwa-attachment-tiles-slot" {...presenceProps(row)}><section ref={tilesRef} className="pwa-attachment-tiles" aria-label={t.attachments.title} {...presenceProps(row)}>
    {flip}
    {withLeavingItems(shown, row.leaving ? [] : leaving).map(({ item, leaving: isLeaving }) =>
      <AttachmentTile key={item.id} item={item} onRemove={onRemove} onRetry={onRetry} disabled={disabled} leaving={isLeaving} />)}
  </section></div>;
}
