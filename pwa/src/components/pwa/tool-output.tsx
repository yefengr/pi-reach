import { useState } from "react";
import {
  TOOL_IMAGE_MIMES,
  TOOL_INLINE_IMAGE_MAX_HEIGHT,
  toolCallText,
  toolContentView,
  toolWasTruncated,
  type ToolContentBlock,
  type ToolOutputBlock,
  type ToolValue,
} from "./tool-presentation";
import { useI18n } from "@/lib/i18n";

type ToolOutputProps = {
  value: ToolValue;
  preview?: boolean;
  onContentSizeChange?: () => void;
};

/** 卡片与 Reader 共用可读内容，preview 只改变有界展示。 */
export function ToolOutput({ value, preview = false, onContentSizeChange }: ToolOutputProps) {
  const { t } = useI18n();
  const { blocks, clipped } = toolContentView(value, preview);
  return <div className={`pwa-tool-content${preview ? " pwa-tool-content-preview" : ""}`}>
    {!preview ? <pre className="pwa-tool-call" aria-label={t.tools.toolCall}>{toolCallText(value)}</pre> : null}
    <div className="pwa-tool-output-blocks">
      {blocks.map((block, index) => <ContentBlock key={`${block.kind}:${index}`} block={block} index={index} preview={preview} onContentSizeChange={onContentSizeChange} />)}
    </div>
    {clipped ? <p className="pwa-tool-notice">{t.tools.previewShortened}</p> : null}
    {!preview && toolWasTruncated(value) ? <p className="pwa-tool-notice">{t.tools.truncatedByHost}</p> : null}
  </div>;
}

function ContentBlock({ block, index, preview, onContentSizeChange }: { block: ToolContentBlock; index: number; preview: boolean; onContentSizeChange?: () => void }) {
  if (block.kind === "image") return <ToolImage block={block} index={index} preview={preview} onContentSizeChange={onContentSizeChange} />;
  if (block.style === "diff") return <section className="pwa-tool-diff-section" aria-label={block.label}>
    <p className="pwa-tool-content-label">{block.label}</p>
    <pre className="pwa-tool-diff-output">{block.text.split("\n").map((line, lineIndex, lines) => <span className={diffLineClass(line)} key={lineIndex}>{line}{lineIndex < lines.length - 1 ? "\n" : ""}</span>)}</pre>
  </section>;
  return <pre className={`pwa-tool-text pwa-tool-text-${block.style}`} aria-label={block.label}>{block.text}</pre>;
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "pwa-tool-diff-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "pwa-tool-diff-remove";
  return "pwa-tool-diff-context";
}

export function ToolImage({ block, index, preview, onContentSizeChange }: { block: Extract<ToolOutputBlock, { kind: "image" }>; index: number; preview: boolean; onContentSizeChange?: () => void }) {
  const { t, format } = useI18n();
  const [failedSource, setFailedSource] = useState<string>();
  const size = block.byteLength === undefined ? "" : ` · ${t.tools.bytes(format.number(block.byteLength))}`;
  if (block.omitted || !block.data) return <p className="pwa-image-omitted">{t.tools.imageOmitted}{block.mime ? ` · ${block.mime}` : ""}{size}</p>;
  if (!TOOL_IMAGE_MIMES.has(block.mime)) return <p className="pwa-image-omitted">{t.tools.imageUnsupported}{block.mime ? `: ${block.mime}` : ""}{size}</p>;
  const source = `data:${block.mime};base64,${block.data}`;
  if (failedSource === source) return <p className="pwa-image-omitted">{t.tools.imageUnavailable}{block.mime ? ` · ${block.mime}` : ""}{size}</p>;
  return <img className="pwa-tool-output-image" style={preview ? { maxHeight: TOOL_INLINE_IMAGE_MAX_HEIGHT } : undefined} src={source} alt={t.tools.imageAlt(index + 1)} loading="lazy" onLoad={onContentSizeChange} onError={() => { setFailedSource(source); onContentSizeChange?.(); }} />;
}
