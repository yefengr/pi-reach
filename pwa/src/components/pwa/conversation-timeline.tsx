import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ThinkingContent, MarkdownContent } from "./timeline-content";
import { ToolCard, ToolGroupCard } from "./tool-card";
import { ToolReader } from "./tool-reader";
import { PublishedFileReader } from "./published-file-reader";
import { usePublishedFilesView } from "./published-files-context";
import type { PublishedFileRead } from "./published-file";
import type { PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { entryGroupId, isPiOutputEntry, projectTimeline, type PresentationEntry, type TextEntry, type ToolEntry } from "@/lib/pwa/timeline-presentation";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

type ConversationTimelineProps = {
  items: readonly TimelineViewItem[];
  live: boolean;
  /** 每一轮的结束时间与状态（来自 run_end，缺失时按降级规则推断）。 */
  completions?: ReadonlyMap<string, RunCompletion>;
  /** 在线 Pi 正在运行：最后一轮尚无输出时显示「Pi 正在思考…」。 */
  running?: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  onReadingChange?: (reading: boolean) => void;
  renderRecord: (item: TimelineViewItem, onRead: PublishedFileRead) => ReactNode;
};

type ReaderState = { key: string } | null;

const TOOL_GROUP_MINIMUM = 2;

/**
 * 已结束的一轮中，相邻且都已成功完成的工具（至少两条）合并为一行摘要；夹有正文、思考或其他记录时断开。
 * 运行中的一轮逐条显示，避免工具相继完成时时间线在眼前合并跳动；失败、中断与未知状态的工具不参与合并。组 key 取组内第一个工具。
 */
function completedToolRuns(entries: readonly PresentationEntry[], finished: (groupId: string | undefined) => boolean): Map<string, ToolEntry[]> {
  const runs = new Map<string, ToolEntry[]>();
  let run: ToolEntry[] = [];
  let runGroup: string | undefined;
  const flush = () => {
    if (run.length >= TOOL_GROUP_MINIMUM) runs.set(`tools:${run[0]!.key}`, run);
    run = [];
  };
  for (const entry of entries) {
    const groupId = entryGroupId(entry);
    if (groupId !== runGroup) {
      flush();
      runGroup = groupId;
    }
    if (entry.kind === "tool" && entry.value.status === "complete" && finished(groupId)) {
      run.push(entry);
      continue;
    }
    flush();
  }
  flush();
  return runs;
}

/** Pi 回复靠左占满阅读列、无底色；不显示发送方，只为读屏保留「Pi：」。 */
function TextRow({ entry }: { entry: TextEntry }) {
  const { t } = useI18n();
  return <article className={`pwa-message assistant${entry.streaming ? " partial" : ""}`} data-timeline-key={entry.key}>
    <span className="pwa-sr-only">{t.timeline.srPi}</span>
    <MarkdownContent text={entry.text} />
  </article>;
}

/** 一轮结束后在末尾显示一次完成时间；中断或出错时附状态。 */
function TurnMeta({ completion, interrupted }: { completion: RunCompletion; interrupted: boolean }) {
  const { t, format } = useI18n();
  const status = completion.status === "error" ? t.timeline.turnError : completion.status === "interrupted" || interrupted ? t.timeline.turnInterrupted : null;
  return <p className="pwa-turn-meta"><time className="pwa-tabular" dateTime={new Date(completion.timestamp).toISOString()}>{format.time(completion.timestamp)}</time>{status ? <span className={completion.status === "error" ? "pwa-turn-status-error" : "pwa-turn-status"}> · {status}</span> : null}</p>;
}

function ThinkingStatus() {
  const { t } = useI18n();
  return <p className="pwa-thinking-status" role="status"><LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />{t.timeline.piThinking}</p>;
}

function conversationRows(entries: readonly PresentationEntry[], completions: ConversationTimelineProps["completions"], toolRuns: Map<string, ToolEntry[]>, groupedToolKeys: Map<string, string>, expanded: (key: string) => boolean, choose: (key: string, expanded: boolean) => void, render: (entry: PresentationEntry) => ReactNode) {
  const rows: ReactNode[] = [];
  let segmentGroup: string | undefined;
  let hasOutput = false;
  let interrupted = false;
  const closeSegment = () => {
    const completion = segmentGroup === undefined ? undefined : completions?.get(segmentGroup);
    if (completion && hasOutput) rows.push(<TurnMeta key={`turn:${segmentGroup}`} completion={completion} interrupted={interrupted} />);
  };
  for (const entry of entries) {
    const groupId = entryGroupId(entry);
    if (groupId !== segmentGroup) {
      closeSegment();
      segmentGroup = groupId;
      hasOutput = false;
      interrupted = false;
    }
    if (isPiOutputEntry(entry)) hasOutput = true;
    if (entry.kind === "text" && entry.interrupted) interrupted = true;
    const runKey = groupedToolKeys.get(entry.key);
    if (runKey !== undefined) {
      const run = toolRuns.get(runKey)!;
      if (run[0]!.key === entry.key) rows.push(<ToolGroupCard key={runKey} values={run.map(tool => tool.value)} expanded={expanded(runKey)} onExpandedChange={value => choose(runKey, value)}>{run.map(render)}</ToolGroupCard>);
      continue;
    }
    rows.push(render(entry));
  }
  closeSegment();
  return { rows, hasOutput };
}

export function ConversationTimeline({ items, live, completions, running = false, listRef, onReadingChange, renderRecord }: ConversationTimelineProps) {
  const [snapshot, setSnapshot] = useState(() => projectTimeline([]));
  const [expansionChoices, setExpansionChoices] = useState<Map<string, boolean>>(() => new Map());
  const [reader, setReader] = useState<ReaderState>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerOrigin, setReaderOrigin] = useState<HTMLButtonElement | null>(null);
  const [fileReader, setFileReader] = useState<{ file: PublishedFileDescriptor; trigger: HTMLButtonElement; scopeToken: object } | null>(null);
  const [fileOpened, setFileOpened] = useState(false);
  const files = usePublishedFilesView();
  const fileReadingChange = files?.onReadingChange;
  const scopedFileReader = fileReader?.scopeToken === files?.scopeToken ? fileReader : null;
  // 真实目标失效直接卸载，复用 Reader 的 pin/history cleanup，不播放旧目标退出或回焦。
  if (fileReader !== null && scopedFileReader === null) {
    setFileReader(null);
    setFileOpened(false);
  }
  const currentFileReader = useRef(scopedFileReader);
  useLayoutEffect(() => { currentFileReader.current = scopedFileReader; }, [scopedFileReader]);

  let view = snapshot;
  if (snapshot.items !== items) {
    view = projectTimeline(items, snapshot);
    setSnapshot(view);
  }
  const readerValue = reader ? view.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.key === reader.key)?.value ?? null : null;
  // 仍有流式内容的一轮也视为未结束（working 状态可能晚于输出到达）。
  const streamingGroups = new Set(view.entries.flatMap(entry => (entry.kind === "tool" && "partial_id" in entry.value) || ((entry.kind === "text" || entry.kind === "thinking") && entry.streaming) ? [entryGroupId(entry)] : []));
  const toolRuns = completedToolRuns(view.entries, groupId => groupId !== undefined && completions?.has(groupId) === true && !streamingGroups.has(groupId));
  const groupedToolKeys = new Map<string, string>();
  for (const [runKey, run] of toolRuns) for (const tool of run) groupedToolKeys.set(tool.key, runKey);
  // 组内有工具仍展开（如运行中展开后该轮结束）时摘要默认展开，正在阅读的内容不会被收起。
  const groupExpanded = (choices: ReadonlyMap<string, boolean>, runKey: string) => choices.get(runKey) ?? toolRuns.get(runKey)!.some(tool => choices.get(tool.key) === true);
  // 展开的工具组与单条展开的工具、思考一样暂停自动跟随；折叠组内的工具不算正在阅读。
  const readingInline = (choices: ReadonlyMap<string, boolean>) => [...toolRuns.keys()].some(runKey => groupExpanded(choices, runKey))
    || view.entries.some(entry => (entry.kind === "tool" || entry.kind === "thinking") && choices.get(entry.key) === true
      && !(groupedToolKeys.has(entry.key) && !groupExpanded(choices, groupedToolKeys.get(entry.key)!)));
  // 历史窗口替换可能移除已展开工具；阅读锁随可见内容同步，并保留到 Reader 退出结束。
  const reading = reader !== null || scopedFileReader !== null || readingInline(expansionChoices);
  useEffect(() => { onReadingChange?.(reading); fileReadingChange?.(reading); }, [onReadingChange, fileReadingChange, reading]);
  useEffect(() => () => { onReadingChange?.(false); fileReadingChange?.(false); }, [onReadingChange, fileReadingChange]);

  const chooseExpansion = (key: string, expanded: boolean) => {
    const choices = new Map(expansionChoices).set(key, expanded);
    setExpansionChoices(choices);
    onReadingChange?.(reader !== null || scopedFileReader !== null || readingInline(choices));
  };
  const openReader = (key: string, trigger: HTMLButtonElement) => {
    if (scopedFileReader !== null) return;
    setReaderOrigin(trigger);
    onReadingChange?.(true);
    setReader({ key });
    setReaderOpen(true);
  };
  const finishReader = () => {
    setReaderOpen(false);
    setReader(null);
    setReaderOrigin(null);
    // 背景位置由时间线锚点持续维护，退出时只回焦，避免旧 scrollTop 覆盖补偿。
    if (readerValue !== null && readerOrigin?.isConnected && readerOrigin.getClientRects().length > 0) {
      readerOrigin.focus({ preventScroll: true });
    } else {
      listRef.current?.focus({ preventScroll: true });
    }
    onReadingChange?.(readingInline(expansionChoices));
  };

  const openFileReader: PublishedFileRead = (file, trigger) => {
    if (!files || reader !== null || scopedFileReader !== null) return;
    setFileReader({ file, trigger, scopeToken: files.scopeToken });
    setFileOpened(true);
  };
  // 旧退出/关闭回调不能碰新的阅读器；门面 getter 也能识别尚未提交 render 的 reset。
  const ownsFileReader = () => scopedFileReader !== null && currentFileReader.current === scopedFileReader
    && files?.scopeToken === scopedFileReader.scopeToken;
  const closeFileReader = () => { if (ownsFileReader()) setFileOpened(false); };
  const finishFileReader = () => {
    if (!ownsFileReader()) return;
    const trigger = scopedFileReader?.trigger;
    setFileOpened(false);
    setFileReader(null);
    if (trigger?.isConnected && trigger.getClientRects().length > 0) trigger.focus({ preventScroll: true });
    else listRef.current?.focus({ preventScroll: true });
  };
  const renderEntry = (entry: PresentationEntry) => {
      if (entry.kind === "record") return <Fragment key={entry.key}>{renderRecord(entry.item, openFileReader)}</Fragment>;
      if (entry.kind === "text") return <TextRow entry={entry} key={entry.key} />;
      if (entry.kind === "thinking") return <ThinkingContent
        key={entry.key}
        timelineKey={entry.key}
        text={entry.text}
        streaming={entry.streaming}
        expanded={expansionChoices.get(entry.key) ?? false}
        onExpandedChange={expanded => chooseExpansion(entry.key, expanded)}
      />;
      return <ToolCard
        key={entry.key}
        value={entry.value}
        status={"partial_id" in entry.value && !live ? "unknown" : undefined}
        expanded={expansionChoices.get(entry.key) ?? false}
        onExpandedChange={expanded => chooseExpansion(entry.key, expanded)}
        onRead={trigger => openReader(entry.key, trigger)}
      />;
  };
  // 发布记录保留 group_id，同一轮的完成时间仍只在段末追加一次。
  const { rows, hasOutput } = conversationRows(view.entries, completions, toolRuns, groupedToolKeys, key => groupExpanded(expansionChoices, key), chooseExpansion, renderEntry);
  const waitingForReply = live && running && view.entries.length > 0 && !hasOutput;

  return <>
    {rows}
    {waitingForReply ? <ThinkingStatus /> : null}
    <ToolReader value={readerValue} opened={readerOpen && readerValue !== null} onClose={() => setReaderOpen(false)} onExitTransitionEnd={finishReader} />
    {scopedFileReader ? <PublishedFileReader file={scopedFileReader.file} opened={fileOpened} onClose={closeFileReader} onExitTransitionEnd={finishFileReader} /> : null}
  </>;
}
