import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ThinkingContent, MarkdownContent } from "./timeline-content";
import { initialToolGroupRunningIndicators, ToolCard, ToolGroupCard } from "./tool-card";
import { ToolReader } from "./tool-reader";
import { SummaryEntry, SummaryReader } from "./summary-reader";
import { isSummaryEvent } from "./summary-presentation";
import { PublishedFileReader } from "./published-file-reader";
import { usePublishedFilesView } from "./published-files-context";
import { useWorkPanel } from "./work-panel-layout";
import { readerFocusable, useReaderIntent } from "./use-work-panel-reader";
import type { PublishedFileRead } from "./published-file";
import type { PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { entryGroupId, projectTimelineGaps, isPiOutputEntry, projectTimeline, type PresentationEntry, type PresentationSnapshot, type TextEntry, type ToolEntry } from "@/lib/pwa/timeline-presentation";
import { appendedTools, isPartialEntry, observeTools, segmentExpansion, timelineActivity, toolBatchClosed, toolSegments, withExpansion, type ToolExpansion, type ToolSegment } from "./tool-groups";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

type ConversationTimelineProps = {
  items: readonly TimelineViewItem[];
  live: boolean;
  /** 每一轮的结束时间与状态（来自 run_end，缺失时按降级规则推断）。 */
  completions?: ReadonlyMap<string, RunCompletion>;
  /** 在线 Pi 正在运行（working）：本轮没有具体运行指示时显示「Working…」。 */
  running?: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  onReadingChange?: (reading: boolean) => void;
  renderRecord: (item: TimelineViewItem, onRead: PublishedFileRead) => ReactNode;
  /** 这些正式事件之前缺少记录，在对应条目前显示一行说明。 */
  gapBefore?: ReadonlySet<string>;
  /** 最后一处缺口之后没有可见条目，在时间线末尾显示说明。 */
  gapAtEnd?: boolean;
};

const NO_GAPS: ReadonlySet<string> = new Set();
/**
 * 投影快照、工具首次被观察到的顺序（决定工具组身份，历史补齐不改变已有组），以及最近一次更新中在线新追加的工具（进入组头排队）。
 * `appended` 只保留最近一次更新的新增，不累计：组之后被拆分或合并而重新挂载时，已在组头显示过的工具不会再次排队。
 */
type TimelineState = { view: PresentationSnapshot; observed: ReadonlyMap<string, number>; appended: ReadonlySet<string> };

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

function WorkingStatus() {
  const { t } = useI18n();
  return <p className="pwa-thinking-status" role="status"><LoaderCircle className="pwa-spin" size={16} aria-hidden="true" />{t.timeline.working}</p>;
}

export function GapNotice() {
  const { t } = useI18n();
  return <p className="pwa-timeline-notice pwa-timeline-gap">{t.timeline.gapNotSaved}</p>;
}

function conversationRows(entries: readonly PresentationEntry[], completions: ConversationTimelineProps["completions"], segmentOf: Map<string, ToolSegment>, gapKeys: ReadonlySet<string>, renderSegment: (segment: ToolSegment) => ReactNode, render: (entry: PresentationEntry) => ReactNode) {
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
    if (gapKeys.has(entry.key)) rows.push(<GapNotice key={`gap:${entry.key}`} />);
    const segment = segmentOf.get(entry.key);
    if (segment !== undefined) {
      if (segment.tools[0]!.key === entry.key) rows.push(renderSegment(segment));
      continue;
    }
    rows.push(render(entry));
  }
  closeSegment();
  return rows;
}

