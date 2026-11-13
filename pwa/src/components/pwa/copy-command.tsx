import { Fragment, type ReactNode } from "react";
import { CopyButton } from "@/components/pwa/copy-button";
import { useI18n } from "@/lib/i18n";

export const PAIR_COMMAND = "/pi-reach pair";

/** 命令单独成行：等宽命令加复制按钮，说明文字不再夹着按钮。空态与配对弹窗共用。 */
export function CopyCommand({ command }: { command: string }) {
  const { t } = useI18n();
  return <div className="pwa-command-block"><code>{command}</code><CopyButton className="pwa-command-copy-button" text={command} label={t.workspace.copyCommand} /></div>;
}

/** 整句文案里无法放命令块（如错误提示），只把其中的命令换成行内代码。 */
export function withInlineCommand(text: string, command: string): ReactNode {
  const [before, ...after] = text.split(command);
  if (!after.length) return text;
  return <>{before}{after.map((part, index) => <Fragment key={index}><code className="pwa-inline-command">{command}</code>{part}</Fragment>)}</>;
}
