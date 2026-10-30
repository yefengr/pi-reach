import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PresentationEntry } from "@/lib/pwa/timeline-presentation";
import type { RunCompletion } from "@/lib/pwa/run-completion";
import { processExpansion, withProcessExpansion, type ProcessExpansion, type ProcessGroup } from "./process-groups";
import { processGroupState, type ProcessGroupState } from "./process-group-state";
import type { TimelineActivity } from "./timeline-activity";
import type { RunningToolsChange } from "./tool-indicator-visibility";

type ProcessPresentationOptions = {
  groups: readonly ProcessGroup[];
  entries: readonly PresentationEntry[];
  activity: TimelineActivity;
  observed: ReadonlyMap<string, number>;
  completions?: ReadonlyMap<string, RunCompletion>;
  compacting: boolean;
  /** 打开或退出中的过程 Reader 所选成员；所在组暂缓自动收起。 */
  readerEntryKey?: string;
  /** 本地提示（如压缩终态）插入位置；落在末段组之后时是展示边界，该组不再承载 Working。 */
  noticeAfterSeqs?: readonly number[];
};

const sameKeys = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function isLoneEmptyTrace(group: ProcessGroup): boolean {
  const only = group.entries.length === 1 ? group.entries[0]! : null;
  return only?.kind === "thinking" && !only.streaming && !only.text.trim();
}

/** 与行装配一致：提示排在第一条序号大于它的条目之前；末成员序号不大于提示时提示落在组后。 */
function noticeFollows(group: ProcessGroup, afterSeqs: readonly number[]): boolean {
  const seq = group.entries.at(-1)!.seq;
  return seq !== undefined && afterSeqs.some(afterSeq => afterSeq >= seq);
}

/** 组件尚未上报可见性前，按组头与明细会实际绘制的运行图标估计。 */
function renderedRunningKeys(group: ProcessGroup, state: ProcessGroupState): readonly string[] {
  if (state.expanded) return group.entries.filter(entry => state.entryStatuses.get(entry.key) === "running").map(entry => entry.key);
  const active = state.activeEntry;
  return active !== null && state.entryStatuses.get(active.key) === "running" ? [active.key] : [];
}

/**
 * 过程组的展示状态：手动选择按成员记录，默认展开与阅读保护不写入选择；
 * 已建立的展开状态在无新输入时保持，避免短暂离线反复开合。
 * Working 先让位于可见的具体运行图标，再由末段过程组承载，最后才在末尾兜底。
 */
export function useProcessPresentation({ groups, entries, activity, observed, completions, compacting, readerEntryKey, noticeAfterSeqs = [] }: ProcessPresentationOptions) {
  const [choices, setChoices] = useState<ReadonlyMap<string, ProcessExpansion>>(() => new Map());
  const [presented, setPresented] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [focused, setFocused] = useState<ReadonlySet<string>>(() => new Set());
  const [indicators, setIndicators] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const latest = useRef({ groups, choices });
  useLayoutEffect(() => { latest.current = { groups, choices }; });

  const states = new Map<string, ProcessGroupState>();
  const nextPresented = new Map<string, boolean>();
  let presentationChanged = presented.size !== groups.length;
  for (const group of groups) {
    const state = processGroupState(group, {
      entries, activity, observed, choices,
      completion: completions?.get(group.groupId),
      protectedReading: focused.has(group.key) || (readerEntryKey !== undefined && group.entries.some(entry => entry.key === readerEntryKey)),
      previousExpanded: presented.get(group.key),
    });
    states.set(group.key, state);
    nextPresented.set(group.key, state.expanded);
    if (presented.get(group.key) !== state.expanded) presentationChanged = true;
  }
  if (presentationChanged) setPresented(nextPresented);

  const entryByKey = new Map(entries.map(entry => [entry.key, entry]));
  const specificVisible = groups.some(group => {
    const keys = indicators.get(group.key) ?? renderedRunningKeys(group, states.get(group.key)!);
    return keys.some(key => {
      const entry = entryByKey.get(key);
      return entry !== undefined && activity.currentIndicator(entry);
    });
  });
  const genericWorking = !compacting && activity.working && !specificVisible;
  // 收起的组头正显示当前成员时不能再显示 Working；此时成员图标已不可见，交给末尾兜底，避免无提示空窗。
  // 单个空思考痕迹保持静态行，不为承载 Working 变成无内容可展开的组。
  const host = groups.findLast(group => {
    const state = states.get(group.key)!;
    return state.canHostWorking && !isLoneEmptyTrace(group) && !noticeFollows(group, noticeAfterSeqs) && (state.expanded || state.activeEntry === null);
  });
  const workingGroupKey = genericWorking && host !== undefined ? host.key : null;
  const workingVisible = genericWorking && host === undefined;
  // 只有手动展开申请阅读锁；运行中默认展开不暂停跟随。
  const readingInline = groups.some(group => processExpansion(group.entries, choices)?.expanded === true);

  const chooseGroup = useCallback((groupKey: string, expanded: boolean) => {
    const group = latest.current.groups.find(candidate => candidate.key === groupKey);
    if (group === undefined) return;
    const next = withProcessExpansion(latest.current.choices, group.entries.map(entry => entry.key), expanded);
    latest.current.choices = next;
    setChoices(next);
  }, []);
  const manualReading = useCallback(() => {
    const current = latest.current;
    return current.groups.some(group => processExpansion(group.entries, current.choices)?.expanded === true);
  }, []);
  const reportFocus = useCallback((groupKey: string, isFocused: boolean) => {
    setFocused(previous => {
      if (previous.has(groupKey) === isFocused) return previous;
      const next = new Set(previous);
      if (isFocused) next.add(groupKey);
      else next.delete(groupKey);
      return next;
    });
  }, []);
  const reportIndicators: RunningToolsChange = useCallback((groupKey, keys) => {
    setIndicators(previous => {
      const known = previous.get(groupKey);
      if (keys === null ? known === undefined : known !== undefined && sameKeys(known, keys)) return previous;
      const next = new Map(previous);
      if (keys === null) next.delete(groupKey);
      else next.set(groupKey, keys);
      return next;
    });
  }, []);

  return { states, workingGroupKey, workingVisible, readingInline, chooseGroup, manualReading, reportFocus, reportIndicators };
}
