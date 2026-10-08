import { useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Check, CircleAlert, CircleHelp, CircleStop, LoaderCircle, X } from "lucide-react";
import { CopyButton } from "./copy-button";
import { useSwipe } from "./use-swipe";
import { useDrawerSwipeClose } from "./use-drawer-swipe-close";
import { PWA_DRAWER_EASE, pwaDrawerTransitions, usePwaMotionDuration } from "./use-pwa-motion";
import { useReaderHistory } from "./use-reader-history";
import { ToolImage } from "./tool-output";
import { toolAction, toolContentBlocks, toolError, toolStatus, toolWasTruncated, type ToolContentBlock, type ToolValue } from "./tool-presentation";
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

/** 带行号的原始输出：长行自动换行，行号使用 secondary。 */
function NumberedText({ block }: { block: Extract<ToolContentBlock, { kind: "text" }> }) {
  const lines = block.text.split("\n");
  const diff = block.style === "diff";
  return <section className="pwa-reader-block" aria-label={block.label}>
    {block.label ? <p className="pwa-reader-block-label">{block.label}</p> : null}
    <pre className="pwa-reader-text">{lines.map((line, index) => <span key={index} className={diff ? diffLineClass(line) : "pwa-reader-line"}><span className="pwa-reader-line-number" aria-hidden="true">{index + 1}</span><span className="pwa-reader-line-text">{line}{index < lines.length - 1 ? "\n" : ""}</span></span>)}</pre>
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

  const action = value ? toolAction(value) : null;
  const status = value ? toolStatus(value) : "unknown";
  const blocks = value ? toolContentBlocks(value) : [];
  const error = value ? toolError(value) : undefined;
  const bodyBlocks = blocks.filter((block) => !(block.kind === "text" && block.style === "error"));
  const allText = blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n\n");
  const heading = action?.detail || action?.label || value?.tool || t.tools.readerKicker;

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
    <Drawer.Content ref={setSurface} classNames={{ content: "pwa-tool-reader" }} aria-labelledby="pwa-tool-reader-title" aria-describedby="pwa-tool-reader-description">
      <Drawer.Header className="pwa-tool-reader-header">
        {/* 与会话内工具行同一读法：工具名＋命令在前，状态标签放在右侧操作区。 */}
        <div className="pwa-tool-reader-title-wrap">
          <h2 id="pwa-tool-reader-title" className="pwa-tool-reader-title" tabIndex={-1} data-autofocus>
            <strong className="pwa-tool-reader-tool">{value?.tool ?? t.tools.noToolSelected}</strong>
            <span className="pwa-tool-reader-command" title={heading}>{heading}</span>
          </h2>
        </div>
        <div className="pwa-tool-reader-actions">
          <span id="pwa-tool-reader-description" className={`pwa-tool-reader-status pwa-tool-status-${status}`}><StatusIcon status={status} />{status === "unknown" ? t.timeline.unknown : t.tools.status[status]}</span>
          {allText ? <CopyButton text={allText} label={t.tools.copyAll} /> : null}
          <Drawer.CloseButton className="pwa-icon-button pwa-tool-reader-close" aria-label={t.tools.closeReader} title={t.tools.closeReader} icon={<X size={20} />} />
        </div>
      </Drawer.Header>
      <Drawer.Body className="pwa-tool-reader-body">
        <div className="pwa-tool-reader-scroll" ref={scrollRef} onScroll={(event) => {
          const target = event.currentTarget;
          followRef.current = target.scrollHeight - target.scrollTop - target.clientHeight <= FOLLOW_THRESHOLD_PX;
        }}>
          {value === null ? <p className="pwa-tool-empty">{t.tools.noDetails}</p> : <>
            {error ? <div className="pwa-reader-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><pre>{error}</pre></div> : null}
            {bodyBlocks.map((block, index) => block.kind === "image"
              ? <ToolImage key={`image:${index}`} block={block} index={index} preview={false} />
              : <NumberedText key={`text:${index}`} block={block} />)}
            {toolWasTruncated(value) ? <p className="pwa-tool-notice">{t.tools.outputTruncated}</p> : null}
          </>}
        </div>
      </Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>;
}
