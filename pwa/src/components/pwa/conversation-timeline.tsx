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

/** `grouped`：打开时该工具已在组内；只有打开时尚未合并的工具才延后合并。 */
type ReaderState = { key: string; grouped: boolean } | null;

const TOOL_GROUP_MINIMUM = 2;

/** 已有定论的工具状态：成功、失败与中断都参与合并，状态未知的工具仍逐条显示。 */
const GROUPABLE_STATUSES: ReadonlySet<string> = new Set(["complete", "error", "interrupted"]);

/**
 * 已结束的一轮中，相邻且状态已有定论（成功、失败、中断）的工具（至少两条）合并为一行摘要；夹有正文、思考或其他记录时断开。
 * 运行中的一轮逐条显示，避免工具相继完成时时间线在眼前合并跳动；状态未知的工具不参与合并。
 * 阅读器正打开的工具所在的段暂不合并，退出后再合并，避免正在阅读的行消失。组 key 取组内第一个工具。
 */
function completedToolRuns(entries: readonly PresentationEntry[], finished: (groupId: string | undefined) => boolean, pinnedKey?: string): Map<string, ToolEntry[]> {
  const runs = new Map<string, ToolEntry[]>();
  let run: ToolEntry[] = [];
  let runGroup: string | undefined;
  const flush = () => {
    if (run.length >= TOOL_GROUP_MINIMUM && !run.some(tool => tool.key === pinnedKey)) runs.set(`tools:${run[0]!.key}`, run);
    run = [];
  };
  for (const entry of entries) {
    const groupId = entryGroupId(entry);
    if (groupId !== runGroup) {
      flush();
      runGroup = groupId;
    }
    if (entry.kind === "tool" && !("partial_id" in entry.value) && GROUPABLE_STATUSES.has(entry.value.status) && finished(groupId)) {
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
  // 记录已打开的是哪一个阅读器：挂载与打开分两步，期间被关闭或换目标时旧的打开请求自然失效。
  const [fileOpenedFor, setFileOpenedFor] = useState<object | null>(null);
  const files = usePublishedFilesView();
  const fileReadingChange = files?.onReadingChange;
  const scopedFileReader = fileReader?.scopeToken === files?.scopeToken ? fileReader : null;
  // 真实目标失效直接卸载，复用 Reader 的 pin/history cleanup，不播放旧目标退出或回焦。
  if (fileReader !== null && scopedFileReader === null) {
    setFileReader(null);
    setFileOpenedFor(null);
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
  const runFinished = (groupId: string | undefined) => groupId !== undefined && completions?.has(groupId) === true && !streamingGroups.has(groupId);
  const toolRuns = completedToolRuns(view.entries, runFinished, reader?.grouped === false ? reader.key : undefined);
  const groupedToolKeys = new Map<string, string>();
  for (const [runKey, run] of toolRuns) for (const tool of run) groupedToolKeys.set(tool.key, runKey);
  const groupExpanded = (choices: ReadonlyMap<string, boolean>, runKey: string) => choices.get(runKey) ?? false;
  // 只有展开的工具组与思考暂停行内自动跟随；工具详情由 Reader 独立持锁。
  const readingInline = (choices: ReadonlyMap<string, boolean>) => [...toolRuns.keys()].some(runKey => groupExpanded(choices, runKey))
    || view.entries.some(entry => entry.kind === "thinking" && choices.get(entry.key) === true);
  // 历史窗口替换可能移除阅读内容；阅读锁随可见内容同步，并保留到 Reader 退出结束。
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
    setReader({ key, grouped: groupedToolKeys.has(key) });
    setReaderOpen(true);
  };
  const finishReader = () => {
    setReaderOpen(false);
    setReader(null);
    setReaderOrigin(null);
    // 背景位置由时间线锚点持续维护，退出时只回焦，避免旧 scrollTop 覆盖补偿。
    // 延后的合并此刻生效，原触发行会被收进组里，回焦到列表。
    const regrouped = reader?.grouped === false && [...completedToolRuns(view.entries, runFinished).values()].some(run => run.some(tool => tool.key === reader.key));
    if (!regrouped && readerValue !== null && readerOrigin?.isConnected && readerOrigin.getClientRects().length > 0) {
      readerOrigin.focus({ preventScroll: true });
    } else {
      listRef.current?.focus({ preventScroll: true });
    }
    onReadingChange?.(readingInline(expansionChoices));
  };

  const openFileReader: PublishedFileRead = (file, trigger) => {
    if (!files || reader !== null || scopedFileReader !== null) return;
    const next = { file, trigger, scopeToken: files.scopeToken };
    setFileReader(next);
    // 阅读器随 opened=true 一起挂载时 Mantine 的过渡初始即“已进入”，不播放进入动画；
    // 先以收起态挂载，下一帧再打开。期间被关闭或换目标则放弃。
    requestAnimationFrame(() => setFileOpenedFor(next));
  };
  // 旧退出/关闭回调不能碰新的阅读器；门面 getter 也能识别尚未提交 render 的 reset。
  const ownsFileReader = () => scopedFileReader !== null && currentFileReader.current === scopedFileReader
    && files?.scopeToken === scopedFileReader.scopeToken;
  const closeFileReader = () => { if (ownsFileReader()) setFileOpenedFor(null); };
  const finishFileReader = () => {
    if (!ownsFileReader()) return;
    const trigger = scopedFileReader?.trigger;
    setFileOpenedFor(null);
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
    {scopedFileReader ? <PublishedFileReader file={scopedFileReader.file} opened={scopedFileReader === fileOpenedFor} onClose={closeFileReader} onExitTransitionEnd={finishFileReader} /> : null}
  </>;
}
