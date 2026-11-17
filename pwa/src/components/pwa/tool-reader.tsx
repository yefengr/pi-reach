import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@mantine/core";
import { Check, CircleAlert, CircleHelp, CircleStop, LoaderCircle } from "lucide-react";
import { ReaderShell } from "./reader-shell";
import { useToolDetails } from "@/lib/pwa/use-tool-details";
import { ToolImage } from "./tool-output";
import { TOOL_TYPE_ICONS } from "./tool-card";
import { CopyButton } from "./copy-button";
import { ReaderDocument } from "./reader-document";
import { ReaderToc } from "./reader-toc";
import type { DocumentHeading } from "./file-text-content";
import { readToolContent, readerResultBlocks, writeToolContent } from "./reader-content";
import { toolDiffView } from "./tool-diff";
import { isToolPreparing, toolAction, toolError, toolIdentity, toolInput, toolStatus, toolWasTruncated, type ToolContentBlock, type ToolStatus, type ToolValue } from "./tool-presentation";
import { useI18n } from "@/lib/i18n";
import { READER_FOLLOW_THRESHOLD_PX } from "./reader-shared";
import "./tool-reader.css";
import "./tool-reader-content.css";

type ToolReaderProps = {
  sourceKey?: string;
  value: ToolValue | null;
  status?: ToolStatus;
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
};

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running") return <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />;
  if (status === "complete") return <Check size={16} aria-hidden="true" />;
  if (status === "error") return <CircleAlert size={16} aria-hidden="true" />;
  if (status === "interrupted") return <CircleStop size={16} aria-hidden="true" />;
  return <CircleHelp size={16} aria-hidden="true" />;
}

function ResultBlock({ block, index, label, copyLabel, command }: { block: ToolContentBlock; index: number; label: string; copyLabel: string; command: boolean }) {
  if (block.kind === "image") return <ToolImage block={block} index={index} />;
  return <section className="pwa-reader-block" aria-label={label}>
    <div className="pwa-reader-toolbar"><span>{label}</span><CopyButton text={block.text} label={copyLabel} className="pwa-icon-button" /></div>
    <pre className={`pwa-reader-text${command ? " pwa-reader-log" : ""}`}>{block.text}</pre>
  </section>;
}

