import { useState } from "react";
import { Button } from "@mantine/core";
import { MessageComposer } from "@/components/pwa/message-composer";
import { MessageList } from "@/components/pwa/message-list";
import { PwaMessageActions } from "@/components/pwa/pwa-app-actions";
import { useTimelineViewport } from "@/lib/pwa/use-timeline-viewport";
import type { TimelinePending, TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { UI_REVIEW_MODELS } from "./ui-review-fixtures";
import { REVIEW_CURRENT_CURVE, REVIEW_MOTION_OPTIONS, REVIEW_MOTION_PRESETS, reviewPresetDuration, type ReviewMotionPresetId } from "./review-motion-presets";
import { PWA_MOTION_FALLBACK_MS, type PwaMotionDurationToken } from "@/lib/ui/motion-duration";

const base = { session_id: "ui-motion", leaf_id: "leaf", timestamp: 1 };
const noop = () => {};

function user(id: string, text: string, group: string): TimelineViewItem {
  return { kind: "event", event: { ...base, group_id: group, event_id: id, kind: "user", message_id: id, blocks: [{ type: "text", text }], origin: "pwa", sender_ref: "gallery-owner", delivery: "normal", status: "committed" } };
}
function reply(id: string, text: string, group: string): TimelineViewItem {
  return { kind: "event", event: { ...base, group_id: group, event_id: id, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] } };
}
function thinking(group: string, thought: string): TimelineViewItem {
  return { kind: "event", event: { ...base, group_id: group, event_id: `${group}-answer`, kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: thought }] } };
}
function tool(group: string, running: boolean): TimelineViewItem {
  const args = { command: "pnpm typecheck" };
  const output = "演示工具输出：未执行命令。\n";
  return running
    ? { kind: "partial", createdAt: 3, partial: { protocol_version: 2, type: "timeline_partial", ...base, group_id: group, partial_id: `tool:${group}-check`, kind: "tool", tool_call_id: `${group}-check`, tool: "bash", args, status: "running", blocks: [{ type: "text", text: output }] } }
    : { kind: "event", event: { ...base, group_id: group, event_id: `${group}-result`, kind: "tool", tool_call_id: `${group}-check`, tool: "bash", args, status: "complete", truncated: false, result: { content: [{ type: "text", text: output + "检查完成。" }] } } };
}
function runEnd(group: string): TimelineViewItem {
  return { kind: "event", event: { ...base, group_id: group, event_id: `${group}-end`, kind: "run_end", status: "complete", timestamp: 1000 } };
}

const THOUGHT = "**核对过渡参数**\n\n比较现行与候选取值在同一操作下的观感。";
function initialItems(): TimelineViewItem[] {
  return [
    user("intro-ask", "帮我检查一下发送和过程组的过渡。", "intro"),
    thinking("intro", THOUGHT), tool("intro", false),
    reply("intro-reply", "已完成检查。点击上方过程组的组头，可以比较手动展开与收起。", "intro"), runEnd("intro"),
    user("send-ask", "发送消息时，气泡从下方进入，输入区同时回缩。", "send"),
    reply("send-reply", "在下方输入框发送消息即可比较；「推进回复」逐步演示思考、工具与正文接续时的自动收起。", "send"), runEnd("send"),
  ];
}

/** 推进回复的下一步说明，与 advance 的阶段一一对应。 */
const RUN_STEPS = ["思考开始", "思考完成 · 工具运行", "正文接续 · 自动收起", "本轮结束"];

function advance(items: TimelineViewItem[], group: string, phase: number): TimelineViewItem[] {
  if (phase === 0) return [...items, { kind: "partial", createdAt: 2, partial: { protocol_version: 2, type: "timeline_partial", ...base, group_id: group, partial_id: `${group}-answer:thinking:0`, kind: "thinking", status: "delta", delta: THOUGHT } }];
  if (phase === 1) return [...items.map(item => item.kind === "partial" && item.partial.partial_id === `${group}-answer:thinking:0` ? thinking(group, THOUGHT) : item), tool(group, true)];
  if (phase === 2) return [...items.map(item => item.kind === "partial" && item.partial.partial_id === `tool:${group}-check` ? tool(group, false) : item), reply(`${group}-reply`, "检查完成：过程组在正文接续后自动收起。", group)];
  return [...items, runEnd(group)];
}

/** 当前参数一览；只列出对比项覆盖的 token，其余保持主题值。 */
const COMPARED_TOKENS = Object.keys(REVIEW_MOTION_PRESETS.previous.durations) as PwaMotionDurationToken[];
const CURRENT_SHIFTS = "12 / 12 / 8px";

