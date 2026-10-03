import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ActionIcon, Button, Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import type { PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import { FILE_TEXT_PREVIEW_BYTES, fileSaveName, textFilePreview } from "@/lib/pwa/file-preview";
import { FileTextContent } from "./file-text-content";
import { usePublishedFilesView } from "./published-files-context";
import { IMAGE_RESET, imageGesture, zoomImage, type ImagePoint, type ImageTransform } from "./published-image-gesture";
import { pwaDrawerTransitions, pwaOverlayEase, usePwaMotionDuration } from "./use-pwa-motion";
import "./published-files.css";

function PublishedImage({ url, name, onRetry, canRetry }: { url: string; name: string; onRetry: () => void; canRetry: boolean }) {
  const { t } = useI18n();
  const [transform, setTransform] = useState<ImageTransform>({ ...IMAGE_RESET });
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, ImagePoint>());
  const transformRef = useRef(transform);
  const updateTransform = (value: ImageTransform) => { transformRef.current = value; setTransform(value); };
  const gesture = useRef<{ transform: ImageTransform; points: ImagePoint[] }>({ transform, points: [] });
  const rebase = () => { gesture.current = { transform: transformRef.current, points: [...pointers.current.values()] }; };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    rebase();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    updateTransform(imageGesture(gesture.current.transform, gesture.current.points, [...pointers.current.values()]));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => { pointers.current.delete(event.pointerId); rebase(); };
  return <>
    <div className="pwa-file-image-stage" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {failed ? <div role="alert"><p>{t.files.decodeError}</p><Button variant="subtle" disabled={!canRetry} onClick={onRetry}>{t.common.retry}</Button></div> : <img src={url} alt={name} draggable={false} onError={() => setFailed(true)} style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }} />}
    </div>
    <div className="pwa-file-zoom">
      <ActionIcon variant="subtle" aria-label={t.files.zoomOut} onClick={() => updateTransform(zoomImage(transformRef.current, transformRef.current.scale / 1.5))}><Minus size={20} /></ActionIcon>
      <Button variant="subtle" leftSection={<RotateCcw size={16} />} onClick={() => updateTransform({ ...IMAGE_RESET })} aria-label={t.files.resetZoom}>{Math.round(transform.scale * 100)}%</Button>
      <ActionIcon variant="subtle" aria-label={t.files.zoomIn} onClick={() => updateTransform(zoomImage(transformRef.current, transformRef.current.scale * 1.5))}><Plus size={20} /></ActionIcon>
    </div>
  </>;
}

/** file 保留至退出结束，pin 不随 opened=false 提前释放。 */
export function PublishedFileReader({ file, opened, onClose, onExitTransitionEnd }: { file: PublishedFileDescriptor; opened: boolean; onClose: () => void; onExitTransitionEnd: () => void }) {
  const { t } = useI18n();
  const files = usePublishedFilesView();
  const state = files?.getState(file.publication_id);
  const name = state?.fileName ?? file.file_name;
  const headingId = useId();
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const pin = files?.pin;
  const unpin = files?.unpin;
  const mobile = useMediaQuery("(max-width: 767.98px)") ?? false;
  const duration = usePwaMotionDuration("--pwa-duration-reader-in", 240);
  const exitDuration = usePwaMotionDuration("--pwa-duration-reader-out", 200);
  useEffect(() => {
    pin?.(file.publication_id);
    return () => unpin?.(file.publication_id);
  }, [pin, unpin, file.publication_id]);
  useEffect(() => {
    if (!opened) return;
    let pushed = false;
    let byHistory = false;
    const marker = `${file.publication_id}:${headingId}`;
    const timer = window.setTimeout(() => {
      window.history.pushState({ ...(window.history.state ?? {}), piReachFileReader: marker }, "");
      pushed = true;
    }, 0);
    const pop = () => {
      if (!pushed || document.querySelector('[role="dialog"][aria-modal="true"]:not(.pwa-file-reader)')) return;
      byHistory = true;
      close.current();
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", pop);
      if (pushed && !byHistory && window.history.state?.piReachFileReader === marker) window.history.back();
    };
  }, [opened, file.publication_id, headingId]);
  const previewKind = state?.preview?.kind;
  const previewText = state?.text;
  const previewSize = state?.byteLength;
  const preview = useMemo(() => {
    if (previewKind !== "text" || previewText === undefined) return null;
    // 门面 text 仍按 UTF-8/DOM 双重预算处理，完整原件始终由 Blob URL 保存。
    const bytes = new TextEncoder().encode(previewText.slice(0, FILE_TEXT_PREVIEW_BYTES + 1));
    const result = textFilePreview(bytes);
    return result && { ...result, truncated: result.truncated || (previewSize ?? 0) > bytes.byteLength };
  }, [previewKind, previewText, previewSize]);
  const mime = state?.mimeType ?? file.mime_type;
  const markdown = mime === "text/markdown" || mime === "text/plain" && /\.(md|markdown)$/i.test(name);
  const requestClose = () => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]:not(.pwa-file-reader)')) return;
    onClose();
  };
  return <Drawer.Root opened={opened} onClose={requestClose} onExitTransitionEnd={onExitTransitionEnd} position="right" size={mobile ? "100%" : 720} withinPortal portalProps={{ target: ".pwa-root" }} zIndex={30} trapFocus returnFocus={false} transitionProps={{ transition: pwaDrawerTransitions.right, duration, exitDuration, timingFunction: "var(--pwa-overlay-ease)" }} style={pwaOverlayEase(opened)}>
    <Drawer.Overlay className="pwa-scrim" />
    <Drawer.Content classNames={{ content: "pwa-file-reader" }}>
      <Drawer.Header className="pwa-file-reader-header">
        <Drawer.Title tabIndex={-1} data-autofocus title={name}>{name}</Drawer.Title>
        {state?.phase === "ready" && state.url ? <Button component="a" variant="subtle" href={state.url} download={fileSaveName(name)}>{t.files.save}</Button> : null}
        <Drawer.CloseButton className="pwa-icon-button" aria-label={t.files.closeReader} icon={<X size={20} />} />
      </Drawer.Header>
      <Drawer.Body className="pwa-file-reader-body">
        {state?.phase === "ready" && state.preview?.kind === "image" && state.url ? <PublishedImage key={state.url} url={state.url} name={name} canRetry={files?.canFetch === true} onRetry={() => { void Promise.resolve().then(() => files?.retry?.(file, "view") ?? files?.open(file, "view")).catch(() => undefined); }} /> : preview ? <div className="pwa-file-reader-scroll"><FileTextContent text={preview.text} markdown={markdown} />{preview.truncated ? <p className="pwa-published-meta" role="status">{t.files.truncated}</p> : null}</div> : state?.phase === "opening" || state?.phase === "reading" ? <p className="pwa-published-meta" role="status">{t.files.fetching}</p> : <p className="pwa-published-meta">{t.files.noPreview}</p>}
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
