import { useEffect, type RefObject } from "react";
import { installOutsideTapGuard } from "@yefengr/pwa-foundation";
export { outsideTapSwallowed } from "@yefengr/pwa-foundation";

/** Reach 明确选择没有遮罩的 Mantine 浮层；包不识别业务结构或全页默认目标。 */
export function useOutsideTapGuard(scopeRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    return installOutsideTapGuard(scope, {
      getTopFloating: () => [...scope.querySelectorAll<HTMLElement>(".mantine-Menu-dropdown, .mantine-Popover-dropdown")]
        .filter((element) => !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0).at(-1) ?? null,
      isOwnTrigger: (target, floating) => {
        const trigger = target.closest('[aria-expanded="true"]');
        return !!floating.id && trigger?.getAttribute("aria-controls") === floating.id;
      },
    });
  }, [scopeRef]);
}