/** 只读本次调用记录；文件正文、请求的写入内容与真实执行状态分别取值。 */
function ToolBody({ value, status, onHeadings, onPreviewChange }: {
  value: ToolValue; status: ToolStatus;
  onHeadings: (headings: readonly DocumentHeading[]) => void;
  onPreviewChange: (preview: boolean) => void;
}) {
  const { t } = useI18n();
  const model = useMemo(() => {
    const action = toolAction(value);
    const read = readToolContent(value);
    const write = writeToolContent(value);
    const diff = toolDiffView(value);
    const diffWidth = diff?.rows.reduce((width, row) => row.kind === "line" ? Math.max(width, String(row.oldLine ?? "").length, String(row.newLine ?? "").length) : width, 3) ?? 3;
    const blocks = readerResultBlocks(value);
    return { action, read, write, diff, diffWidth, blocks };
  }, [value]);
  const { action, read, write, diff } = model;
  const file = action.kind === "read" || action.kind === "write" || action.kind === "edit";
  const markdown = /\.(md|markdown)$/i.test(action.detail);
  const error = toolError(value);
  const args = toolInput(value);
  const searchPath = action.kind === "search" && typeof args === "object" && args !== null && "path" in args && typeof args.path === "string" ? args.path : undefined;
  const extras = model.blocks.filter(block => {
    if (block.kind !== "text") return true;
    if (block.style === "error" && error) return false;
    if (read && block.style === "code") return false;
    if (diff && block.style === "diff") return false;
    return true;
  });
  // 结果块的标签栏必须有明确文字：命令为执行日志，搜索为匹配结果，其余工具用通用结果名。
  const resultLabels = action.kind === "command" ? { label: t.tools.executionLog, copy: t.tools.copyLog }
    : action.kind === "search" ? { label: t.tools.matchingResults, copy: t.tools.copySearchResults }
    : { label: t.tools.resultLabel, copy: t.tools.copyResult };
  const source = read?.text ?? write;
  const sourceLabel = read?.startLine !== undefined && read.endLine !== undefined ? t.tools.displayedLines(read.startLine, read.endLine)
    : action.kind === "write" ? (status === "complete" ? t.tools.writtenContent : status === "running" ? t.tools.pendingContent : t.tools.attemptedContent) : t.tools.sourceContent;
  return <>
    {file ? <div className={`pwa-reader-file-head${diff ? " pwa-reader-diff-head" : ""}`}>
      <p className="pwa-reader-file-path">{action.detail}</p>
      {diff ? <div className="pwa-reader-toolbar"><span className="pwa-tool-diff" aria-label={t.tools.diffStats(diff.added, diff.removed)}><span className="pwa-tool-diff-remove">−{diff.removed}</span><span className="pwa-tool-diff-add">+{diff.added}</span></span><CopyButton text={diff.text} label={t.tools.copyDiff} className="pwa-icon-button" /></div> : null}
    </div> : null}
    {error ? <div className="pwa-reader-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><pre>{error}</pre></div> : null}
    {action.kind === "command" ? <div className="pwa-reader-command"><pre className="pwa-reader-text"><span aria-hidden="true">$ </span>{action.detail}</pre><CopyButton text={action.detail} label={t.tools.copyCommand} className="pwa-icon-button" /></div> : null}
    {action.kind === "search" ? <div className="pwa-reader-search"><div className="pwa-reader-toolbar"><span>{t.tools.searchHeader(searchPath)}</span><CopyButton text={action.detail} label={t.tools.copySearchTerm} className="pwa-icon-button" /></div><pre className="pwa-reader-text">{action.detail}</pre></div> : null}
    {source !== undefined ? <ReaderDocument text={source} markdown={markdown} allowFrontmatter={read === undefined || read.startLine === 1} sourceLabel={sourceLabel} partial={read?.partial ?? false} initialSource={read?.partial ?? false} startLine={read?.startLine} endLine={read?.endLine} onHeadings={onHeadings} onPreviewChange={onPreviewChange} /> : null}
    {read?.notice ? <p className="pwa-tool-notice">{read.notice}</p> : null}
    {diff ? <div className="pwa-reader-diff" style={{ "--pwa-reader-diff-line-width": `${model.diffWidth}ch` } as CSSProperties} role="region" aria-label={t.tools.diffRegion}>
      {diff.rows.map((row, index) => row.kind === "omission" ? <div className="pwa-reader-diff-omission" key={index} aria-label={t.tools.omittedContent}>⋯</div> : <div className={`pwa-reader-diff-row${row.sign === "+" ? " pwa-reader-diff-add" : row.sign === "-" ? " pwa-reader-diff-remove" : ""}`} key={index}>
        <span className="pwa-reader-line-number">{row.oldLine}</span><span className="pwa-reader-line-number">{row.newLine}</span><span className="pwa-reader-diff-sign" aria-hidden="true">{row.sign === "-" ? "−" : row.sign}</span><span className="pwa-reader-diff-text">{row.text || "\n"}</span>
      </div>)}
    </div> : action.kind === "edit" ? <div className="pwa-reader-diff-empty"><h2>{t.tools.diffUnavailable}</h2><p>{t.tools.diffUnavailableBody}</p></div> : null}
    {extras.map((block, index) => <ResultBlock key={index} block={block} index={index} label={action.kind !== "search" && block.kind === "text" ? block.label ?? resultLabels.label : resultLabels.label} copyLabel={resultLabels.copy} command={action.kind === "command"} />)}
    {toolWasTruncated(value) ? <p className="pwa-tool-notice">{t.tools.outputTruncated}</p> : null}
  </>;
}

/** 保留按需详情、退出快照和流式回看；外壳的 history／手势由 ReaderShell 统一处理。 */
export function ToolReader({ value: sourceValue, sourceKey, status: statusOverride, opened, onClose, onExitTransitionEnd }: ToolReaderProps) {
  const { t } = useI18n();
  const details = useToolDetails(sourceValue, opened, sourceKey);
  const value = details.value;
  const close = () => { details.cancel?.(); onClose(); };
  const detailNotice = details.state.error === "offline" ? t.tools.detailsOffline : details.state.error === "invalid" ? t.tools.detailsInvalid : details.state.error === "too_large" ? t.tools.detailsTooLarge : details.state.error ? t.tools.detailsUnavailable : t.tools.detailsLoading;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
  // 挂载即打开时 Mantine 已处于进入完成态，不会补发进入结束回调。
  const [entered, setEntered] = useState(opened);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; setScroll(node); }, []);
  const followRef = useRef(true);
  const identity = value ? toolIdentity(value) : "";
  const [documentState, setDocumentState] = useState<{ identity: string; headings: readonly DocumentHeading[]; preview: boolean }>({ identity: "", headings: [], preview: false });
  const onHeadings = useCallback((headings: readonly DocumentHeading[]) => setDocumentState(previous => ({ ...previous, identity, headings })), [identity]);
  const onPreviewChange = useCallback((preview: boolean) => setDocumentState(previous => ({ ...previous, identity, preview })), [identity]);
  useLayoutEffect(() => { if (opened) followRef.current = true; }, [opened, identity]);
  const output = value ? ("blocks" in value ? value.blocks : "result" in value ? value.result : null) : null;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current && value && toolAction(value).kind === "command") element.scrollTop = element.scrollHeight;
  }, [output, entered, value]);
  const status = value ? toolStatus(value, details.state.content?.source === "session" ? undefined : statusOverride) : "unknown";
  const preparing = value && status === "running" && isToolPreparing(value);
  const statusLabel = preparing ? t.tools.preparing : status === "unknown" ? t.timeline.unknown : t.tools.status[status];
  const action = value ? toolAction(value) : null;
  const file = action && (action.kind === "read" || action.kind === "write" || action.kind === "edit");
  const object = action ? file ? action.detail.split(/[\\/]/).at(-1) ?? action.detail : action.detail : "";
  const title = action ? action.kind === "generic" ? value!.tool : `${action.label} ${action.detail}` : t.tools.noToolSelected;
  const TypeIcon = action ? TOOL_TYPE_ICONS[action.icon] : null;
  return <ReaderShell opened={opened} onClose={close} onExitTransitionEnd={onExitTransitionEnd} onEnterTransitionEnd={() => setEntered(true)}
    title={title} titleNode={action ? <span className="pwa-reader-heading">{TypeIcon ? <TypeIcon size={16} aria-hidden="true" /> : null}<span className="pwa-reader-verb">{action.kind === "generic" ? value!.tool : action.label}</span>{action.kind !== "generic" ? <span className="pwa-reader-object">{object}</span> : null}</span> : undefined}
    closeLabel={t.tools.closeReader} historyKey="piReachToolReader" describedBy="pwa-tool-reader-description"
    actions={<><span id="pwa-tool-reader-description" className={`pwa-tool-reader-status pwa-tool-status-${status}${preparing ? " pwa-tool-status-preparing" : ""}`} role="status" aria-live="polite" aria-atomic="true"><StatusIcon status={status} /><span>{statusLabel}</span></span>
      {documentState.identity === identity && documentState.preview ? <ReaderToc headings={documentState.headings} scroll={scroll} partial={value ? toolWasTruncated(value) : false} /> : null}</>}>
    <div className="pwa-tool-reader-scroll" ref={setScrollNode} aria-busy={!entered || details.pending} onScroll={event => {
      const target = event.currentTarget;
      followRef.current = target.scrollHeight - target.scrollTop - target.clientHeight <= READER_FOLLOW_THRESHOLD_PX;
    }}>
      {details.pending ? <><p className="pwa-tool-notice" role="status">{detailNotice}</p>{details.state.phase === "error" && details.state.retryable !== false ? <Button variant="subtle" onClick={details.retry}>{t.common.retry}</Button> : null}</> : value === null ? <p className="pwa-tool-empty">{t.tools.noDetails}</p> : entered ? <>
        {details.state.content?.source === "preview" ? <p className="pwa-tool-notice" role="status">{details.state.error ? detailNotice : t.tools.detailsPreview}</p> : null}
        <ToolBody key={identity} value={value} status={status} onHeadings={onHeadings} onPreviewChange={onPreviewChange} />
      </> : null}
    </div>
  </ReaderShell>;
}
