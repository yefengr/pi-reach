import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ThinkingContent, MarkdownContent } from "./timeline-content";
import { useStreamRevealAnimation, useStreamRevealMarks } from "./use-stream-reveal";
import { initialToolGroupRunningIndicators, ToolCard, ToolGroupCard } from "./tool-card";
import { ToolReader } from "./tool-reader";
import { ThinkingReader } from "./thinking-reader";
import { effectiveProcessStatus } from "./timeline-activity";
import type { ProcessEntry } from "./process-groups";
import { SummaryEntry, SummaryReader } from "./summary-reader";
import { isSummaryEvent } from "./summary-presentation";
import { PublishedFileReader } from "./published-file-reader";
import { usePublishedFilesView } from "./published-files-context";
import { readerFocusable, useReaderIntent, useReaderSelection, type ProcessReaderSelection } from "./reader-shared";
import type { PublishedFileRead } from "./published-file";
import { fileKey, type FileSourceDescriptor } from "@/lib/pwa/file-source";
import { entryGroupId, projectTimelineGaps, isPiOutputEntry, projectTimeline, type PresentationEntry, type PresentationSnapshot, type TextEntry } from "@/lib/pwa/timeline-presentation";
import { appendedTools, isPartialEntry, observeTools, segmentExpansion, timelineActivity, toolBatchClosed, toolSegments, withExpansion, type ToolExpansion, type ToolSegment } from "./tool-groups";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import type { CompactionNotice } from "@/lib/pwa/operation-feedback";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { TIMELINE_GEOMETRY_EVENT } from "@/lib/pwa/use-timeline-viewport";

type ConversationTimelineProps = {
  items: readonly TimelineViewItem[];
  live: boolean;
  /** 每一轮的结束时间与状态，仅来自正式 run_end。 */
  completions?: ReadonlyMap<string, RunCompletion>;
  /** 在线 Pi 正在运行（working）：本轮没有具体运行指示时显示「Working…」。 */
  running?: boolean;
  /** 压缩上下文进行中：本轮没有具体运行指示时在末尾显示压缩状态。 */
  compacting?: boolean;
  /** 压缩终态提示，按 afterSeq 插在对应记录之后。 */
  notices?: readonly CompactionNotice[];
  listRef: RefObject<HTMLDivElement | null>;
  onReadingChange?: (reading: boolean) => void;
  renderRecord: (item: TimelineViewItem, onRead: PublishedFileRead, userMessageIn: boolean, timelineKey: string) => ReactNode;
  /** 列表由空态进入首条本端 pending；初次加载已有内容不播放。 */
  enterInitialPending?: boolean;
  /** 这些正式事件之前缺少记录，在对应条目前显示一行说明。 */
  gapBefore?: ReadonlySet<string>;
  /** 最后一处缺口之后没有可见条目，在时间线末尾显示说明。 */
  gapAtEnd?: boolean;
};

const NO_GAPS: ReadonlySet<string> = new Set();
const NO_NOTICES: readonly CompactionNotice[] = [];
/**
 * 投影快照、工具首次被观察到的顺序（决定工具组身份，历史补齐不改变已有组），以及最近一次更新中在线新追加的工具（进入组头排队）。
 * `appended` 只保留最近一次更新的新增，不累计：组之后被拆分或合并而重新挂载时，已在组头显示过的工具不会再次排队。
 */
type TimelineState = { view: PresentationSnapshot; observed: ReadonlyMap<string, number>; appended: ReadonlySet<string> };

/** Pi 回复靠左占满阅读列、无底色；不显示发送方，只为读屏保留「Pi：」。 */
function TextRow({ entry }: { entry: TextEntry }) {
  const { t } = useI18n();
  const row = useRef<HTMLElement | null>(null);
  // 流式新显示的文字淡入；正式版本接管后不再新增片段，已开始的淡入原位完成。
  const reveal = useStreamRevealMarks(entry.text, entry.streaming);
  useStreamRevealAnimation(row, reveal);
  return <article ref={row} className={`pwa-message assistant${entry.streaming ? " partial" : ""}`} data-timeline-key={entry.key} data-viewport-row={entry.key} data-viewport-turn={entry.groupId}>
    <span className="pwa-sr-only">{t.timeline.srPi}</span>
    <MarkdownContent text={entry.text} reveal={reveal} />
  </article>;
}

