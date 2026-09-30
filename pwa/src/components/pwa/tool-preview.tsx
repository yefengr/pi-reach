import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@mantine/core";
import { ToolOutput } from "./tool-output";
import { TOOL_INLINE_MAX_LINES, toolHasOverflow, toolLineCount, toolWasTruncated, type ToolValue } from "./tool-presentation";
import "./tool-reader.css";
import { useI18n } from "@/lib/i18n";

type ToolPreviewProps = {
  value: ToolValue;
  onRead?: (trigger: HTMLButtonElement) => void;
};

/** 测量未受限的内层高度，避免将 384px 裁切容器本身误当作内容高度。 */
export function ToolPreview({ value, onRead }: ToolPreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [layoutOverflow, setLayoutOverflow] = useState(false);
  const scheduleMeasurement = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const preview = previewRef.current;
      const content = contentRef.current;
      if (!preview || !content || preview.clientHeight === 0) return;
      const contentHeight = Math.ceil(content.getBoundingClientRect().height);
      const next = contentHeight > preview.clientHeight + 1;
      setLayoutOverflow(previous => previous === next ? previous : next);
    });
  }, []);

  useLayoutEffect(() => {
    scheduleMeasurement();
    const observer = new ResizeObserver(scheduleMeasurement);
    const preview = previewRef.current;
    const content = contentRef.current;
    if (preview) observer.observe(preview);
    if (content) observer.observe(content);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [scheduleMeasurement, value]);

  const showDetails = toolHasOverflow(value) || layoutOverflow;
  const { t } = useI18n();
  // 只有正文超过预览行数时才标出总行数；因调用过长或布局溢出进入阅读器时只写「查看全部」。
  const lineCount = toolLineCount(value);
  return <>
    <div className="pwa-tool-preview" ref={previewRef} data-overflow={showDetails ? "" : undefined}>
      <div className="pwa-tool-preview-content" ref={contentRef}>
        <ToolOutput value={value} preview onContentSizeChange={scheduleMeasurement} />
      </div>
    </div>
    {toolWasTruncated(value) ? <p className="pwa-tool-notice">{t.tools.truncatedByHost}</p> : null}
    {onRead && showDetails ? <div className="pwa-tool-read-actions"><Button className="pwa-tool-details-button" variant="transparent" color="piReach" type="button" onClick={(event) => onRead(event.currentTarget)}>{t.tools.viewAll(lineCount > TOOL_INLINE_MAX_LINES ? lineCount : null)}</Button></div> : null}
  </>;
}
