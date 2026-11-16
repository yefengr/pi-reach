import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { CopyButton } from "./copy-button";
import { FileTextContent, type DocumentHeading } from "./file-text-content";
import "./reader-document.css";

export type ReaderDocumentProps = {
  text: string;
  markdown: boolean;
  partial?: boolean;
  sourceLabel?: string;
  fileInfo?: string;
  onHeadings?: (headings: readonly DocumentHeading[]) => void;
  onPreviewChange?: (preview: boolean) => void;
  initialSource?: boolean;
  startLine?: number;
  endLine?: number;
};

function sourceLines(text: string, startLine: number, endLine?: number) {
  const result = text.split("\n");
  const expected = endLine === undefined ? undefined : endLine - startLine + 1;
  // 续读范围能证明末尾空行属于本段；其余末尾换行只终止最后一行。
  if (result.length > 1 && result.at(-1) === "" && expected !== result.length) result.pop();
  return result;
}

function NumberedSource({ lines, startLine }: { lines: readonly string[]; startLine: number }) {
  const lineWidth = `${String(startLine + lines.length - 1).length}ch`;
  return <pre className="pwa-reader-source pwa-file-plain" style={{ "--pwa-reader-line-width": lineWidth } as CSSProperties}>{lines.map((line, index) => <span className="pwa-reader-source-row" key={index}>
    <span className="pwa-reader-line-number" aria-hidden="true">{startLine + index}</span><span className="pwa-reader-source-text">{line}</span>
  </span>)}</pre>;
}

/** 直接复制原文；文档排版和行号均不参与复制内容转换。 */
export function ReaderDocument({ text, markdown, partial = false, sourceLabel, fileInfo, onHeadings, onPreviewChange, initialSource, startLine, endLine }: ReaderDocumentProps) {
  const { t } = useI18n();
  const [source, setSource] = useState(initialSource ?? partial);
  const preview = markdown && !source;
  const callbacks = useRef({ onHeadings, onPreviewChange });
  useLayoutEffect(() => { callbacks.current = { onHeadings, onPreviewChange }; }, [onHeadings, onPreviewChange]);
  // 通知由视图状态驱动，父组件内联回调的身份变化不能重复清空目录。
  useEffect(() => { callbacks.current.onPreviewChange?.(preview); }, [preview]);
  useEffect(() => { if (!preview) callbacks.current.onHeadings?.([]); }, [preview]);
  const lines = useMemo(() => startLine === undefined ? [] : sourceLines(text, startLine, endLine), [text, startLine, endLine]);
  const numbered = Number.isSafeInteger(startLine) && startLine! > 0 && lines.length - 1 <= Number.MAX_SAFE_INTEGER - startLine!;
  return <div className="pwa-reader-document" data-reader-preview={preview || undefined}>
    <div className="pwa-reader-document-toolbar">
      {fileInfo || sourceLabel || !markdown ? <span className={`pwa-reader-source-label${fileInfo ? " pwa-reader-file-info" : ""}`}>{fileInfo ?? <>{sourceLabel ?? t.files.plainText}{markdown ? ` · ${t.files.markdown}` : ""}</>}</span> : null}
      <div className="pwa-reader-document-actions">
        {markdown ? <div className="pwa-reader-view-switch" role="group" aria-label={t.files.markdown}>
          <Button variant="transparent" aria-pressed={preview} onClick={() => setSource(false)}>{t.files.preview}</Button>
          <Button variant="transparent" aria-pressed={!preview} onClick={() => setSource(true)}>{t.files.source}</Button>
        </div> : null}
        <CopyButton text={text} label={t.files.copyContent} className="pwa-icon-button" />
      </div>
    </div>
    {preview ? <FileTextContent text={text} markdown onHeadings={onHeadings} /> : <>
      {numbered ? <NumberedSource lines={lines} startLine={startLine!} /> : <FileTextContent text={text} markdown={false} />}
    </>}
  </div>;
}
