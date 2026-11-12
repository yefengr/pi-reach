import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ActionIcon, Button, Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft, Download, Minus, Plus, RotateCcw, X } from "lucide-react";
import { fileKey, isAttachmentFile, type FileSourceDescriptor } from "@/lib/pwa/file-source";
import { useI18n } from "@/lib/i18n";
import { FILE_TEXT_PREVIEW_BYTES, fileSaveName, textFilePreview } from "@/lib/pwa/file-preview";
import { FileTextContent } from "./file-text-content";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { usePublishedFilesView } from "./published-files-context";
import { doubleTapImage, IMAGE_DOUBLE_TAP_MS, IMAGE_DOUBLE_TAP_RADIUS_PX, IMAGE_MAX_ZOOM, IMAGE_PULL_DISMISS_PX, IMAGE_RESET, IMAGE_TAP_SLOP_PX, imageGesture, pullScale, zoomImage, type ImagePoint, type ImageTransform } from "./published-image-gesture";
import { beginSwipe, finishSwipe, IDLE_SWIPE, moveSwipe, projectedStop, trackedDistance, type SwipeState } from "./swipe-gesture";
import { PWA_DRAWER_EASE, pwaContentEasing, pwaDrawerTransitions, pwaFadeTransition, pwaMotionShiftDisabled, usePwaMotionDuration, useDrawerMoving } from "./use-pwa-motion";
import { publishedImageBounds, usePublishedImageMotion } from "./published-image-motion";
import { useReaderHistory } from "./use-reader-history";
import { ReaderShell } from "./reader-shell";
import "./published-files.css";
import { MOBILE_LAYOUT_QUERY } from "@/lib/ui/viewport-queries";

const swipePoint = (event: PointerEvent<HTMLDivElement>) => ({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp });
const imageTransform = (value: ImageTransform) => `translate(${value.x}px, ${value.y}px) scale(${value.scale})`;
// 手动缩放仍用 transform；反向补偿圆角，避免屏幕半径随图片放大。
const imageRadiusFor = (scale: number) => `calc(var(--pwa-radius-md) / ${scale})`;

