import { useLayoutEffect, useRef } from "react";
import { Button } from "@mantine/core";
import { ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { CopyButton } from "./copy-button";
import { MarkdownContent } from "./timeline-content";
import { ReaderShell } from "./reader-shell";
import { summaryPresentation, type SummaryEvent } from "./summary-presentation";
import "./summary-reader.css";

export function SummaryEntry({ event, onRead, timelineKey }: { event: SummaryEvent; onRead: (trigger: HTMLButtonElement) => void; timelineKey: string }) {
  const { t } = useI18n();
  const { title, error } = summaryPresentation(event, t.summaryReader);
  return <article className={`pwa-message pwa-summary-entry${error ? " provider_error" : ""}`} data-viewport-row={timelineKey}>
    <Button variant="transparent" className="pwa-summary-action" type="button" onClick={event => onRead(event.currentTarget)} aria-haspopup="dialog">
      {error ? <CircleAlert size={16} aria-hidden="true" /> : <CircleCheck size={16} aria-hidden="true" />}
      <span>{error ? title : `${event.kind === "compaction" ? t.summaryReader.compactionComplete : t.summaryReader.branchSummaryComplete} · ${t.summaryReader.viewSummary}`}</span><ChevronRight size={16} aria-hidden="true" />
    </Button>
  </article>;
}

export function SummaryReader({ event, opened, onClose, onExitTransitionEnd }: {
  event: SummaryEvent | null;
  opened: boolean;
  onClose: () => void;
  onExitTransitionEnd: () => void;
}) {
  const { t } = useI18n();
  const content = event ? summaryPresentation(event, t.summaryReader) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = event ? `${event.session_id}:${event.event_id}` : null;
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [key]);
  return <ReaderShell opened={opened} onClose={onClose} onExitTransitionEnd={onExitTransitionEnd}
    title={content?.title ?? t.summaryReader.compaction} closeLabel={t.summaryReader.closeReader}
    historyKey="piReachSummaryReader" className="pwa-summary-reader"
    actions={content ? <CopyButton text={content.text} label={t.summaryReader.copy} /> : null}>
    <div className="pwa-tool-reader-scroll pwa-summary-reader-scroll" ref={scrollRef}>
      {content ? <MarkdownContent text={content.text} /> : null}
    </div>
  </ReaderShell>;
}