/** 一轮结束后在末尾显示一次完成时间；中断或出错时附状态。 */
function TurnMeta({ completion, interrupted, groupId }: { completion: RunCompletion; interrupted: boolean; groupId: string }) {
  const { t, format } = useI18n();
  const status = completion.status === "error" ? t.timeline.turnError : completion.status === "interrupted" || interrupted ? t.timeline.turnInterrupted : null;
  return <p className="pwa-turn-meta" data-viewport-completion={groupId}><time className="pwa-tabular" dateTime={new Date(completion.timestamp).toISOString()}>{format.time(completion.timestamp)}</time>{status ? <span className={completion.status === "error" ? "pwa-turn-status-error" : "pwa-turn-status"}> · {status}</span> : null}</p>;
}

function WorkingStatus() {
  const { t } = useI18n();
  return <p className="pwa-thinking-status" role="status"><LoaderCircle className="pwa-spin" size={16} aria-hidden="true" /><span className="pwa-working-label">{t.timeline.working}</span></p>;
}

/** 压缩进行中沿用 Working 行的高度与字号，避免与终态切换时跳动。 */
export function CompactionStatus() {
  const { t } = useI18n();
  return <p className="pwa-thinking-status pwa-compaction-status" role="status"><LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />{t.operationFeedback.compacting}</p>;
}

/** 压缩终态是本地提示，不是会话记录；文案按当前语言渲染，切换语言即时生效。 */
export function CompactionNoticeRow({ notice }: { notice: CompactionNotice }) {
  const { t } = useI18n();
  const text = notice.kind === "failed" ? t.operationFeedback.compactFailed
    : notice.kind === "cancelled" ? t.operationFeedback.compactCancelled : t.operationFeedback.unknown;
  return <p className={`pwa-compaction-notice${notice.kind === "failed" ? " is-error" : ""}`} role="status">{text}</p>;
}

export function GapNotice() {
  const { t } = useI18n();
  return <p className="pwa-timeline-notice pwa-timeline-gap">{t.timeline.gapNotSaved}</p>;
}

function conversationRows(entries: readonly PresentationEntry[], completions: ConversationTimelineProps["completions"], segmentOf: Map<string, ToolSegment>, gapKeys: ReadonlySet<string>, notices: readonly CompactionNotice[], renderSegment: (segment: ToolSegment) => ReactNode, render: (entry: PresentationEntry) => ReactNode) {
  const rows: ReactNode[] = [];
  // 终态提示是本地行，按发生时的最后一条记录插入；不持久化，也不参与分组与序号。
  const pendingNotices = [...notices].sort((left, right) => left.afterSeq - right.afterSeq);
  let noticeIndex = 0;
  const flushNotices = (beforeSeq: number) => {
    while (noticeIndex < pendingNotices.length && pendingNotices[noticeIndex]!.afterSeq < beforeSeq) {
      const notice = pendingNotices[noticeIndex++]!;
      rows.push(<CompactionNoticeRow key={`compaction:${notice.id}`} notice={notice} />);
    }
  };
  let segmentGroup: string | undefined;
  let hasOutput = false;
  let interrupted = false;
  const closeSegment = () => {
    const completion = segmentGroup === undefined ? undefined : completions?.get(segmentGroup);
    if (segmentGroup !== undefined && completion && hasOutput) rows.push(<TurnMeta key={`turn:${segmentGroup}`} completion={completion} interrupted={interrupted} groupId={segmentGroup} />);
  };
  for (const entry of entries) {
    const groupId = entryGroupId(entry);
    if (groupId !== segmentGroup) {
      closeSegment();
      segmentGroup = groupId;
      hasOutput = false;
      interrupted = false;
    }
    // 先结束上一轮（补上完成时间），再插入发生在两轮之间的本地提示。
    flushNotices(entry.seq ?? Infinity);
    if (isPiOutputEntry(entry)) hasOutput = true;
    if (entry.kind === "text" && entry.interrupted) interrupted = true;
    if (gapKeys.has(entry.key)) rows.push(<GapNotice key={`gap:${entry.key}`} />);
    const segment = segmentOf.get(entry.key);
    if (segment !== undefined) {
      if (segment.tools[0]!.key === entry.key) rows.push(renderSegment(segment));
      continue;
    }
    rows.push(render(entry));
  }
  closeSegment();
  flushNotices(Infinity);
  return rows;
}

