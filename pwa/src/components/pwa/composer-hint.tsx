import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { OperationHint } from "@/lib/pwa/operation-feedback";
import { SMALL_SPINNER_SIZE, SMALL_SPINNER_STROKE } from "@/lib/ui/icon-metrics";

function sameHint(a: OperationHint | null, b: OperationHint | null): boolean {
  return a === b || (a !== null && b !== null && a.text === b.text && a.tone === b.tone && a.busy === b.busy);
}

function HintLine({ hint, className, live }: { hint: OperationHint; className: string; live: boolean }) {
  return <p className={className} role={live ? "status" : undefined} aria-hidden={live ? undefined : true} data-tone={hint.tone}>
    {hint.busy ? <LoaderCircle className="pwa-spin" size={SMALL_SPINNER_SIZE} strokeWidth={SMALL_SPINNER_STROKE} aria-hidden="true" /> : null}
    <span>{hint.text}</span>
  </p>;
}

/**
 * 输入框卡片内顶部的一行提示。插槽常驻，出现与隐藏按 0fr↔1fr 过渡高度（DESIGN「输入区内的增减」）；
 * 隐藏时保留上一条提示的只读副本退场，它不带 .pwa-composer-hint 与 status 角色，不再被读屏播报。
 */
export function ComposerHint({ hint }: { hint: OperationHint | null }) {
  const [last, setLast] = useState(hint);
  // 提示对象可能每次渲染重建，只按内容更新退场副本，避免重复渲染。
  if (hint && !sameHint(hint, last)) setLast(hint);
  return <div className="pwa-composer-hint-slot" data-open={hint ? "" : undefined}>
    <div className="pwa-composer-hint-inner" inert={hint ? undefined : true}>
      {hint ? <HintLine hint={hint} className="pwa-composer-hint pwa-composer-hint-line" live />
        : last ? <HintLine hint={last} className="pwa-composer-hint-line" live={false} /> : null}
    </div>
  </div>;
}
