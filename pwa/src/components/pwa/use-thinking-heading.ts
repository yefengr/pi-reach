import { useEffect, useRef, useState } from "react";
import type { ThinkingTextResult } from "@/lib/pwa/thinking-text-parser";

export const THINKING_SUMMARY_WINDOW_MS = 120;

/** 只合并标题展示；正文与增量解析始终按原节奏推进。 */
export function useThinkingHeading(parsed: ThinkingTextResult, streaming: boolean, epoch?: object): string | undefined {
  // 仅隐藏仍可能是整行加粗标题的片段；行内加粗正文继续使用首行摘要。
  const summary = parsed.summaryIsHeadingCandidate ? undefined : parsed.summary;
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

  // 结束后保留最后有效摘要（加粗标题优先，其次首行摘要），不退回占位，已显示的内容不消失。
  return title ?? (streaming ? (summary ? current.summary : undefined) : summary);
}
