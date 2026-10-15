import { useEffect, useRef, useState } from "react";
import type { ThinkingTextResult } from "@/lib/pwa/thinking-text-parser";

export const THINKING_SUMMARY_WINDOW_MS = 120;

/** 只合并标题展示；正文与增量解析始终按原节奏推进。 */
export function useThinkingHeading(parsed: ThinkingTextResult, streaming: boolean, epoch?: object): string | undefined {
  // 单个星号也可能是尚未到齐的加粗起始符，不能先作为首行摘要露出。
  const summary = parsed.summary === "*" || parsed.summary?.startsWith("**") ? undefined : parsed.summary;
  const [snapshot, setSnapshot] = useState({ epoch, streaming, title: parsed.latestTitle, summary });
  let current = snapshot;
  if (snapshot.epoch !== epoch || snapshot.streaming !== streaming) {
    current = { epoch, streaming, title: parsed.latestTitle, summary };
    setSnapshot(current);
  } else if (parsed.latestTitle !== snapshot.title) {
    current = { ...snapshot, title: parsed.latestTitle };
    setSnapshot(current);
  }
  const title = streaming ? current.title : parsed.latestTitle;
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      pending.current = undefined;
    };
  }, [epoch, streaming, title]);

  useEffect(() => {
    pending.current = summary;
    if (!streaming || title || !summary) {
      clearTimeout(timer.current);
      timer.current = undefined;
      return;
    }
    if (summary === current.summary || timer.current !== undefined) return;
    // 后续输入只替换窗口末端的值，不重启计时，连续输入也会有界提交。
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setSnapshot(previous => ({ ...previous, summary: pending.current }));
    }, THINKING_SUMMARY_WINDOW_MS);
  }, [epoch, streaming, title, summary, current.summary]);

  return title ?? (streaming && summary ? current.summary : undefined);
}
