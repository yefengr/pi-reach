import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ActionIcon, Button, Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft, Download, Minus, Plus, RotateCcw, X } from "lucide-react";
import type { PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { useI18n } from "@/lib/i18n";
import { FILE_TEXT_PREVIEW_BYTES, fileSaveName, textFilePreview } from "@/lib/pwa/file-preview";
import { FileTextContent } from "./file-text-content";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { usePublishedFilesView } from "./published-files-context";
import { IMAGE_RESET, imageGesture, zoomImage, type ImagePoint, type ImageTransform } from "./published-image-gesture";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, pwaFadeTransition, usePwaMotionDuration, useDrawerMoving } from "./use-pwa-motion";
import { publishedImageBounds, usePublishedImageMotion } from "./published-image-motion";
import { useReaderHistory } from "./use-reader-history";
import { ReaderShell } from "./reader-shell";
import "./published-files.css";

function PublishedImage({ url, name, onRetry, canRetry, source, surface, opened, instant, allowEnter, enterDuration, exitDuration }: {
  url: string; name: string; onRetry: () => void; canRetry: boolean; source?: HTMLButtonElement;
  surface: HTMLDivElement | null; opened: boolean; instant: boolean; allowEnter: boolean; enterDuration: number; exitDuration: number;
}) {
  const { t } = useI18n();
  const [transform, setTransform] = useState<ImageTransform>({ ...IMAGE_RESET });
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, ImagePoint>());
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  usePublishedImageMotion({ image, source, root: surface, url, opened, instant, zoomed: transform.scale !== 1 || transform.x !== 0 || transform.y !== 0, allowEnter, enterDuration, exitDuration });
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
    <div className="pwa-file-image-stage" data-swipe-ignore onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {failed ? <div role="alert"><p className="pwa-published-error">{t.files.decodeError}</p><Button variant="transparent" color="piReach" disabled={!canRetry} onClick={onRetry}>{t.common.retry}</Button></div> : <img ref={setImage} src={url} alt={name} draggable={false} onError={() => setFailed(true)} style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }} />}
    </div>
    <div className="pwa-file-zoom">
      <ActionIcon variant="subtle" aria-label={t.files.zoomOut} onClick={() => updateTransform(zoomImage(transformRef.current, transformRef.current.scale / 1.5))}><Minus size={20} /></ActionIcon>
      <Button variant="transparent" color="piReach" leftSection={<RotateCcw size={16} />} onClick={() => updateTransform({ ...IMAGE_RESET })} aria-label={t.files.resetZoom}>{Math.round(transform.scale * 100)}%</Button>
      <ActionIcon variant="subtle" aria-label={t.files.zoomIn} onClick={() => updateTransform(zoomImage(transformRef.current, transformRef.current.scale * 1.5))}><Plus size={20} /></ActionIcon>
    </div>
  </>;
}

/** 阅读器之上存在其他模态（确认框等）时，返回与关闭交给上层处理。 */
const hasOtherModal = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]:not(.pwa-file-reader)')].some(element => !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");

type PublishedFileReaderProps = { file: PublishedFileDescriptor; opened: boolean; onClose: () => void; onExitTransitionEnd: () => void; source?: HTMLButtonElement };

/** pin 由业务选择持有，布局迁移或 opened=false 不提前释放。 */
export function PublishedFileReader(props: PublishedFileReaderProps) {
  const files = usePublishedFilesView();
  const [image] = useState(() => files?.getState(props.file.publication_id)?.preview?.kind === "image");
  const pin = files?.pin;
  const unpin = files?.unpin;
  useEffect(() => { pin?.(props.file.publication_id); return () => unpin?.(props.file.publication_id); }, [pin, unpin, props.file.publication_id]);
  return image ? <PublishedModalFileReader {...props} /> : <PublishedTextReader {...props} />;
}