function PublishedImage({ url, name, onRetry, canRetry, source, surface, opened, instant, allowEnter, enterDuration, exitDuration, onDismiss }: {
  url: string; name: string; onRetry: () => void; canRetry: boolean; source?: HTMLButtonElement;
  surface: HTMLDivElement | null; opened: boolean; instant: boolean; allowEnter: boolean; enterDuration: number; exitDuration: number;
  /** 下拉关闭：与关闭按钮同一入口，可能被上层门禁拒绝。 */
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [transform, setTransform] = useState<ImageTransform>({ ...IMAGE_RESET });
  // 未缩放时下拉的位移；与缩放平移分开保存，关闭时图片从下拉后的位置回到来源缩略图。
  const [pull, setPull] = useState(0);
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, ImagePoint>());
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  usePublishedImageMotion({ image, source, root: surface, url, opened, instant, zoomed: transform.scale !== 1 || transform.x !== 0 || transform.y !== 0, allowEnter, enterDuration, exitDuration });
  const transformRef = useRef(transform);
  const updateTransform = (value: ImageTransform) => { transformRef.current = value; setTransform(value); };
  const zoomDuration = usePwaMotionDuration("--pwa-duration-image-zoom");
  const overscrollDuration = usePwaMotionDuration("--pwa-duration-overscroll");
  const zoomAnimationRef = useRef<Animation | null>(null);
  // 双击、按钮与越界弹回的缩放过渡中开始新的缩放或拖动：以此刻的绘制位置为新起点，不跳到上一次的终点。
  // 单纯的轻点不打断过渡。
  const freezeZoom = () => {
    const running = zoomAnimationRef.current;
    zoomAnimationRef.current = null;
    if (!running || running.playState !== "running" || !image) return;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(image).transform);
    running.cancel();
    updateTransform({ scale: matrix.a, x: matrix.e, y: matrix.f });
  };
  const glideTo = (next: ImageTransform, duration: number) => {
    freezeZoom();
    const from = transformRef.current;
    updateTransform(next);
    if (!image || typeof image.animate !== "function" || pwaMotionShiftDisabled(image)) return;
    const frame = (value: ImageTransform) => ({ transform: imageTransform(value), borderRadius: imageRadiusFor(value.scale) });
    zoomAnimationRef.current = image.animate([frame(from), frame(next)], { duration, easing: pwaContentEasing(image) });
  };
  const gesture = useRef<{ transform: ImageTransform; points: ImagePoint[] }>({ transform, points: [] });
  const rebase = () => { gesture.current = { transform: transformRef.current, points: [...pointers.current.values()] }; };
  const pullRef = useRef<{ state: SwipeState; follow: boolean; distance: number }>({ state: IDLE_SWIPE, follow: false, distance: 0 });
  const tapRef = useRef<{ down: (ImagePoint & { time: number; id: number }) | null; last: (ImagePoint & { time: number }) | null }>({ down: null, last: null });
  const openedRef = useRef(opened);
  useLayoutEffect(() => { openedRef.current = opened; }, [opened]);
  const stageHeight = () => image?.parentElement?.clientHeight ?? 0;
  const settlePull = (from: number) => {
    pullRef.current = { state: IDLE_SWIPE, follow: false, distance: 0 };
    setPull(0);
    if (from > 0 && image) image.animate([{ translate: `0 ${from}px`, scale: pullScale(from, stageHeight()) }, { translate: "0 0", scale: 1 }], { duration: exitDuration, easing: pwaContentEasing(image) });
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size > 1) freezeZoom();
    rebase();
    const single = pointers.current.size === 1;
    tapRef.current.down = single ? { x: event.clientX, y: event.clientY, time: event.timeStamp, id: event.pointerId } : null;
    const current = transformRef.current;
    if (single && current.scale === 1 && current.x === 0 && current.y === 0 && !failed) {
      pullRef.current = { state: beginSwipe(IDLE_SWIPE, swipePoint(event), "down", event.pointerType, event.isPrimary), follow: false, distance: 0 };
    } else if (pullRef.current.state.phase !== "idle") settlePull(pullRef.current.distance);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = pullRef.current;
    if (active.state.phase !== "idle") {
      const before = active.state.phase;
      const point = swipePoint(event);
      active.state = moveSwipe(active.state, point);
      // 减少动态效果时图片不跟手，只在松手时判定。
      if (before === "pending" && active.state.phase === "tracking") active.follow = !!image && !pwaMotionShiftDisabled(image);
      if (active.state.phase === "tracking") {
        active.distance = trackedDistance(active.state, point);
        if (active.follow) setPull(active.distance);
        return;
      }
    }
    if (zoomAnimationRef.current?.playState === "running") {
      // 过渡中开始拖动：先停在当前绘制位置，从这一帧起跟手。
      freezeZoom();
      rebase();
      return;
    }
    updateTransform(imageGesture(gesture.current.transform, gesture.current.points, [...pointers.current.values()]));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const tracked = pointers.current.delete(event.pointerId);
    // 捏合缩到原始大小以下或放大到上限以上：少于两指即弹回边界。
    const pinched = transformRef.current;
    if (tracked && pointers.current.size < 2 && pinched.scale < 1) glideTo({ ...IMAGE_RESET }, overscrollDuration);
    else if (tracked && pointers.current.size < 2 && pinched.scale > IMAGE_MAX_ZOOM) glideTo({ ...pinched, scale: IMAGE_MAX_ZOOM }, overscrollDuration);
    rebase();
    const released = tracked && event.type === "pointerup";
    const active = pullRef.current;
    if (active.state.phase !== "idle" && active.state.pointerId === event.pointerId) {
      const tracking = active.state.phase === "tracking";
      const result = finishSwipe(active.state, swipePoint(event));
      const followed = active.follow ? result.distance : 0;
      if (released && tracking && projectedStop(result.distance, result.velocity) >= IMAGE_PULL_DISMISS_PX) {
        pullRef.current = { state: IDLE_SWIPE, follow: false, distance: followed };
        onDismiss();
        // 关闭被上层门禁拒绝时阅读器仍打开：下一帧回到原位。
        requestAnimationFrame(() => { if (openedRef.current) settlePull(followed); });
      } else settlePull(followed);
      if (tracking) { tapRef.current = { down: null, last: null }; return; }
    }
    const start = tapRef.current.down;
    tapRef.current.down = null;
    if (!released || !start || start.id !== event.pointerId || failed) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > IMAGE_TAP_SLOP_PX || event.timeStamp - start.time > IMAGE_DOUBLE_TAP_MS) { tapRef.current.last = null; return; }
    const last = tapRef.current.last;
    const tap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    if (!last || tap.time - last.time > IMAGE_DOUBLE_TAP_MS || Math.hypot(tap.x - last.x, tap.y - last.y) > IMAGE_DOUBLE_TAP_RADIUS_PX) { tapRef.current.last = tap; return; }
    tapRef.current.last = null;
    const box = image?.getBoundingClientRect();
    if (box) glideTo(doubleTapImage(transformRef.current, tap, { x: box.left + box.width / 2, y: box.top + box.height / 2 }), zoomDuration);
  };
  const imageRadius = imageRadiusFor(transform.scale);
  const pulled = pull > 0 ? { translate: `0 ${pull}px`, scale: pullScale(pull, stageHeight()) } : null;
  return <>
    <div className="pwa-file-image-stage" data-swipe-ignore data-image-pull={pulled ? "" : undefined} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {failed ? <div role="alert"><p className="pwa-published-error">{t.files.decodeError}</p><Button variant="transparent" disabled={!canRetry} onClick={onRetry}>{t.common.retry}</Button></div> : <img ref={setImage} src={url} alt={name} draggable={false} onError={() => setFailed(true)} style={{ borderRadius: imageRadius, transform: imageTransform(transform), ...pulled }} />}
    </div>
    <div className="pwa-file-zoom">
      <ActionIcon variant="subtle" aria-label={t.files.zoomOut} onClick={() => glideTo(zoomImage(transformRef.current, transformRef.current.scale / 1.5), zoomDuration)}><Minus size={20} /></ActionIcon>
      <Button variant="transparent" leftSection={<RotateCcw size={16} />} onClick={() => glideTo({ ...IMAGE_RESET }, zoomDuration)} aria-label={t.files.resetZoom}>{Math.round(transform.scale * 100)}%</Button>
      <ActionIcon variant="subtle" aria-label={t.files.zoomIn} onClick={() => glideTo(zoomImage(transformRef.current, transformRef.current.scale * 1.5), zoomDuration)}><Plus size={20} /></ActionIcon>
    </div>
  </>;
}

