import { useEffect, useState } from "react";
import type { PresentationEntry } from "@/lib/pwa/timeline-presentation";

/** 界面连续这么久没有可见变化才显示 Working；任何变化立即隐藏。 */
export const WORKING_IDLE_MS = 400;

function sameEntries(left: readonly PresentationEntry[], right: readonly PresentationEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * 只在界面没有可见动作时显示 Working：展示条目（文字放出、新行、工具状态与参数）任何变化都算动作，
 * 视口内转动的工具图标算持续动作。投影会复用未变化的条目对象，按引用比较即可识别真实变化。
 */
export function useIdleWorking(entries: readonly PresentationEntry[], active: boolean, moving: boolean): boolean {
  // 每次可见变化或条件变化推进版本；计时只为当前版本到点，任何新变化都使旧计时失效。
  const [tracked, setTracked] = useState({ entries, active, moving, version: 0 });
  let version = tracked.version;
  if ((tracked.entries !== entries && !sameEntries(tracked.entries, entries)) || tracked.active !== active || tracked.moving !== moving) {
    version += 1;
    setTracked({ entries, active, moving, version });
  }
  const [idleVersion, setIdleVersion] = useState(-1);
  useEffect(() => {
    if (!active || moving) return;
    const timer = setTimeout(() => setIdleVersion(version), WORKING_IDLE_MS);
    return () => clearTimeout(timer);
  }, [version, active, moving]);
  return active && !moving && idleVersion === version;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * 在线会话中追加在已知条目之后的新条目，供新行淡入；首次渲染、历史前插与离线会话不计入。
 * 已进入的 key 保留到组件卸载，类名不会在动画中途移除，也不会因重渲染重播。
 */
export function useEnteredKeys(entries: readonly PresentationEntry[], live: boolean): ReadonlySet<string> {
  const [state, setState] = useState(() => ({ known: new Set(entries.map(entry => entry.key)) as ReadonlySet<string>, entered: NO_KEYS }));
  const additions = entries.filter(entry => !state.known.has(entry.key));
  if (additions.length === 0) return state.entered;
  const lastKnown = entries.findLastIndex(entry => state.known.has(entry.key));
  const appended = live ? entries.filter((entry, index) => index > lastKnown && !state.known.has(entry.key)) : [];
  const next = {
    known: new Set([...state.known, ...additions.map(entry => entry.key)]) as ReadonlySet<string>,
    entered: appended.length ? new Set([...state.entered, ...appended.map(entry => entry.key)]) as ReadonlySet<string> : state.entered,
  };
  setState(next);
  return next.entered;
}
