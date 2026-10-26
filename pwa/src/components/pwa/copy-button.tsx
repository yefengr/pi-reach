import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { useToast } from "@/components/pwa/pwa-operation-notifications";
import { useI18n } from "@/lib/i18n";
import { useFloatingSafeMiddlewares } from "@/lib/ui/safe-area";
import "./copy-button.css";

const COPY_FEEDBACK_MS = 2000;
type CopyFeedback = "toast" | "inline" | "inline-text";
type InlineResult = { request: number; kind: "success" | "error" };

/**
 * 默认在固定图标槽内确认真实复制结果，名称不变，结果只由 live region 播报。
 * toast 与 inline-text 保留显式评审对照；局部失败不挤动原有工具栏。
 */
export function CopyButton({ text, label, className, feedback = "inline" }: { text: string; label: string; className?: string; feedback?: CopyFeedback }) {
  const { t } = useI18n();
  const toast = useToast();
  const floatingMiddlewares = useFloatingSafeMiddlewares();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [inlineResult, setInlineResult] = useState<InlineResult | null>(null);
  const [source, setSource] = useState({ text, feedback });
  if (source.text !== text || source.feedback !== feedback) {
    setSource({ text, feedback });
    setCopied(false);
    setInlineResult(null);
  }
  const requestRef = useRef(0);
  useLayoutEffect(() => {
    // 文本或反馈模式切换后，旧剪贴板回调不能确认新内容；卸载同样使在途回调失效。
    requestRef.current += 1;
    return () => { requestRef.current += 1; };
  }, [text, feedback]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      // inline-text 的可见文字与图标一起回落；失败说明保留到下一次操作。
      if (feedback === "inline-text") setInlineResult(null);
    }, COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied, inlineResult, feedback]);
  const copy = async () => {
    const request = ++requestRef.current;
    if (feedback !== "toast") {
      setCopied(false);
      setInlineResult(null);
    }
    try {
      await navigator.clipboard.writeText(text);
      if (request !== requestRef.current) return;
      setCopied(true);
      if (feedback === "toast") toast?.notify(t.workspace.copied);
      else setInlineResult({ request, kind: "success" });
    } catch {
      if (request !== requestRef.current) return;
      setCopied(false);
      if (feedback !== "toast") setInlineResult({ request, kind: "error" });
    }
  };
  const failed = feedback === "inline" && inlineResult?.kind === "error";
  const currentLabel = feedback === "toast" && copied ? t.workspace.copied : label;
  if (feedback === "inline-text") {
    const status = inlineResult ? (inlineResult.kind === "error" ? t.workspace.copyFailed : t.workspace.copied) : null;
    return <span className="pwa-copy-inline">
      <ActionIcon className={className} type="button" onClick={() => { void copy(); }} aria-label={label} title={label}>
        <span className="pwa-copy-inline-icons" data-copied={copied || undefined} aria-hidden="true">
          <Copy className="pwa-copy-inline-icon-copy" size={16} />
          <Check className="pwa-copy-inline-icon-check" size={16} />
        </span>
      </ActionIcon>
      {/* 可见文字与播报分开：画面给出结果，读屏区域只播报一次，按钮名称保持不变。 */}
      <span className="pwa-copy-inline-status" data-state={inlineResult?.kind} aria-hidden="true">{status}</span>
      <span className="pwa-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {inlineResult ? <span key={inlineResult.request}>{status}</span> : null}
      </span>
    </span>;
  }
  return <>
    <ActionIcon ref={buttonRef} className={className} type="button" onClick={() => { void copy(); }} aria-label={currentLabel} title={currentLabel}>
      {feedback === "toast" ? (copied ? <Check size={16} /> : <Copy size={16} />) : <span className="pwa-copy-icons" data-copied={copied || undefined} aria-hidden="true">
        <Copy className="pwa-copy-icon-copy" size={16} />
        <Check className="pwa-copy-icon-check" size={16} />
      </span>}
    </ActionIcon>
    {/* 使用 target 而非包装控件，保留直接子级布局，也不重复添加读屏描述。 */}
    {feedback === "inline" ? <Tooltip target={buttonRef} opened={failed} zIndex="var(--pwa-z-feedback)" label={t.workspace.copyFailed}
      classNames={{ tooltip: "pwa-copy-error" }} aria-hidden="true" multiline
      portalProps={{ target: ".pwa-root" }} floatingStrategy="fixed" middlewares={floatingMiddlewares}
      events={{ hover: false, focus: false, touch: false }} transitionProps={{ duration: 0 }} /> : null}
    {feedback === "inline" ? <span className="pwa-sr-only" role="status" aria-live="polite" aria-atomic="true">
      {inlineResult ? <span key={inlineResult.request}>{failed ? t.workspace.copyFailed : t.workspace.copied}</span> : null}
    </span> : null}
  </>;
}