function PublishedTextReader({ file, opened, onClose, onExitTransitionEnd }: PublishedFileReaderProps) {
  const { t } = useI18n();
  const files = usePublishedFilesView();
  const state = files?.getState(file.publication_id);
  const name = state?.fileName ?? file.file_name;
  const [entered, setEntered] = useState(false);
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
  const text = state?.text;
  const size = state?.byteLength;
  const preview = useMemo(() => {
    if (!entered || text === undefined) return null;
    const bytes = new TextEncoder().encode(text.slice(0, FILE_TEXT_PREVIEW_BYTES + 1));
    const result = textFilePreview(bytes);
    return result && { ...result, truncated: result.truncated || (size ?? 0) > bytes.byteLength };
  }, [entered, text, size]);
  const mime = state?.mimeType ?? file.mime_type;
  const markdown = mime === "text/markdown" || mime === "text/plain" && /\.(md|markdown)$/i.test(name);
  useLayoutEffect(() => {
    if (!scroll) return;
    const measure = () => scroll.toggleAttribute("data-swipe-horizontal", scroll.scrollWidth > scroll.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, [scroll, preview]);
  return <ReaderShell workPanel opened={opened} onClose={onClose} onExitTransitionEnd={onExitTransitionEnd} onEnterTransitionEnd={() => setEntered(true)} title={name} closeLabel={t.files.closeReader} historyKey="piReachFileReader" className="pwa-file-reader" actions={state?.phase === "ready" && state.url ? <ActionIcon component="a" className="pwa-icon-button" href={state.url} download={fileSaveName(name)} aria-label={t.files.save} title={t.files.save}><Download size={20} aria-hidden="true" /></ActionIcon> : null}>
    {!entered && text !== undefined ? <div className="pwa-file-reader-scroll" aria-busy="true" /> : preview ? <div ref={setScroll} className="pwa-file-reader-scroll"><FileTextContent text={preview.text} markdown={markdown} />{preview.truncated ? <p className="pwa-published-meta" role="status">{t.files.truncated}</p> : null}</div> : <p className="pwa-published-meta">{t.files.noPreview}</p>}
  </ReaderShell>;
}

/** 图片保留阶段 C 的模态几何、history 与跟手生命周期。 */
function PublishedModalFileReader({ file, opened, onClose, onExitTransitionEnd, source }: PublishedFileReaderProps) {
  const { t } = useI18n();
  const files = usePublishedFilesView();
  const state = files?.getState(file.publication_id);
  const name = state?.fileName ?? file.file_name;
  const headingId = useId();
  const mobile = useMediaQuery("(max-width: 767.98px)") ?? false;
  const drawerDuration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const fadeDuration = usePwaMotionDuration("--pwa-duration-fade", 120);
  const imageIn = usePwaMotionDuration("--pwa-duration-image-in", 260);
  const imageOut = usePwaMotionDuration("--pwa-duration-image-out", 220);
  const [imageReader] = useState(() => state?.preview?.kind === "image");
  // 仅点击时已解码的来源可参与开场；迟到解码不补播放大。
  const [allowImageEnter] = useState(() => !!source && publishedImageBounds(source.querySelector("img")) !== null);
  const { instant, skipExit, resetSkipExit } = useReaderHistory({
    opened,
    stateKey: "piReachFileReader",
    marker: `${file.publication_id}:${headingId}`,
    onClose,
    ignorePop: hasOtherModal,
  });
  // 长文本解析与排版是同步长任务，放在进入动画结束后，避免推迟面板滑入的起点。
  const [entered, setEntered] = useState(false);
  const motion = useDrawerMoving(opened);
  const previewKind = state?.preview?.kind;
  const previewText = state?.text;
  const previewSize = state?.byteLength;
  const textPending = !entered && previewKind === "text" && previewText !== undefined;
  const preview = useMemo(() => {
    if (!entered || previewKind !== "text" || previewText === undefined) return null;
    // 门面 text 仍按 UTF-8/DOM 双重预算处理，完整原件始终由 Blob URL 保存。
    const bytes = new TextEncoder().encode(previewText.slice(0, FILE_TEXT_PREVIEW_BYTES + 1));
    const result = textFilePreview(bytes);
    return result && { ...result, truncated: result.truncated || (previewSize ?? 0) > bytes.byteLength };
  }, [entered, previewKind, previewText, previewSize]);
  const mime = state?.mimeType ?? file.mime_type;
  const markdown = mime === "text/markdown" || mime === "text/plain" && /\.(md|markdown)$/i.test(name);
  const requestClose = () => {
    if (hasOtherModal()) return;
    onClose();
  };
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened, direction: 1, requestClose, skipExit, resetSkipExit });
  useSwipe(surface, { direction: "right", enabled: opened && mobile, onSwipe: requestClose, canSwipe, drag });
  useLayoutEffect(() => {
    if (!scroll) return;
    // 文件 Markdown 的原始围栏代码可能使正文自身横溢，不改变呈现来适配手势。
    const measure = () => scroll.toggleAttribute("data-swipe-horizontal", scroll.scrollWidth > scroll.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, [scroll, preview, mobile]);
  return <Drawer.Root opened={opened} onClose={requestClose} onEnterTransitionEnd={() => { setEntered(true); motion.onEnterTransitionEnd(); }} onExitTransitionEnd={onExitTransitionEnd} position="right" size={mobile ? "100%" : "var(--pwa-reader-drawer-width)"} withinPortal portalProps={{ target: ".pwa-root" }} zIndex={30} trapFocus returnFocus={false} transitionProps={{ transition: imageReader ? pwaFadeTransition : pwaDrawerTransitions.right, duration: imageReader ? allowImageEnter ? imageIn : fadeDuration : drawerDuration, exitDuration: instant ? 0 : imageReader ? imageOut : drawerDuration, timingFunction: PWA_DRAWER_EASE }}>
    <Drawer.Overlay className="pwa-scrim pwa-file-reader-overlay" data-image-reader={imageReader || undefined} />
    <Drawer.Content ref={setSurface} classNames={{ content: "pwa-file-reader" }} data-pwa-moving={motion.moving || undefined} data-image-reader={imageReader || undefined} data-publication-id={file.publication_id}>
      <Drawer.Header className="pwa-topbar pwa-file-reader-header">
        {/* 移动全屏与设置页同为左侧返回；桌面右侧 Drawer 保留右上角关闭。 */}
        {mobile ? <Drawer.CloseButton className="pwa-icon-button pwa-topbar-back" aria-label={t.files.closeReader} icon={<ArrowLeft size={20} />} /> : null}
        <Drawer.Title tabIndex={-1} data-autofocus title={name}>{name}</Drawer.Title>
        {state?.phase === "ready" && state.url ? <ActionIcon component="a" className="pwa-icon-button" href={state.url} download={fileSaveName(name)} aria-label={t.files.save} title={t.files.save}><Download size={20} aria-hidden="true" /></ActionIcon> : null}
        {mobile ? null : <Drawer.CloseButton className="pwa-icon-button" aria-label={t.files.closeReader} icon={<X size={20} />} />}
      </Drawer.Header>
      <Drawer.Body className="pwa-file-reader-body">
        {state?.phase === "ready" && state.preview?.kind === "image" && state.url ? <PublishedImage key={state.url} url={state.url} name={name} source={source} surface={surface} opened={opened} instant={instant} allowEnter={allowImageEnter && !entered} enterDuration={imageIn} exitDuration={imageOut} canRetry={files?.canFetch === true} onRetry={() => { void Promise.resolve().then(() => files?.retry?.(file, "view") ?? files?.open(file, "view")).catch(() => undefined); }} /> : textPending ? <div className="pwa-file-reader-scroll" aria-busy="true" /> : preview ? <div ref={setScroll} className="pwa-file-reader-scroll"><FileTextContent text={preview.text} markdown={markdown} />{preview.truncated ? <p className="pwa-published-meta" role="status">{t.files.truncated}</p> : null}</div> : state?.phase === "opening" || state?.phase === "reading" ? <p className="pwa-published-meta" role="status">{t.files.fetching}</p> : <p className="pwa-published-meta">{t.files.noPreview}</p>}
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