/** 投影时间线并划分工具段；工具的首次观察顺序随投影一起保存，决定工具组身份。 */
function useProjectedTimeline(items: readonly TimelineViewItem[], gapBefore: ReadonlySet<string>, enterInitialPending: boolean) {
  const [timeline, setTimeline] = useState<TimelineState>(() => {
    const view = projectTimeline(items, enterInitialPending ? projectTimeline([]) : undefined);
    return { view, observed: observeTools(view.entries, new Map()), appended: new Set(appendedTools(view.entries, [])) };
  });
  let { view, observed, appended } = timeline;
  if (view.items !== items) {
    view = projectTimeline(items, timeline.view);
    observed = observeTools(view.entries, timeline.observed);
    appended = new Set(appendedTools(view.entries, timeline.view.entries));
    setTimeline({ view, observed, appended });
  }
  const projectedGaps = gapBefore.size === 0 ? { keys: NO_GAPS, processBreakKeys: NO_GAPS, atEnd: false } : projectTimelineGaps(items, gapBefore, view.entries);
  const gapKeys = projectedGaps.keys;
  const segments = toolSegments(view.entries, new Set([...gapKeys, ...projectedGaps.processBreakKeys]), observed);
  const segmentOf = new Map<string, ToolSegment>();
  for (const segment of segments) for (const tool of segment.tools) segmentOf.set(tool.key, segment);
  return { view, gapKeys, projectedGapAtEnd: projectedGaps.atEnd, segments, segmentOf, appended };
}

/** Pi 空闲期间仍在的 partial 不可能是正在进行的输出；记下它们，供新发送消息后识别旧轮残留。 */
function useIdlePartials(entries: readonly PresentationEntry[], idle: boolean): ReadonlySet<string> {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const additions = idle ? entries.filter(entry => isPartialEntry(entry) && !keys.has(entry.key)) : [];
  if (additions.length > 0) setKeys(new Set([...keys, ...additions.map(entry => entry.key)]));
  return keys;
}