/** 投影时间线并划分工具段；工具的首次观察顺序随投影一起保存，决定工具组身份。 */
function useProjectedTimeline(items: readonly TimelineViewItem[], gapBefore: ReadonlySet<string>) {
  const [timeline, setTimeline] = useState<TimelineState>(() => ({ view: projectTimeline([]), observed: new Map(), appended: new Set() }));
  let { view, observed, appended } = timeline;
  if (view.items !== items) {
    view = projectTimeline(items, timeline.view);
    observed = observeTools(view.entries, timeline.observed);
    appended = new Set(appendedTools(view.entries, timeline.view.entries));
    setTimeline({ view, observed, appended });
  }
  const projectedGaps = gapBefore.size === 0 ? { keys: NO_GAPS, toolBreakKeys: NO_GAPS, atEnd: false } : projectTimelineGaps(items, gapBefore, view.entries);
  const gapKeys = projectedGaps.keys;
  const segments = toolSegments(view.entries, new Set([...gapKeys, ...projectedGaps.toolBreakKeys]), observed);
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

export function ConversationTimeline({ items, live, completions, running = false, listRef, onReadingChange, renderRecord, gapBefore = NO_GAPS, gapAtEnd = false }: ConversationTimelineProps) {
  const [thinkingChoices, setThinkingChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
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
  const [reader, setReader] = useState<string | null>(null);
  const panel = useWorkPanel();
  const { changeSelection, acceptsSelection } = useReaderIntent();
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerOrigin, setReaderOrigin] = useState<HTMLButtonElement | null>(null);
  const [summaryReader, setSummaryReader] = useState<{ key: string; sessionId: string; trigger: HTMLButtonElement } | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
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

  const { view, gapKeys, projectedGapAtEnd, segments, segmentOf, appended } = useProjectedTimeline(items, gapBefore);
  const readerValue = reader ? view.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.key === reader)?.value ?? null : null;
  const summaryItem = summaryReader ? view.entries.find(entry => entry.kind === "record" && entry.key === summaryReader.key) : null;
  const summaryEvent = summaryItem?.kind === "record" && summaryItem.item.kind === "event" && summaryItem.item.event.session_id === summaryReader?.sessionId && isSummaryEvent(summaryItem.item.event) ? summaryItem.item.event : null;
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
  // 手动展开思考与工具组都暂停自动跟随，保持当前阅读位置。
  const readingInline = (tools: ReadonlyMap<string, ToolExpansion>, thinking: ReadonlyMap<string, boolean>) => segments.some((segment) => {
    const choice = segmentExpansion(segment.tools, tools);
    return choice?.expanded === true;
  }) || view.entries.some(entry => entry.kind === "thinking" && thinking.get(entry.key) === true);
  // 历史窗口替换可能移除阅读内容；阅读锁随可见内容同步，并保留到 Reader 退出结束。
  const reading = reader !== null || summaryReader !== null || scopedFileReader !== null || readingInline(toolChoices, thinkingChoices);
  useEffect(() => { onReadingChange?.(reading); fileReadingChange?.(reading); }, [onReadingChange, fileReadingChange, reading]);
  useEffect(() => () => { onReadingChange?.(false); fileReadingChange?.(false); }, [onReadingChange, fileReadingChange]);

  const notifyReading = (tools: ReadonlyMap<string, ToolExpansion>, thinking: ReadonlyMap<string, boolean>) => {
    onReadingChange?.(reader !== null || summaryReader !== null || scopedFileReader !== null || readingInline(tools, thinking));
  };
  const chooseThinking = (key: string, expanded: boolean) => {
    const choices = new Map(thinkingChoices).set(key, expanded);
    setThinkingChoices(choices);
    notifyReading(toolChoices, choices);
  };
  // 选择记在组内全部成员上，分组拆分后仍保留用户的阅读选择。
  const chooseSegment = (segment: ToolSegment, expanded: boolean) => {
    const choices = withExpansion(toolChoices, segment.tools.map(tool => tool.key), expanded);
    setToolChoices(choices);
    notifyReading(choices, thinkingChoices);
  };
  const replacePanel = panel?.canSplit === true && summaryReader === null
    && (scopedFileReader === null || files?.getState(scopedFileReader.file.publication_id)?.preview?.kind === "text");
  const clearOtherReaders = () => {
    changeSelection();
    setReader(null);
    setReaderOpen(false);
    setReaderOrigin(null);
    setFileReader(null);
    setFileOpenedFor(null);
  };
  const restoreReadingFocus = (trigger: HTMLButtonElement | null | undefined) => {
    const active = document.activeElement;
    if (readerFocusable(active) && !active.closest(".pwa-reader-portal, .pwa-file-reader")) return;
    if (readerFocusable(trigger)) trigger.focus({ preventScroll: true });
    else listRef.current?.focus({ preventScroll: true });
  };
  const openReader = (key: string, trigger: HTMLButtonElement) => {
    if ((scopedFileReader !== null || summaryReader !== null) && !replacePanel) return;
    clearOtherReaders();
    setReaderOrigin(trigger);
    onReadingChange?.(true);
    setReader(key);
    setReaderOpen(true);
  };
  const finishReader = () => {
    if (reader === null) return;
    changeSelection();
    setReaderOpen(false);
    setReader(null);
    setReaderOrigin(null);
    // 退出只回焦失效的阅读器焦点，不覆盖用户已在输入区等位置的焦点。
    restoreReadingFocus(readerValue !== null ? readerOrigin : null);
    onReadingChange?.(readingInline(toolChoices, thinkingChoices));
  };

  const openSummaryReader = (key: string, sessionId: string, trigger: HTMLButtonElement) => {
    if ((reader !== null || scopedFileReader !== null || summaryReader !== null) && !replacePanel) return;
    clearOtherReaders();
    onReadingChange?.(true);
    setSummaryReader({ key, sessionId, trigger });
    setSummaryOpen(true);
  };
  const finishSummaryReader = () => {
    const trigger = summaryReader?.trigger;
    changeSelection();
    setSummaryOpen(false);
    setSummaryReader(null);
    // 不覆盖退出期间用户主动转移到其他有效控件的焦点。
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement || !active.isConnected || active.closest("[role='dialog']")) {
      if (summaryEvent && trigger?.isConnected && trigger.getClientRects().length > 0 && !trigger.closest("[inert], [aria-hidden='true']") && !trigger.disabled) trigger.focus({ preventScroll: true });
      else listRef.current?.focus({ preventScroll: true });
    }
    onReadingChange?.(readingInline(toolChoices, thinkingChoices));
  };

  const openFileReader: PublishedFileRead = (file, trigger) => {
    // acquire 的 await 捕获本次选择；旧文件迟到完成不能抢走后来主动选择的详情。
    if (!files || !acceptsSelection() || ((reader !== null || summaryReader !== null || scopedFileReader !== null) && !replacePanel)) return;
    clearOtherReaders();
    const next = { file, trigger, scopeToken: files.scopeToken };
    // 阅读器随 opened=true 一起挂载时 Mantine 的过渡初始即“已进入”，不播放进入动画；
    // 先以收起态挂载，下一帧再打开。期间被关闭或换目标则放弃。
    // 首次查看在获取完成的 await 之后调用，已脱离点击事件；须同步提交挂载，否则帧到期时打开会与挂载合并。
    flushSync(() => setFileReader(next));
    requestAnimationFrame(() => setFileOpenedFor(next));
  };
  // 旧退出/关闭回调不能碰新的阅读器；门面 getter 也能识别尚未提交 render 的 reset。
  const ownsFileReader = () => scopedFileReader !== null && currentFileReader.current === scopedFileReader
    && files?.scopeToken === scopedFileReader.scopeToken;
  const closeFileReader = () => { if (ownsFileReader()) setFileOpenedFor(null); };
  const finishFileReader = () => {
    if (!ownsFileReader()) return;
    const trigger = scopedFileReader?.trigger;
    changeSelection();
    setFileOpenedFor(null);
    setFileReader(null);
    restoreReadingFocus(trigger);
  };
  const renderEntry = (entry: PresentationEntry) => {
      if (entry.kind === "record") {
        if (entry.item.kind === "event" && isSummaryEvent(entry.item.event)) {
          const event = entry.item.event;
          return <SummaryEntry key={entry.key} event={event} onRead={trigger => openSummaryReader(entry.key, event.session_id, trigger)} />;
        }
        return <Fragment key={entry.key}>{renderRecord(entry.item, openFileReader)}</Fragment>;
      }
      if (entry.kind === "text") return <TextRow entry={entry} key={entry.key} />;
      if (entry.kind === "thinking") return <ThinkingContent
        key={entry.key}
        timelineKey={entry.key}
        text={entry.text}
        streaming={entry.streaming}
        thinkingTextEpoch={entry.thinkingTextEpoch}
        expanded={thinkingChoices.get(entry.key) ?? false}
        onExpandedChange={expanded => chooseThinking(entry.key, expanded)}
      />;
      return <ToolCard
        key={entry.key}
        value={entry.value}
        readerModal={panel?.canSplit !== true}
        status={"partial_id" in entry.value && !live ? "unknown" : undefined}
        onRead={trigger => openReader(entry.key, trigger)}
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
  const rows = conversationRows(view.entries, completions, segmentOf, gapKeys, renderSegment, renderEntry);

  return <>
    {rows}
    {gapAtEnd || projectedGapAtEnd ? <GapNotice /> : null}
    {activity.working && !thinkingActive && !toolsActive ? <WorkingStatus /> : null}
    <ToolReader value={readerValue} opened={readerOpen && readerValue !== null} onClose={() => setReaderOpen(false)} onExitTransitionEnd={finishReader} />
    <SummaryReader event={summaryEvent} opened={summaryOpen && summaryEvent !== null} onClose={() => setSummaryOpen(false)} onExitTransitionEnd={finishSummaryReader} />
    {scopedFileReader ? <PublishedFileReader key={scopedFileReader.file.publication_id} file={scopedFileReader.file} source={scopedFileReader.trigger} opened={scopedFileReader === fileOpenedFor} onClose={closeFileReader} onExitTransitionEnd={finishFileReader} /> : null}
  </>;
}
