import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ThinkingContent, MarkdownContent } from "./timeline-content";
import { ToolCard, ToolGroupCard } from "./tool-card";
import { ToolReader } from "./tool-reader";
import { PublishedFileReader } from "./published-file-reader";
import { usePublishedFilesView } from "./published-files-context";
import type { PublishedFileRead } from "./published-file";
import type { PublishedFileDescriptor } from "@pi-reach/protocol/session";
import { entryGroupId, gapEntryKeys, isPiOutputEntry, projectTimeline, type PresentationEntry, type PresentationSnapshot, type TextEntry, type ToolEntry } from "@/lib/pwa/timeline-presentation";
import { isPartialEntry, observeTools, segmentExpansion, timelineActivity, toolSegments, withExpansion, type ToolExpansion, type ToolSegment } from "./tool-groups";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useDelayedVisibility } from "./use-delayed-visibility";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";

type ConversationTimelineProps = {
  items: readonly TimelineViewItem[];
  live: boolean;
  /** 每一轮的结束时间与状态（来自 run_end，缺失时按降级规则推断）。 */
  completions?: ReadonlyMap<string, RunCompletion>;
  /** 在线 Pi 正在运行（working）：末尾没有正在输出的内容时显示「Working…」。 */
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
/** 两段输出之间（如正文结束、下一个工具尚未开始）延迟显示 Working，避免交接瞬间闪现。 */
const WORKING_BETWEEN_OUTPUTS_DELAY_MS = 400;

/** 投影快照与工具首次被观察到的顺序；后者决定工具组身份，历史补齐不改变已有组。 */
type TimelineState = { view: PresentationSnapshot; observed: ReadonlyMap<string, number> };

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
  const [timeline, setTimeline] = useState<TimelineState>(() => ({ view: projectTimeline([]), observed: new Map() }));
  let { view, observed } = timeline;
  if (view.items !== items) {
    view = projectTimeline(items, timeline.view);
    observed = observeTools(view.entries, timeline.observed);
    setTimeline({ view, observed });
  }
  const gapKeys = gapBefore.size === 0 ? NO_GAPS : gapEntryKeys(items, gapBefore);
  const segments = toolSegments(view.entries, gapKeys, observed);
  const segmentOf = new Map<string, ToolSegment>();
  for (const segment of segments) for (const tool of segment.tools) segmentOf.set(tool.key, segment);
  return { view, gapKeys, segments, segmentOf };
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
  const [reader, setReader] = useState<string | null>(null);
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

  const { view, gapKeys, segments, segmentOf } = useProjectedTimeline(items, gapBefore);
  const readerValue = reader ? view.entries.find((entry): entry is ToolEntry => entry.kind === "tool" && entry.key === reader)?.value ?? null : null;
  const idlePartials = useIdlePartials(view.entries, live && !running);
  const activity = timelineActivity(view.entries, live, running, groupId => completions?.has(groupId) === true, idlePartials);
  // 展开的思考与工具组暂停行内自动跟随；末段运行中展开的工具组除外。工具详情由 Reader 独立持锁。
  const readingInline = (tools: ReadonlyMap<string, ToolExpansion>, thinking: ReadonlyMap<string, boolean>) => segments.some((segment) => {
    const choice = segmentExpansion(segment.tools, tools);
    return choice?.expanded === true && !choice.follow;
  }) || view.entries.some(entry => entry.kind === "thinking" && thinking.get(entry.key) === true);
  // 历史窗口替换可能移除阅读内容；阅读锁随可见内容同步，并保留到 Reader 退出结束。
  const reading = reader !== null || scopedFileReader !== null || readingInline(toolChoices, thinkingChoices);
  useEffect(() => { onReadingChange?.(reading); fileReadingChange?.(reading); }, [onReadingChange, fileReadingChange, reading]);
  useEffect(() => () => { onReadingChange?.(false); fileReadingChange?.(false); }, [onReadingChange, fileReadingChange]);

  const notifyReading = (tools: ReadonlyMap<string, ToolExpansion>, thinking: ReadonlyMap<string, boolean>) => {
    onReadingChange?.(reader !== null || scopedFileReader !== null || readingInline(tools, thinking));
  };
  const chooseThinking = (key: string, expanded: boolean) => {
    const choices = new Map(thinkingChoices).set(key, expanded);
    setThinkingChoices(choices);
    notifyReading(toolChoices, choices);
  };
  // 选择记在组内全部成员上；是否跟随在展开时确定，之后不随运行状态变化。
  const chooseSegment = (segment: ToolSegment, expanded: boolean) => {
    const choices = withExpansion(toolChoices, segment.tools.map(tool => tool.key), expanded, activity.liveTail(segment));
    setToolChoices(choices);
    notifyReading(choices, thinkingChoices);
  };
  const openReader = (key: string, trigger: HTMLButtonElement) => {
    if (scopedFileReader !== null) return;
    setReaderOrigin(trigger);
    onReadingChange?.(true);
    setReader(key);
    setReaderOpen(true);
  };
  const finishReader = () => {
    setReaderOpen(false);
    setReader(null);
    setReaderOrigin(null);
    // 背景位置由时间线锚点持续维护，退出时只回焦，避免旧 scrollTop 覆盖补偿；来源行已不在时回焦到列表。
    if (readerValue !== null && readerOrigin?.isConnected && readerOrigin.getClientRects().length > 0) {
      readerOrigin.focus({ preventScroll: true });
    } else {
      listRef.current?.focus({ preventScroll: true });
    }
    onReadingChange?.(readingInline(toolChoices, thinkingChoices));
  };

  const openFileReader: PublishedFileRead = (file, trigger) => {
    if (!files || reader !== null || scopedFileReader !== null) return;
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
        expanded={thinkingChoices.get(entry.key) ?? false}
        onExpandedChange={expanded => chooseThinking(entry.key, expanded)}
      />;
      return <ToolCard
        key={entry.key}
        value={entry.value}
        status={"partial_id" in entry.value && !live ? "unknown" : undefined}
        onRead={trigger => openReader(entry.key, trigger)}
      />;
  };
  const renderSegment = (segment: ToolSegment) => <ToolGroupCard
    key={segment.key}
    values={segment.tools.map(tool => tool.value)}
    live={live}
    // 视口锚点用它在重新挂载后找回工具组；取第一条工具，内容相同时与观察顺序无关。
    timelineKey={`tools:${segment.tools[0]!.key}`}
    expanded={segmentExpansion(segment.tools, toolChoices)?.expanded ?? false}
    onExpandedChange={expanded => chooseSegment(segment, expanded)}
  >{segment.tools.map(renderEntry)}</ToolGroupCard>;
  // 发布记录保留 group_id，同一轮的完成时间仍只在段末追加一次。
  const rows = conversationRows(view.entries, completions, segmentOf, gapKeys, renderSegment, renderEntry);
  // 本轮尚无输出时立即显示 Working；两段输出之间延迟显示。
  const workingBetweenOutputs = useDelayedVisibility(activity.working && activity.hasOutput, WORKING_BETWEEN_OUTPUTS_DELAY_MS, 0);
  const showWorking = activity.working && (!activity.hasOutput || workingBetweenOutputs);

  return <>
    {rows}
    {gapAtEnd ? <GapNotice /> : null}
    {showWorking ? <WorkingStatus /> : null}
    <ToolReader value={readerValue} opened={readerOpen && readerValue !== null} onClose={() => setReaderOpen(false)} onExitTransitionEnd={finishReader} />
    {scopedFileReader ? <PublishedFileReader file={scopedFileReader.file} opened={scopedFileReader === fileOpenedFor} onClose={closeFileReader} onExitTransitionEnd={finishFileReader} /> : null}
  </>;
}