export function ConversationTimeline({ items, live, completions, running = false, compacting = false, notices = NO_NOTICES, listRef, onReadingChange, renderRecord, enterInitialPending = false, gapBefore = NO_GAPS, gapAtEnd = false }: ConversationTimelineProps) {
  const [toolChoices, setToolChoices] = useState<ReadonlyMap<string, ToolExpansion>>(() => new Map());
  const [toolIndicators, setToolIndicators] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const reportToolIndicators = useCallback((key: string, indicators: readonly string[] | null) => {
    setToolIndicators(previous => {
      const known = previous.get(key);
      if (indicators === null ? known === undefined : known?.length === indicators.length && known.every((value, index) => value === indicators[index])) return previous;
      const next = new Map(previous);
      if (indicators === null) next.delete(key);
      else next.set(key, indicators);
      return next;
    });
  }, []);
  const { changeSelection, acceptsSelection } = useReaderIntent();
  const process = useReaderSelection<ProcessReaderSelection>();
  const summary = useReaderSelection<{ key: string; sessionId: string; trigger: HTMLButtonElement }>();
  const file = useReaderSelection<{ file: FileSourceDescriptor; trigger: HTMLButtonElement; scopeToken: object }>();
  const reader = process.state;
  const summaryReader = summary.state;
  const files = usePublishedFilesView();
  const fileReadingChange = files?.onReadingChange;
  const scopedFileReader = file.state?.selection.scopeToken === files?.scopeToken ? file.state : null;
  const currentFileReader = file.current;

  const { view, gapKeys, projectedGapAtEnd, segments, segmentOf, appended } = useProjectedTimeline(items, gapBefore, enterInitialPending);
  const readerEntry = reader ? view.entries.find((entry): entry is ProcessEntry => entry.kind === reader.selection.kind && entry.key === reader.selection.entryKey && (entry.kind !== "thinking" || !!entry.text.trim())) ?? null : null;
  const summaryItem = summaryReader ? view.entries.find(entry => entry.kind === "record" && entry.key === summaryReader.selection.key) : null;
  const summaryEvent = summaryItem?.kind === "record" && summaryItem.item.kind === "event" && summaryItem.item.event.session_id === summaryReader?.selection.sessionId && isSummaryEvent(summaryItem.item.event) ? summaryItem.item.event : null;
  const idlePartials = useIdlePartials(view.entries, live && !running);
  const runEnded = (groupId: string) => completions?.has(groupId) === true;
  const activity = timelineActivity(view.entries, live, running, runEnded, idlePartials);
  const batchClosed = new Map(segments.map(segment => [segment.key, toolBatchClosed(view.entries, segment, runEnded)]));
  const thinkingActive = view.entries.some(entry => entry.kind === "thinking" && activity.currentOutput(entry));
  const toolsActive = segments.some(segment => {
    const indicators = toolIndicators.get(segment.key) ?? initialToolGroupRunningIndicators(
      segment.tools.map(tool => tool.value), live,
    );
    return segment.tools.some(tool => indicators.includes(tool.key) && activity.currentIndicator(tool));
  });
  const workingVisible = !compacting && activity.working && !thinkingActive && !toolsActive;
  const previousWorking = useRef(workingVisible);
  useLayoutEffect(() => {
    if (previousWorking.current === workingVisible) return;
    previousWorking.current = workingVisible;
    const list = listRef.current;
    const working = workingVisible ? list?.querySelector<HTMLElement>(".pwa-working-label")?.parentElement : null;
    let added = 0;
    if (working) {
      const style = getComputedStyle(working);
      const previous = working.previousElementSibling;
      const previousMargin = previous ? Number.parseFloat(getComputedStyle(previous).marginBottom) || 0 : 0;
      // 只在 Working 提交时读取它自己的净占高，包含与上一行折叠后的外边距。
      added = working.getBoundingClientRect().height + (Number.parseFloat(style.marginBottom) || 0)
        + Math.max(0, (Number.parseFloat(style.marginTop) || 0) - previousMargin);
    }
    list?.dispatchEvent(new CustomEvent(TIMELINE_GEOMETRY_EVENT, { detail: { reason: "activity", added } }));
  }, [workingVisible, listRef]);
  // 只有手动展开申请 inline 锁；所有 Reader（含退出中）各自持有锁，不能互相释放。
  const readingInline = segments.some(segment => segmentExpansion(segment.tools, toolChoices)?.expanded === true);
  const reading = reader !== null || summaryReader !== null || scopedFileReader !== null || readingInline;
  const latest = useRef({ segments, segmentOf, entries: view.entries, toolChoices, onReadingChange, fileReadingChange });
  useLayoutEffect(() => { latest.current = { segments, segmentOf, entries: view.entries, toolChoices, onReadingChange, fileReadingChange }; });
  const { holds: processHolds } = process;
  const { holds: summaryHolds } = summary;
  const { holds: fileHolds } = file;
  const notifyReading = useCallback(() => {
    const current = latest.current;
    const held = processHolds() || summaryHolds() || fileHolds()
      || current.segments.some(segment => segmentExpansion(segment.tools, current.toolChoices)?.expanded === true);
    current.onReadingChange?.(held);
    current.fileReadingChange?.(held);
  }, [processHolds, summaryHolds, fileHolds]);
  useEffect(() => { notifyReading(); }, [onReadingChange, fileReadingChange, reading, notifyReading]);
  // 回调更换（如文件 provider 移除）时释放旧回调持有的锁，新回调随后由上一 effect 补发当前状态。
  useEffect(() => () => { onReadingChange?.(false); fileReadingChange?.(false); }, [onReadingChange, fileReadingChange]);

  const restoreReadingFocus = (trigger?: HTMLButtonElement | null, selection?: ProcessReaderSelection) => {
    const active = document.activeElement;
    // 只补救仍留在阅读器内的焦点；上层 Modal 等其他对话框中的有效焦点保持不动。
    if (readerFocusable(active) && !active.closest(".pwa-tool-reader, .pwa-file-reader")) return;
    let target: HTMLElement | null | undefined = trigger;
    if (selection) {
      const current = latest.current;
      const entry = current.entries.find(entry => entry.key === selection.entryKey && entry.kind === selection.kind);
      const segment = current.segmentOf.get(selection.entryKey);
      const expanded = segment && segmentExpansion(segment.tools, current.toolChoices)?.expanded === true;
      // 历史前插可能改变 legacy 根锚点；总是按当前成员重新查组。
      const groupKey = entry?.kind === "thinking" ? entry.key : segment ? `tools:${segment.tools[0]!.key}` : null;
      if (!entry || (selection.kind === "tool" && !expanded) || !readerFocusable(target)) {
        const root = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-timeline-key]") ?? [])].find(node => node.dataset.timelineKey === groupKey);
        target = root?.querySelector<HTMLButtonElement>("button") ?? null;
      }
    }
    if (readerFocusable(target)) target.focus({ preventScroll: true });
    else listRef.current?.focus({ preventScroll: true });
  };
  // 选择记在组内全部成员上，分组拆分后仍保留用户的阅读选择。
  const chooseSegment = (segment: ToolSegment, expanded: boolean) => {
    const choices = withExpansion(latest.current.toolChoices, segment.tools.map(tool => tool.key), expanded);
    latest.current.toolChoices = choices;
    setToolChoices(choices);
    notifyReading();
  };
  const holdsReader = () => process.holds() || summary.holds() || file.holds();
  const captureProcess = (entry: ProcessEntry, trigger: HTMLButtonElement) => {
    if (holdsReader()) return;
    const current = latest.current.entries.find(candidate => candidate.key === entry.key && candidate.kind === entry.kind);
    if (!current || (current.kind === "thinking" && !current.text.trim())) return;
    const segment = latest.current.segmentOf.get(entry.key);
    const groupKey = entry.kind === "thinking" ? entry.key : segment ? `tools:${segment.tools[0]!.key}` : null;
    if (groupKey === null) return;
    if (!process.open({ kind: entry.kind, entryKey: entry.key, groupKey, trigger })) return;
    changeSelection();
    notifyReading();
  };
  const finishReader = (token: object, selection: ProcessReaderSelection) => {
    if (!process.finish(token)) return;
    changeSelection();
    restoreReadingFocus(selection.trigger, selection);
    notifyReading();
  };
  const openSummaryReader = (key: string, sessionId: string, trigger: HTMLButtonElement) => {
    if (holdsReader()) return;
    if (!summary.open({ key, sessionId, trigger })) return;
    changeSelection();
    notifyReading();
  };
  const finishSummaryReader = (token: object, trigger: HTMLButtonElement) => {
    if (!summary.finish(token)) return;
    changeSelection();
    restoreReadingFocus(trigger);
    notifyReading();
  };
  const openFileReader: PublishedFileRead = (descriptor, trigger) => {
    // acquire 的旧选择即使迟到，也不能抢占当前或正在退出的阅读器。
    if (!files || !acceptsSelection() || holdsReader()) return;
    changeSelection();
    // 同步提交后 reading 变为 true，由上报 effect 通知；渲染期传出的回调不读取 ref 快照。
    flushSync(() => file.open({ file: descriptor, trigger, scopeToken: files.scopeToken }));
  };
  const ownsFileReader = () => scopedFileReader !== null && currentFileReader.current?.token === scopedFileReader.token
    && files?.scopeToken === scopedFileReader.selection.scopeToken;
  const closeFileReader = () => { if (ownsFileReader()) file.close(scopedFileReader!.token); };
  const finishFileReader = () => {
    if (!ownsFileReader() || !file.finish(scopedFileReader!.token)) return;
    changeSelection();
    restoreReadingFocus(scopedFileReader!.selection.trigger);
    notifyReading();
  };
  // 来源失效直接卸载；未进入的 Drawer 没有 exit，不等待回调才释放 owner。
  useLayoutEffect(() => {
    let invalidated = false;
    if (reader && readerEntry === null && process.current.current?.token === reader.token) {
      process.reset();
      restoreReadingFocus(null, reader.selection);
      invalidated = true;
    }
    if (summaryReader && summaryEvent === null && summary.current.current?.token === summaryReader.token) {
      summary.reset();
      restoreReadingFocus(null);
      invalidated = true;
    }
    if (file.state && scopedFileReader === null && currentFileReader.current?.token === file.state.token) {
      file.reset();
      restoreReadingFocus(null);
      invalidated = true;
    }
    if (invalidated) { changeSelection(); notifyReading(); }
  });
  const renderEntry = (entry: PresentationEntry) => {
      if (entry.kind === "record") {
        if (entry.item.kind === "event" && isSummaryEvent(entry.item.event)) {
          const event = entry.item.event;
          return <SummaryEntry key={entry.key} timelineKey={entry.key} event={event} onRead={trigger => openSummaryReader(entry.key, event.session_id, trigger)} />;
        }
        return <Fragment key={entry.key}>{renderRecord(entry.item, openFileReader, live && entry.userMessageIn === true, entry.key)}</Fragment>;
      }
      if (entry.kind === "text") return <TextRow entry={entry} key={entry.key} />;
      if (entry.kind === "thinking") return <ThinkingContent
        key={entry.key}
        timelineKey={entry.key}
        text={entry.text}
        streaming={entry.streaming}
        thinkingTextEpoch={entry.thinkingTextEpoch}
        onRead={trigger => captureProcess(entry, trigger)}
      />;
      return <ToolCard
        key={entry.key}
        timelineKey={entry.key}
        value={entry.value}
        status={effectiveProcessStatus(entry, view.entries, activity) as Exclude<ReturnType<typeof effectiveProcessStatus>, "neutral">}
        onRead={trigger => captureProcess(entry, trigger)}
      />;
  };
  const renderSegment = (segment: ToolSegment) => <ToolGroupCard
    key={segment.key}
    values={segment.tools.map(tool => tool.value)}
    live={live}
    appended={appended}
    batchClosed={batchClosed.get(segment.key)}
    // 视口锚点用它在重新挂载后找回工具组；取第一条工具，内容相同时与观察顺序无关。
    timelineKey={`tools:${segment.tools[0]!.key}`}
    activityKey={segment.key}
    onRunningToolsChange={reportToolIndicators}
    expanded={segmentExpansion(segment.tools, toolChoices)?.expanded ?? false}
    onExpandedChange={expanded => chooseSegment(segment, expanded)}
  >{segment.tools.map(renderEntry)}</ToolGroupCard>;
  // 发布记录保留 group_id，同一轮的完成时间仍只在段末追加一次。
  const rows = conversationRows(view.entries, completions, segmentOf, gapKeys, notices, renderSegment, renderEntry);

  return <>
    {rows}
    {gapAtEnd || projectedGapAtEnd ? <GapNotice /> : null}
    {compacting ? <CompactionStatus /> : workingVisible ? <WorkingStatus /> : null}
    {reader && readerEntry?.kind === "tool" ? <ToolReader key={reader.generation} value={readerEntry.value}
      status={effectiveProcessStatus(readerEntry, view.entries, activity) as Exclude<ReturnType<typeof effectiveProcessStatus>, "neutral">}
      opened={reader.opened} onClose={() => process.close(reader.token)} onExitTransitionEnd={() => finishReader(reader.token, reader.selection)} /> : null}
    {reader && readerEntry?.kind === "thinking" ? <ThinkingReader key={reader.generation} entry={readerEntry}
      status={effectiveProcessStatus(readerEntry, view.entries, activity)} opened={reader.opened}
      onClose={() => process.close(reader.token)} onExitTransitionEnd={() => finishReader(reader.token, reader.selection)} /> : null}
    {summaryReader && summaryEvent ? <SummaryReader key={summaryReader.generation} event={summaryEvent} opened={summaryReader.opened}
      onClose={() => summary.close(summaryReader.token)} onExitTransitionEnd={() => finishSummaryReader(summaryReader.token, summaryReader.selection.trigger)} /> : null}
    {scopedFileReader ? <PublishedFileReader key={`${fileKey(scopedFileReader.selection.file)}:${scopedFileReader.generation}`} file={scopedFileReader.selection.file} source={scopedFileReader.selection.trigger} opened={scopedFileReader.opened} onClose={closeFileReader} onExitTransitionEnd={finishFileReader} /> : null}
  </>;
}
