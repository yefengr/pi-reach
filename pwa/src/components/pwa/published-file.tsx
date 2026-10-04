import { useEffect, useRef, useState } from "react";
import { Button, Progress } from "@mantine/core";
import { FileText, Image as ImageIcon } from "lucide-react";
import { FILE_AUTO_IMAGE_BYTES, type PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import { fileSaveName } from "@/lib/pwa/file-preview";
import { usePublishedFilesView } from "./published-files-context";
import "./published-files.css";

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
      if (!ready || intent === "download" || failed) {
        if (!canFetch && !ready) return;
        if (failed && ready && files.retry) await files.retry(file, intent);
        else await files.open(file, intent);
      }
      const result = files.getState(file.publication_id);
      if (intent === "view" && trigger && result?.phase === "ready" && result.preview?.kind !== "none") onRead(file, trigger);
    } catch { setFailure(true); }
  };
  const cancel = () => {
    attempted.current = true;
    try { files?.cancel(); } catch { setFailure(true); }
  };
  const errorText = state?.error === "too_large" ? t.files.tooLarge : state?.error === "not_available" || state?.error === "permission_denied" ? t.files.unavailable : decodeFailure === state?.url && decodeFailure !== null ? t.files.decodeError : t.files.failed;
  const disabled = !canFetch || files?.active === true;
  const progress = size > 0 ? Math.min(100, Math.round((state?.receivedBytes ?? 0) / size * 100)) : 0;
  return <article ref={root} className={`pwa-published-file${image ? " is-image" : ""}`} data-publication-id={file.publication_id}>
    {ready && image && state?.url && !failed ? <button type="button" className="pwa-published-image" onClick={event => onRead(file, event.currentTarget)} aria-label={t.files.viewImage}>
      <img src={state.url} alt={name} onError={() => setDecodeFailure(state.url ?? null)} />
    </button> : image && canFetch && !fetching ? <div className="pwa-published-placeholder"><ImageIcon size={24} aria-hidden="true" /><span>{failed ? errorText : size > FILE_AUTO_IMAGE_BYTES ? t.files.largeImage : t.files.imagePending}</span></div> : null}
    <div className="pwa-published-row">
      {image ? <ImageIcon size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
      <div className="pwa-published-info"><div className="pwa-published-name" title={name}>{name}</div><span className="pwa-published-meta">{format.number(displaySize)} {sizeUnit}</span>
        {fetching ? <><Progress value={progress} aria-label={t.files.fetching} /><span className="pwa-published-meta" role="status">{t.files.fetching} {progress}%</span></> : failed ? <span className="pwa-published-error" role="alert">{errorText}</span> : !canFetch && !ready ? <span className="pwa-published-meta">{t.files.offline}</span> : null}
      </div>
      <div className="pwa-published-actions">
        {fetching ? <Button variant="subtle" onClick={cancel}>{t.common.cancel}</Button> : <>
          {(image || text) && (canFetch || ready) ? <Button variant="subtle" disabled={!ready && disabled} onClick={event => { void acquire("view", event.currentTarget); }}>{failed ? t.common.retry : image && !ready ? t.files.fetchImage : t.files.view}</Button> : null}
          {ready && state?.url ? <Button component="a" variant="subtle" href={state.url} download={fileSaveName(name)}>{t.files.save}</Button> : canFetch ? <Button variant="subtle" disabled={disabled} onClick={() => { void acquire("download"); }}>{failed && !image && !text ? t.common.retry : t.files.download}</Button> : null}
        </>}
      </div>
    </div>
  </article>;
}