/** 阅读器之上存在其他模态（确认框等）时，返回与关闭交给上层处理。 */
const hasOtherModal = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]:not(.pwa-file-reader)')].some(element => !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");

type PublishedFileReaderProps = { file: FileSourceDescriptor; opened: boolean; onClose: () => void; onExitTransitionEnd: () => void; source?: HTMLButtonElement };

/** pin 由业务选择持有，布局迁移或 opened=false 不提前释放。 */
export function PublishedFileReader(props: PublishedFileReaderProps) {
  const files = usePublishedFilesView();
  const key = fileKey(props.file);
  const [image] = useState(() => files?.getState(key)?.preview?.kind === "image");
  const pin = files?.pin;
  const unpin = files?.unpin;
  useEffect(() => { pin?.(key); return () => unpin?.(key); }, [pin, unpin, key]);
  return image ? <PublishedModalFileReader {...props} /> : <PublishedTextReader {...props} />;
}

function PublishedTextReader({ file, opened, onClose, onExitTransitionEnd }: PublishedFileReaderProps) {
  const { t } = useI18n();
  const files = usePublishedFilesView();
  const state = files?.getState(fileKey(file));
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
  return <ReaderShell opened={opened} onClose={onClose} onExitTransitionEnd={onExitTransitionEnd} onEnterTransitionEnd={() => setEntered(true)} title={name} closeLabel={t.files.closeReader} historyKey="piReachFileReader" className="pwa-file-reader" actions={state?.phase === "ready" && state.url ? <ActionIcon component="a" className="pwa-icon-button" href={state.url} download={fileSaveName(name)} aria-label={t.files.save} title={t.files.save}><Download size={20} aria-hidden="true" /></ActionIcon> : null}>
    {!entered && text !== undefined ? <div className="pwa-file-reader-scroll" aria-busy="true" /> : preview ? <div ref={setScroll} className="pwa-file-reader-scroll"><FileTextContent text={preview.text} markdown={markdown} />{preview.truncated ? <p className="pwa-published-meta" role="status">{t.files.truncated}</p> : null}</div> : <p className="pwa-published-meta">{t.files.noPreview}</p>}
  </ReaderShell>;
}

