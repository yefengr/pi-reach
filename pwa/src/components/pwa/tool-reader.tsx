import { useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { ArrowLeft, Check, CircleAlert, CircleHelp, CircleStop, LoaderCircle, X } from "lucide-react";
import { CopyButton } from "./copy-button";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, usePwaMotionDuration } from "./use-pwa-motion";
import { useReaderHistory } from "./use-reader-history";
import { ToolImage } from "./tool-output";
import { toolContentBlocks, toolError, toolReaderCall, toolStatus, toolWasTruncated, type ToolContentBlock, type ToolValue } from "./tool-presentation";
import { useI18n } from "@/lib/i18n";
import "./tool-reader.css";

type ToolReaderProps = {
  value: ToolValue | null;
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
};

const FOLLOW_THRESHOLD_PX = 32;

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "pwa-reader-line pwa-reader-line-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "pwa-reader-line pwa-reader-line-remove";
  return "pwa-reader-line";
}

/** 原始输出与 Pi 原生一致不带行号，与调用行同一左边线；diff 逐行以轻底和左侧色条区分增删。 */
function OutputText({ block }: { block: Extract<ToolContentBlock, { kind: "text" }> }) {
  const lines = block.style === "diff" ? block.text.split("\n") : null;
  return <section className="pwa-reader-block" aria-label={block.label}>
    {block.label ? <p className="pwa-reader-block-label">{block.label}</p> : null}
    <pre className="pwa-reader-text">{lines ? lines.map((line, index) => <span key={index} className={diffLineClass(line)}>{line}{index < lines.length - 1 ? "\n" : ""}</span>) : block.text}</pre>
  </section>;
}

function StatusIcon({ status }: { status: ReturnType<typeof toolStatus> }) {
  if (status === "running") return <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />;
  if (status === "complete") return <Check size={16} aria-hidden="true" />;
  if (status === "error") return <CircleAlert size={16} aria-hidden="true" />;
  if (status === "interrupted") return <CircleStop size={16} aria-hidden="true" />;
  return <CircleHelp size={16} aria-hidden="true" />;
}

/**
 * 工具详情阅读器：桌面为右侧 720px Drawer，移动端全屏。
 * 打开时压入一条不改变 URL 的历史记录，系统返回与浏览器后退关闭阅读器而不离开会话。
 */
export function ToolReader({ value, opened, onClose, onExitTransitionEnd }: ToolReaderProps) {
  const { t } = useI18n();
  const drawerDuration = usePwaMotionDuration("--pwa-duration-drawer", 200);
  const mobile = useMediaQuery("(max-width: 767.98px)") ?? false;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const { instant, skipExit, resetSkipExit } = useReaderHistory({ opened, stateKey: "piReachToolReader", marker: true, onClose });
  const { drag, canSwipe } = useDrawerSwipeClose({ surface, opened, direction: 1, requestClose: onClose, skipExit, resetSkipExit });
  useSwipe(surface, { direction: "right", enabled: opened && mobile, onSwipe: onClose, canSwipe, drag });

  const outputKey = value ? JSON.stringify([value.tool_call_id, "blocks" in value ? value.blocks : null, "result" in value ? value.result : null]) : "";
  useLayoutEffect(() => {
    // 运行中的工具实时更新：停在底部时跟随，向上回看时不跟随。
    const scroll = scrollRef.current;
    if (scroll && followRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [outputKey]);

  const status = value ? toolStatus(value) : "unknown";
  // 正文首块原样列出全部参数（不截断），其后只放真实结果，不再从参数复制内容。
  const callText = value ? toolReaderCall(value) : undefined;
  const blocks = value ? toolContentBlocks(value, { input: false }) : [];
  const error = value ? toolError(value) : undefined;
  const bodyBlocks = blocks.filter((block) => !(block.kind === "text" && block.style === "error"));
  const allText = blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n\n");
  const title = value?.tool ?? t.tools.noToolSelected;
  const statusLabel = status === "unknown" ? t.timeline.unknown : t.tools.status[status];

  return <Drawer.Root
    opened={opened}
    onClose={onClose}
    onExitTransitionEnd={onExitTransitionEnd}
    position="right"
    size={mobile ? "100%" : 720}
    withinPortal
    portalProps={{ target: ".pwa-root" }}
    zIndex={30}
    trapFocus
    returnFocus={false}
    transitionProps={{ transition: pwaDrawerTransitions.right, duration: drawerDuration, exitDuration: instant ? 0 : drawerDuration, timingFunction: PWA_DRAWER_EASE }}
  >
    <Drawer.Overlay className="pwa-scrim" />
    <Drawer.Content ref={setSurface} classNames={{ content: "pwa-tool-reader" }} aria-describedby="pwa-tool-reader-description">
      <Drawer.Header className="pwa-topbar pwa-tool-reader-header">
        {/* 移动全屏与设置页同为左侧返回；桌面右侧 Drawer 保留右上角关闭。 */}
        {mobile ? <Drawer.CloseButton className="pwa-icon-button pwa-topbar-back pwa-tool-reader-close" aria-label={t.tools.closeReader} title={t.tools.closeReader} icon={<ArrowLeft size={20} />} /> : null}
        {/* Mantine 只在使用 Drawer.Title 时为对话框设置 aria-labelledby，自定义标题会让对话框失去可访问名称。 */}
        <Drawer.Title className="pwa-tool-reader-title" tabIndex={-1} data-autofocus title={title}>{title}</Drawer.Title>
        <div className="pwa-tool-reader-actions">
          {/* 与会话内工具行一致只显示彩色图标，文字仅供读屏与悬停提示。 */}
          <span id="pwa-tool-reader-description" className={`pwa-tool-reader-status pwa-tool-status-${status}`} title={statusLabel}><StatusIcon status={status} /><span className="pwa-sr-only">{statusLabel}</span></span>
          {allText ? <CopyButton text={allText} label={t.tools.copyAll} /> : null}
          {mobile ? null : <Drawer.CloseButton className="pwa-icon-button pwa-tool-reader-close" aria-label={t.tools.closeReader} title={t.tools.closeReader} icon={<X size={20} />} />}
        </div>
      </Drawer.Header>
      <Drawer.Body className="pwa-tool-reader-body">
        <div className="pwa-tool-reader-scroll" ref={scrollRef} onScroll={(event) => {
          const target = event.currentTarget;
          followRef.current = target.scrollHeight - target.scrollTop - target.clientHeight <= FOLLOW_THRESHOLD_PX;
        }}>
          {value === null ? <p className="pwa-tool-empty">{t.tools.noDetails}</p> : <>
            {callText ? <pre className="pwa-tool-reader-command">{callText}</pre> : null}
            {error ? <div className="pwa-reader-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><pre>{error}</pre></div> : null}
            {bodyBlocks.map((block, index) => block.kind === "image"
              ? <ToolImage key={`image:${index}`} block={block} index={index} preview={false} />
              : <OutputText key={`text:${index}`} block={block} />)}
            {toolWasTruncated(value) ? <p className="pwa-tool-notice">{t.tools.outputTruncated}</p> : null}
          </>}
        </div>
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
