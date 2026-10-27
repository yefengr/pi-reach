import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionIcon, Progress } from "@mantine/core";
import { Download, Eye, FileText, Image as ImageIcon, RefreshCw, X } from "lucide-react";
import { FILE_AUTO_IMAGE_BYTES, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import type { FileSourceDescriptor } from "@/lib/pwa/file-source";
import { useI18n } from "@/lib/i18n";
import { fileSaveName } from "@/lib/pwa/file-preview";
import { usePublishedFilesView } from "./published-files-context";
import "./published-files.css";

const iconAction = (label: string) => ({ className: "pwa-published-icon-action", "aria-label": label, title: label });

export type PublishedFileRead = (file: FileSourceDescriptor, trigger: HTMLButtonElement) => void;
export const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
export const TEXT_MIME = /^(text\/|application\/(json|xml|javascript))/;

function useFileVisibility() {
  const root = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const nearObserver = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
    const visibleObserver = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    nearObserver.observe(element);
    visibleObserver.observe(element);
    return () => { nearObserver.disconnect(); visibleObserver.disconnect(); };
  }, []);
  return { root, near, visible };
}

export function PublishedFile({ file, live, onRead, timelineKey }: { file: PublishedFileDescriptor; live: boolean; onRead: PublishedFileRead; timelineKey?: string }) {
  const { t, format } = useI18n();
  const files = usePublishedFilesView();
  const scope = files?.scopeToken;
  const state = live ? files?.getState(file.publication_id) : undefined;
  const { root, near, visible } = useFileVisibility();
  const attempted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const [failure, setFailure] = useState(false);
  const [decodeFailure, setDecodeFailure] = useState<string | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [source, setSource] = useState({ id: file.publication_id, scope, live });
  if (source.id !== file.publication_id || source.scope !== scope || source.live !== live) {
    setSource({ id: file.publication_id, scope, live });
    setFailure(false);
    setDecodeFailure(null);
    setAcquiring(false);
  }
  const name = state?.fileName ?? file.file_name;
  const size = state?.byteLength ?? file.byte_length;
  const sizeUnit = size < 1024 ? "B" : size < 1024 * 1024 ? "KiB" : "MiB";
  const displaySize = size < 1024 ? size : Math.round(size / (sizeUnit === "KiB" ? 1024 : 1024 * 1024) * 10) / 10;
  const mime = state?.mimeType ?? file.mime_type;
  const image = state?.preview ? state.preview.kind === "image" : IMAGE_MIME.test(mime);
  const text = state?.preview ? state.preview.kind === "text" : TEXT_MIME.test(mime);
  const ready = state?.phase === "ready";
  const fetching = acquiring || state?.phase === "opening" || state?.phase === "reading";
  const canFetch = live && files?.canFetch === true;
  const failed = failure || state?.phase === "error" || (state?.url !== undefined && decodeFailure === state.url);
  const pin = files?.pin;
  const unpin = files?.unpin;

  useLayoutEffect(() => {
    attempted.current = false;
    pending.current = false;
    generation.current += 1;
    return () => { pending.current = false; generation.current += 1; };
  }, [file.publication_id, scope, live]);
  useEffect(() => {
    if (!visible || !ready || !pin || !unpin) return;
    pin(file.publication_id);
    return () => unpin(file.publication_id);
  }, [visible, ready, pin, unpin, file.publication_id]);
  useEffect(() => {
    if (!near || !canFetch || !files || files.active || attempted.current || state && state.phase !== "idle" || !image) return;
    // open(auto) 只依据服务器的当前 preview/大小决定是否拉片，发布时信息不是授权。
    attempted.current = true;
    const request = generation.current;
    void Promise.resolve().then(() => {
      if (request !== generation.current || files.scopeToken !== scope) return;
      if (files.active) { attempted.current = false; return; }
      return files.open(file, "auto");
    }).catch(() => { if (request === generation.current && files.scopeToken === scope) setFailure(true); });
  }, [near, canFetch, files, file, state, image, scope]);

  const acquire = async (intent: "view" | "download", trigger?: HTMLButtonElement) => {
    if (!files || !live || pending.current || fetching) return;
    const fetchNow = !ready || intent === "download" || failed;
    if (fetchNow && (!canFetch || files.active)) return;
    pending.current = true;
    attempted.current = true;
    const request = ++generation.current;
    const current = () => request === generation.current && files.scopeToken === scope && root.current?.isConnected;
    setAcquiring(true);
    setFailure(false);
    setDecodeFailure(null);
    try {
      if (fetchNow) {
        if (failed && ready && files.retry) await files.retry(file, intent);
        else await files.open(file, intent);
      }
      if (!current() || intent !== "view" || !trigger?.isConnected || !root.current?.contains(trigger)) return;
      const result = files.getState(file.publication_id);
      // 不等待演示性完成态；真实内容就绪即交给阅读器原有的挂载与打开流程。
      const readable = result?.phase === "ready" && (result.preview?.kind === "image" ? !!result.url : result.preview?.kind === "text" && result.text !== undefined);
      if (readable) onRead(file, trigger);
    } catch { if (current()) setFailure(true); }
    finally {
      if (current()) { pending.current = false; setAcquiring(false); }
    }
  };
  const cancel = () => {
    generation.current += 1;
    pending.current = false;
    attempted.current = true;
    setAcquiring(false);
    try { files?.cancel(); } catch { setFailure(true); }
  };
  const errorText = state?.error === "too_large" ? t.files.tooLarge : state?.error === "not_available" || state?.error === "permission_denied" ? t.files.unavailable : decodeFailure === state?.url && decodeFailure !== null ? t.files.decodeError : t.files.failed;
  const disabled = !canFetch || files?.active === true;
  const viewLabel = failed ? t.common.retry : image && !ready ? t.files.fetchImage : t.files.view;
  const downloadRetry = failed && !image && !text;
  const slotError = failed && !(image && canFetch);
  const progress = size > 0 ? Math.min(100, Math.round((state?.receivedBytes ?? 0) / size * 100)) : 0;
  return <article ref={root} className={`pwa-published-file${image ? " is-image" : ""}`} data-publication-id={file.publication_id} data-viewport-row={timelineKey}>
    {ready && image && state?.url && !failed ? <button type="button" className="pwa-published-image" onClick={event => { if (!pending.current) onRead(file, event.currentTarget); }} aria-label={t.files.viewImage}>
      <img src={state.url} alt={name} onError={() => setDecodeFailure(state.url ?? null)} />
    </button> : image && canFetch && !fetching ? <div className="pwa-published-placeholder"><ImageIcon size={24} aria-hidden="true" /><span className={failed ? "pwa-published-error" : undefined}>{failed ? errorText : size > FILE_AUTO_IMAGE_BYTES ? t.files.largeImage : t.files.imagePending}</span></div> : null}
    <div className="pwa-published-row">
      {image ? <ImageIcon size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
      <div className="pwa-published-info"><div className="pwa-published-name" title={name}>{name}</div>
        {fetching ? <span className="pwa-published-meta pwa-published-progress"><Progress size="xs" value={progress} aria-label={t.files.fetching} /><span role="status">{`${t.files.fetchProgress} ${progress}%`}</span></span> : slotError ? <span className="pwa-published-error pwa-published-slot" role="alert" title={errorText}>{errorText}</span> : <span className="pwa-published-meta">{format.number(displaySize)} {sizeUnit}</span>}
        {fetching || failed ? null : !canFetch && !ready ? <span className="pwa-published-meta">{t.files.offline}</span> : null}
      </div>
      <div className="pwa-published-actions" data-previewable={image || text || undefined}>
        {fetching ? <ActionIcon {...iconAction(t.common.cancel)} onClick={cancel}><X size={20} aria-hidden="true" /></ActionIcon> : <>
          {(image || text) && (canFetch || ready) ? <ActionIcon {...iconAction(viewLabel)} disabled={!ready && disabled} onClick={event => { void acquire("view", event.currentTarget); }}>{failed ? <RefreshCw size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}</ActionIcon> : null}
          {ready && state?.url ? <ActionIcon {...iconAction(t.files.save)} component="a" href={state.url} download={fileSaveName(name)}><Download size={20} aria-hidden="true" /></ActionIcon> : canFetch ? <ActionIcon {...iconAction(downloadRetry ? t.common.retry : t.files.download)} disabled={disabled} onClick={() => { void acquire("download"); }}>{downloadRetry ? <RefreshCw size={20} aria-hidden="true" /> : <Download size={20} aria-hidden="true" />}</ActionIcon> : null}
        </>}
      </div>
    </div>
  </article>;
}