export function UiStateMotionParams({ preset }: { preset: ReviewMotionPresetId }) {
  const columns = REVIEW_MOTION_OPTIONS;
  const durationOf = (id: ReviewMotionPresetId, token: PwaMotionDurationToken) => (id === "current" ? undefined : reviewPresetDuration(id, token)) ?? PWA_MOTION_FALLBACK_MS[token];
  const shiftsOf = (id: ReviewMotionPresetId) => {
    const shifts = id === "current" ? {} : REVIEW_MOTION_PRESETS[id].shifts;
    return Object.keys(shifts).length === 0 ? CURRENT_SHIFTS : `${Object.values(shifts).join(" / ")}px`;
  };
  const cell = (id: ReviewMotionPresetId, value: string) => <td key={id} data-active={id === preset || undefined}>{value}</td>;
  return <details className="pwa-ui-states-coverage pwa-ui-states-motion-scroll">
    <summary>参数对照</summary>
    <table className="pwa-ui-states-motion-params">
      <thead><tr><th>token</th>{columns.map(column => <th key={column.value} data-active={column.value === preset || undefined}>{column.label}</th>)}</tr></thead>
      <tbody>
        {COMPARED_TOKENS.map(token => <tr key={token}><td>{token.replace("--pwa-duration-", "")}</td>{columns.map(column => cell(column.value, `${durationOf(column.value, token)}ms`))}</tr>)}
        <tr><td>内容曲线</td>{columns.map(column => cell(column.value, column.value === "current" ? REVIEW_CURRENT_CURVE : REVIEW_MOTION_PRESETS[column.value].curve))}</tr>
        <tr><td>位移 overlay / message / collapse</td>{columns.map(column => cell(column.value, shiftsOf(column.value)))}</tr>
      </tbody>
    </table>
    <p>退出曲线与操作反馈（按压、菜单、复制）在各列保持现行值；P2／P3 的自动收起使用对称缓入缓出曲线。</p>
  </details>;
}

/** 发送与过程组的动效对比；只改内存数据，发送顺序与正式应用一致。 */
export function UiStateMotionWorkspace() {
  const [items, setItems] = useState(initialItems);
  const [draft, setDraft] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [run, setRun] = useState<{ group: string; phase: number } | null>(null);
  const [runs, setRuns] = useState(0);
  const [sent, setSent] = useState(0);
  const viewport = useTimelineViewport(items);
  const running = run !== null;
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const id = `motion-send-${sent}`;
    const pending: TimelinePending = { kind: "pending", id, clientRequestId: id, requestId: id, createdAt: Date.now(), text, delivery: "pending" };
    // 与 submitMessage 相同：先捕获可见几何，再在同一批提交中加入气泡并清空草稿。
    viewport.followOwnSend(viewport.captureOwnSend());
    setItems(current => [...current, pending]);
    setSent(value => value + 1);
    setDraft("");
  };
  const step = () => {
    const current = run ?? { group: `run-${runs}`, phase: 0 };
    setItems(value => advance(value, current.group, current.phase));
    if (current.phase === RUN_STEPS.length - 1) {
      setRun(null);
      setRuns(value => value + 1);
      return;
    }
    setRun({ group: current.group, phase: current.phase + 1 });
  };
  const reset = () => {
    setItems(initialItems());
    setRun(null);
    setDraft("");
    setEpoch(value => value + 1);
  };
  return <>
    <div className="pwa-ui-states-actions">
      <Button variant="default" onClick={step}>推进回复 · {RUN_STEPS[run?.phase ?? 0]}</Button>
      <Button variant="default" onClick={reset}>重置对话</Button>
      <span role="status">{running ? `第 ${(run?.phase ?? 0)}/${RUN_STEPS.length} 步完成` : "发送消息或推进回复；不连接 Pi。"}</span>
    </div>
    <div className="pwa-workspace-body"><div className="pwa-workspace-column">
      <MessageList sourceKey={`gallery-motion:${epoch}`} items={items} hasEarlier={false} running={running} isLive
        onRetryFailed={noop} onCheckStatus={noop} onCancelQueued={noop}
        listRef={viewport.messageListRef} bottomSentinelRef={viewport.bottomSentinelRef}
        onScroll={viewport.handleScroll} onReadingChange={viewport.setReadingDetails} />
      <div className="pwa-chat-footer">
        <PwaMessageActions show={!viewport.followingOutput} showLatest={!viewport.followingOutput} showRetry={false} unreadOutput={viewport.unreadOutput} onRetry={noop} onLatest={viewport.showLatest} />
        <MessageComposer enterSends={true} draft={draft} onDraftChange={setDraft} attachmentNotice={null}
          attachments={[]} canAttach={false} sendingAttachments={false}
          isOnline={true} isWorking={false} stopping={false}
          onSend={send} onStop={noop} onAddFiles={noop} onRemoveAttachment={noop} onRetryAttachment={noop}
          commandModels={UI_REVIEW_MODELS} commandModelsStatus="success" commandCurrentModel={UI_REVIEW_MODELS[0]} commandCurrentModelFallback={null}
          commandThinking="medium" commandPendingAction={null} onSetModel={noop} onSetThinking={noop} onCommandsOpen={noop}
          onNewSession={noop} onCompactSession={noop} />
      </div>
    </div></div>
  </>;
}
