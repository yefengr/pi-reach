import { useEffect, useRef, useState } from "react";
import { ActionIcon, Progress } from "@mantine/core";
import { Download, Eye, FileText, Image as ImageIcon, RotateCw, X } from "lucide-react";
import { FILE_AUTO_IMAGE_BYTES, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import { fileSaveName } from "@/lib/pwa/file-preview";
import { usePublishedFilesView } from "./published-files-context";
import { usePwaMotionDuration } from "./use-pwa-motion";
import "./published-files.css";

const iconAction = (label: string) => ({ className: "pwa-published-icon-action", "aria-label": label, title: label });

export type PublishedFileRead = (file: PublishedFileDescriptor, trigger: HTMLButtonElement) => void;
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript))/;

export function PublishedFile({ file, live, onRead }: { file: PublishedFileDescriptor; live: boolean; onRead: PublishedFileRead }) {
  const { t, format } = useI18n();
  const files = usePublishedFilesView();
  const state = live ? files?.getState(file.publication_id) : undefined;
  const root = useRef<HTMLElement>(null);
  const attempted = useRef(false);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  const [failure, setFailure] = useState(false);
  const [decodeFailure, setDecodeFailure] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<number | undefined>(undefined);
  const settleDuration = usePwaMotionDuration("--pwa-duration-fetch-settle", 600);
  const name = state?.fileName ?? file.file_name;
  const size = state?.byteLength ?? file.byte_length;
  const sizeUnit = size < 1024 ? "B" : size < 1024 * 1024 ? "KiB" : "MiB";
  const displaySize = size < 1024 ? size : Math.round(size / (sizeUnit === "KiB" ? 1024 : 1024 * 1024) * 10) / 10;
  const mime = state?.mimeType ?? file.mime_type;
  const image = state?.preview ? state.preview.kind === "image" : IMAGE_MIME.test(mime);
  const text = state?.preview ? state.preview.kind === "text" : TEXT_MIME.test(mime);
  const ready = state?.phase === "ready";
  const fetching = state?.phase === "opening" || state?.phase === "reading";
  const canFetch = live && files?.canFetch === true;
  const failed = failure || state?.phase === "error" || (state?.url !== undefined && decodeFailure === state.url);
  const pin = files?.pin;
  const unpin = files?.unpin;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const nearObserver = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
    const visibleObserver = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    nearObserver.observe(element);
    visibleObserver.observe(element);
    return () => { nearObserver.disconnect(); visibleObserver.disconnect(); };
  }, []);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  useEffect(() => {
    if (!visible || !ready || !pin || !unpin) return;
    pin(file.publication_id);
    return () => unpin(file.publication_id);
  }, [visible, ready, pin, unpin, file.publication_id]);
  useEffect(() => {
    if (!near || !canFetch || !files || files.active || attempted.current || state && state.phase !== "idle") return;
    if (!image) return;
    // open(auto) 只依据服务器的当前 preview/大小决定是否拉片，发布时信息不是授权。
    attempted.current = true;
    void Promise.resolve().then(() => {
      // 同一轮 effect 的其他图片可能先开始获取；保留未开始图片的自动机会。
      if (files.active) { attempted.current = false; return; }
      return files.open(file, "auto");
    }).catch(() => setFailure(true));
  }, [near, canFetch, files, file, state, image]);

  const acquire = async (intent: "view" | "download", trigger?: HTMLButtonElement) => {
    if (!files) return;
    attempted.current = true;
    setFailure(false);
    setDecodeFailure(null);
    try {
      const fetchNow = !ready || intent === "download" || failed;
      if (fetchNow) {
        if (!canFetch && !ready) return;
        if (failed && ready && files.retry) await files.retry(file, intent);
        else await files.open(file, intent);
      }
      const readable = () => {
        const result = files.getState(file.publication_id);
        return result?.phase === "ready" && result.preview?.kind !== "none";
      };
      if (intent !== "view" || !trigger || !readable()) return;
      if (fetchNow) {
        // 刚获取完时最后一段进度来不及绘制就会被阅读器盖住；先补满进度并停留片刻，再交给阅读器。
        setSettling(true);
        await new Promise<void>(resolve => { settleTimer.current = window.setTimeout(resolve, settleDuration); });
        setSettling(false);
        // 停留期间可能被取消、逐出或切换目标。
        if (!readable()) return;
      }
      onRead(file, trigger);
    } catch { setFailure(true); }
  };
  const cancel = () => {
    attempted.current = true;
    try { files?.cancel(); } catch { setFailure(true); }
  };
  const errorText = state?.error === "too_large" ? t.files.tooLarge : state?.error === "not_available" || state?.error === "permission_denied" ? t.files.unavailable : decodeFailure === state?.url && decodeFailure !== null ? t.files.decodeError : t.files.failed;
  const disabled = !canFetch || files?.active === true;
  // 操作只显示图标，名称交给 aria-label 与 title；同一位置始终是图标按钮（44 点击区、36 圆形反馈），状态切换时保留焦点。
  const viewLabel = failed ? t.common.retry : image && !ready ? t.files.fetchImage : t.files.view;
  const downloadRetry = failed && !image && !text;
  // 图片占位区已显示错误时，状态行保留大小，避免重复提示。
  const slotError = failed && !(image && canFetch);
  const progress = settling && ready ? 100 : size > 0 ? Math.min(100, Math.round((state?.receivedBytes ?? 0) / size * 100)) : 0;
  return <article ref={root} className={`pwa-published-file${image ? " is-image" : ""}`} data-publication-id={file.publication_id}>
    {ready && image && state?.url && !failed ? <button type="button" className="pwa-published-image" onClick={event => onRead(file, event.currentTarget)} aria-label={t.files.viewImage}>
      <img src={state.url} alt={name} onError={() => setDecodeFailure(state.url ?? null)} />
    </button> : image && canFetch && !fetching ? <div className="pwa-published-placeholder"><ImageIcon size={24} aria-hidden="true" /><span className={failed ? "pwa-published-error" : undefined}>{failed ? errorText : size > FILE_AUTO_IMAGE_BYTES ? t.files.largeImage : t.files.imagePending}</span></div> : null}
    <div className="pwa-published-row">
      {image ? <ImageIcon size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
      <div className="pwa-published-info"><div className="pwa-published-name" title={name}>{name}</div>
        {/* 进度与错误原地替换大小行，状态变化时卡片高度不变，消息列表不跳动。 */}
        {fetching || settling && ready ? <span className="pwa-published-meta pwa-published-progress"><Progress size="xs" value={progress} aria-label={fetching ? t.files.fetching : t.files.fetched} /><span role="status">{fetching ? `${t.files.fetchProgress} ${progress}%` : t.files.fetched}</span></span> : slotError ? <span className="pwa-published-error pwa-published-slot" role="alert" title={errorText}>{errorText}</span> : <span className="pwa-published-meta">{format.number(displaySize)} {sizeUnit}</span>}
        {fetching || settling && ready || failed ? null : !canFetch && !ready ? <span className="pwa-published-meta">{t.files.offline}</span> : null}
      </div>
      <div className="pwa-published-actions">
        {fetching ? <ActionIcon {...iconAction(t.common.cancel)} onClick={cancel}><X size={20} aria-hidden="true" /></ActionIcon> : <>
          {(image || text) && (canFetch || ready) ? <ActionIcon {...iconAction(viewLabel)} disabled={!ready && disabled} onClick={event => { void acquire("view", event.currentTarget); }}>{failed ? <RotateCw size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}</ActionIcon> : null}
          {ready && state?.url ? <ActionIcon {...iconAction(t.files.save)} component="a" href={state.url} download={fileSaveName(name)}><Download size={20} aria-hidden="true" /></ActionIcon> : canFetch ? <ActionIcon {...iconAction(downloadRetry ? t.common.retry : t.files.download)} disabled={disabled} onClick={() => { void acquire("download"); }}>{downloadRetry ? <RotateCw size={20} aria-hidden="true" /> : <Download size={20} aria-hidden="true" />}</ActionIcon> : null}
        </>}
      </div>
    </div>
  </article>;
}
