import { useLayoutEffect, useRef } from "react";
import { Lightbulb, LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { ThinkingEntry } from "@/lib/pwa/timeline-presentation";
import type { ProcessStatus } from "./process-group-state";
import { CopyButton } from "./copy-button";
import { ReaderShell } from "./reader-shell";
import { READER_FOLLOW_THRESHOLD_PX } from "./reader-shared";
import { MarkdownContent } from "./timeline-content";
import "./tool-reader.css";

type ThinkingReaderProps = {
  entry: ThinkingEntry | null;
  status: ProcessStatus;
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd?: () => void;
};

/** 只读实际思考正文；独立滚动，不改变主时间线的跟随状态。 */
export function ThinkingReader({ entry, status, opened, onClose, onExitTransitionEnd }: ThinkingReaderProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const follow = () => {
    const scroll = scrollRef.current;
    if (scroll && followRef.current) scroll.scrollTop = scroll.scrollHeight;
  };
  // 流式输出打开即跟随；已结束的正文与其他 Reader 一致从开头阅读，到达底部后再恢复跟随。
  const followKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    // 只在换条目时决定初始跟随；同一条目从流式转为正式不重置用户的阅读位置。
    if (followKey.current === entry?.key) return;
    followKey.current = entry?.key;
    followRef.current = entry?.streaming === true;
  }, [entry?.key, entry?.streaming]);
  useLayoutEffect(follow, [entry?.text]);
  const statusLabel = status === "neutral" ? t.timeline.thinkingTrace : status === "unknown" ? t.timeline.unknown : t.tools.status[status];
  return <ReaderShell opened={opened} onClose={onClose} onExitTransitionEnd={onExitTransitionEnd}
    onEnterTransitionEnd={follow} title={t.timeline.thinkingTrace} closeLabel={t.timeline.closeThinkingReader}
    historyKey="piReachThinkingReader" className="pwa-thinking-reader" describedBy="pwa-thinking-reader-description"
    actions={<>
      <span id="pwa-thinking-reader-description" className={`pwa-tool-reader-status pwa-tool-status-${status}`} title={statusLabel}>
        {status === "running" ? <LoaderCircle className="pwa-spin" size={16} aria-hidden="true" /> : <Lightbulb size={16} aria-hidden="true" />}
        <span className="pwa-sr-only">{statusLabel}</span>
      </span>
      {entry ? <CopyButton text={entry.text} label={t.timeline.copyThinking} /> : null}
    </>}>
    <div className="pwa-tool-reader-scroll pwa-thinking-reader-scroll" ref={scrollRef} onScroll={event => {
      const scroll = event.currentTarget;
      followRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= READER_FOLLOW_THRESHOLD_PX;
    }}>
      {entry ? <MarkdownContent text={entry.text} /> : null}
    </div>
  </ReaderShell>;
}
