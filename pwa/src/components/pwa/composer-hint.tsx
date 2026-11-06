import { useRef } from "react";
import { UnstyledButton } from "@mantine/core";
import { LoaderCircle } from "lucide-react";
import type { OperationHint } from "@/lib/pwa/operation-feedback";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";
import { hideDuringOwnSend, presenceProps, usePresence } from "./use-presence";

function sameHint(a: OperationHint, b: OperationHint): boolean {
  return a.text === b.text && a.tone === b.tone && a.busy === b.busy
    && a.action?.label === b.action?.label && a.action?.disabled === b.action?.disabled && a.action?.onAction === b.action?.onAction;
}

/**
 * 输入框卡片内顶部的一行提示：出现淡入，隐藏时淡出；高度由包裹层随进出过渡（DESIGN「输入区内的增减」）。
 * 输入区浮在列表之上，高度变化不改变列表高度，不再与时间线的锚点补偿争抢。
 * 淡出中的副本不带 .pwa-composer-hint 与 status 角色，不再被读屏播报；本端发送过渡期间直接移除，移除前的一帧由 CSS 隐藏。
 */
export function ComposerHint({ hint }: { hint: OperationHint | null }) {
  const slotRef = useRef<HTMLDivElement>(null);
  // 离开时长与包裹层收拢一致；本端发送过渡期间不保留淡出副本，避免过渡先结束时副本重新占位。
  const presence = usePresence(hint, sameHint, { exit: "--pwa-duration-collapse-out", skipExit: () => hideDuringOwnSend(slotRef.current) });
  const shown = presence.rendered;
  if (!shown) return null;
  return <div ref={slotRef} className="pwa-composer-grow pwa-composer-hint-slot" {...presenceProps(presence)}><p className={presence.leaving ? "pwa-composer-hint-line pwa-presence" : "pwa-composer-hint pwa-composer-hint-line pwa-presence"}
    role={presence.leaving ? undefined : "status"} data-tone={shown.tone} {...presenceProps(presence)}>
    {shown.busy ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} aria-hidden="true" /> : null}
    <span>{shown.text}</span>
    {shown.action && !presence.leaving ? <UnstyledButton className="pwa-composer-hint-action" type="button" disabled={shown.action.disabled} onClick={shown.action.onAction}>{shown.action.label}</UnstyledButton> : null}
  </p></div>;
}