/** 图片保留阶段 C 的模态几何、history 与跟手生命周期。 */
function PublishedModalFileReader({ file, opened, onClose, onExitTransitionEnd, source }: PublishedFileReaderProps) {
  const { t } = useI18n();
  const files = usePublishedFilesView();
  const state = files?.getState(fileKey(file));
  const name = state?.fileName ?? file.file_name;
  const headingId = useId();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY) ?? false;
  const drawerDuration = usePwaMotionDuration("--pwa-duration-drawer");
  const drawerExitDuration = usePwaMotionDuration("--pwa-duration-drawer-out");
  const fadeDuration = usePwaMotionDuration("--pwa-duration-fade");
  const imageIn = usePwaMotionDuration("--pwa-duration-image-in");
  const imageOut = usePwaMotionDuration("--pwa-duration-image-out");
  const [imageReader] = useState(() => state?.preview?.kind === "image");
  // 仅点击时已解码的来源可参与开场；迟到解码不补播放大。
  const [allowImageEnter] = useState(() => !!source && publishedImageBounds(source.querySelector("img")) !== null);
  const { instant, skipExit, resetSkipExit } = useReaderHistory({
    opened,
    stateKey: "piReachFileReader",
    marker: `${fileKey(file)}:${headingId}`,
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
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened, direction: "right", requestClose, skipExit, resetSkipExit });
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
  return <Drawer.Root opened={opened} onClose={requestClose} onEnterTransitionEnd={() => { setEntered(true); motion.onEnterTransitionEnd(); }} onExitTransitionEnd={onExitTransitionEnd} position="right" size={mobile ? "100%" : "var(--pwa-reader-drawer-width)"} withinPortal portalProps={{ target: ".pwa-root" }} zIndex="var(--pwa-z-reader)" trapFocus returnFocus={false} transitionProps={{ transition: imageReader ? pwaFadeTransition : pwaDrawerTransitions.right, duration: imageReader ? allowImageEnter ? imageIn : fadeDuration : drawerDuration, exitDuration: instant ? 0 : imageReader ? imageOut : drawerExitDuration, timingFunction: PWA_DRAWER_EASE }}>
    <Drawer.Overlay className="pwa-scrim pwa-file-reader-overlay" data-image-reader={imageReader || undefined} />
    <Drawer.Content ref={setSurface} classNames={{ content: "pwa-file-reader" }} data-pwa-moving={motion.moving || undefined} data-image-reader={imageReader || undefined} data-publication-id={isAttachmentFile(file) ? undefined : file.publication_id} data-attachment-id={isAttachmentFile(file) ? file.attachment_id : undefined}>
      <Drawer.Header className="pwa-topbar pwa-file-reader-header">
        {/* 移动全屏与设置页同为左侧返回；桌面右侧 Drawer 保留右上角关闭。 */}
        {mobile ? <Drawer.CloseButton className="pwa-icon-button pwa-topbar-back" aria-label={t.files.closeReader} icon={<ArrowLeft size={20} />} /> : null}
        <Drawer.Title tabIndex={-1} data-autofocus title={name}>{name}</Drawer.Title>
        {state?.phase === "ready" && state.url ? <ActionIcon component="a" className="pwa-icon-button" href={state.url} download={fileSaveName(name)} aria-label={t.files.save} title={t.files.save}><Download size={20} aria-hidden="true" /></ActionIcon> : null}
        {mobile ? null : <Drawer.CloseButton className="pwa-icon-button" aria-label={t.files.closeReader} icon={<X size={20} />} />}
      </Drawer.Header>
      <Drawer.Body className="pwa-file-reader-body">
        {state?.phase === "ready" && state.preview?.kind === "image" && state.url ? <PublishedImage key={state.url} url={state.url} name={name} source={source} surface={surface} opened={opened} instant={instant} allowEnter={allowImageEnter && !entered} enterDuration={imageIn} exitDuration={imageOut} onDismiss={requestClose} canRetry={files?.canFetch === true} onRetry={() => { void Promise.resolve().then(() => files?.retry?.(file, "view") ?? files?.open(file, "view")).catch(() => undefined); }} /> : textPending ? <div className="pwa-file-reader-scroll" aria-busy="true" /> : preview ? <div ref={setScroll} className="pwa-file-reader-scroll"><FileTextContent text={preview.text} markdown={markdown} />{preview.truncated ? <p className="pwa-published-meta" role="status">{t.files.truncated}</p> : null}</div> : state?.phase === "opening" || state?.phase === "reading" ? <p className="pwa-published-meta" role="status">{t.files.fetching}</p> : <p className="pwa-published-meta">{t.files.noPreview}</p>}
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
