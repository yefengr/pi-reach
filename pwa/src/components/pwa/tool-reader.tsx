import { useLayoutEffect, useRef } from "react";
import { Check, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";
import { ReaderShell } from "./reader-shell";
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
 * 工具详情阅读器：桌面为右侧 Drawer，移动端全屏。
 * 打开时压入一条历史记录，系统返回关闭阅读器而不离开会话。
 */
export function ToolReader({ value, opened, onClose, onExitTransitionEnd }: ToolReaderProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  useLayoutEffect(() => { if (opened) followRef.current = true; }, [opened, value?.tool_call_id]);
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
  const title = value?.tool ?? t.tools.noToolSelected;
  const statusLabel = status === "unknown" ? t.timeline.unknown : t.tools.status[status];

  return <ReaderShell opened={opened} onClose={onClose} onExitTransitionEnd={onExitTransitionEnd}
    title={title} closeLabel={t.tools.closeReader} historyKey="piReachToolReader" describedBy="pwa-tool-reader-description"
    actions={<>
      <span id="pwa-tool-reader-description" className={`pwa-tool-reader-status pwa-tool-status-${status}`} title={statusLabel}><StatusIcon status={status} /><span className="pwa-sr-only">{statusLabel}</span></span>
    </>}>
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
  </ReaderShell>;
}
