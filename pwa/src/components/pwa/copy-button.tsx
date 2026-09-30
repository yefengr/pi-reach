import { useEffect, useState } from "react";
import { ActionIcon } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { useToast } from "@/components/pwa/pwa-operation-notifications";
import { useI18n } from "@/lib/i18n";

/** 无框图标按钮：复制成功后以 Toast 提示「已复制」，按钮 2 秒内显示对勾。剪贴板不可用时保持原状，内容仍可手动选中。 */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast?.notify(t.workspace.copied);
    } catch {
      // 剪贴板权限被拒绝时不打断阅读。
    }
  };
  const currentLabel = copied ? t.workspace.copied : label;
  return <ActionIcon className={className} type="button" onClick={() => { void copy(); }} aria-label={currentLabel} title={currentLabel}>{copied ? <Check size={16} /> : <Copy size={16} />}</ActionIcon>;
}
