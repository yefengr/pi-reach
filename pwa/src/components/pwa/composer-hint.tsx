import { useRef } from "react";
import { LoaderCircle } from "lucide-react";
import type { OperationHint } from "@/lib/pwa/operation-feedback";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";
import { hideDuringOwnSend, presenceProps, usePresence } from "./use-presence";

function sameHint(a: OperationHint, b: OperationHint): boolean {
  return a.text === b.text && a.tone === b.tone && a.busy === b.busy;
}

/**
 * 输入框卡片内顶部的一行提示，沿用「浮动入口与局部提示」的进出：出现淡入，隐藏时淡出后再移除，
 * 高度只在出现与移除时一次到位，不逐帧改变布局，以免与时间线的锚点补偿和跟随滚动争抢（DESIGN「输入区内的增减」）。
 * 淡出中的副本不带 .pwa-composer-hint 与 status 角色，不再被读屏播报；本端发送过渡期间直接移除，移除前的一帧由 CSS 隐藏。
 */
export function ComposerHint({ hint }: { hint: OperationHint | null }) {
  const lineRef = useRef<HTMLParagraphElement>(null);
  // 本端发送过渡期间不保留淡出副本，避免过渡先结束时副本重新占位。
  const presence = usePresence(hint, sameHint, { skipExit: () => hideDuringOwnSend(lineRef.current) });
  const shown = presence.rendered;
  if (!shown) return null;
  return <p ref={lineRef} className={presence.leaving ? "pwa-composer-hint-line pwa-presence" : "pwa-composer-hint pwa-composer-hint-line pwa-presence"}
    role={presence.leaving ? undefined : "status"} data-tone={shown.tone} {...presenceProps(presence)}>
    {shown.busy ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} aria-hidden="true" /> : null}
    <span>{shown.text}</span>
  </p>;
}
