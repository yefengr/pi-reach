import { useEffect, type RefObject } from "react";
import "./activity-motion.css";

const LOOPS = ".pwa-spin, .pwa-tool-status-running > svg, .pwa-skeleton";
const MANAGED = "data-pwa-animation";
const CANDIDATES = `${LOOPS}, [${MANAGED}]`;

/** 仅治理循环的绘制；真实执行状态、提示优先级与组头计时仍由原消费者负责。 */
export function usePwaAnimationVisibility(scopeRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const visible = new Map<Element, boolean>();
    let disposed = false;
    const paint = (element: Element) => {
      const paused = document.hidden || reduced.matches || !visible.get(element);
      element.setAttribute(MANAGED, paused ? "paused" : "running");
    };
    const intersection = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (disposed) return;
      for (const entry of entries) {
        if (!visible.has(entry.target)) continue;
        visible.set(entry.target, entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
        paint(entry.target);
      }
    });
    const reconcile = (element: Element) => {
      const eligible = scope.contains(element) && element.matches(LOOPS)
        && !(import.meta.env.DEV && element.closest(".pwa-ui-review"));
      if (!eligible) {
        intersection?.unobserve(element);
        visible.delete(element);
        element.removeAttribute(MANAGED);
        return;
      }
      if (!visible.has(element)) {
        // 等首个真实交叉结果再启动，避免离屏新节点先转一帧。
        visible.set(element, intersection === null);
        intersection?.observe(element);
      }
      paint(element);
    };
    const visit = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(CANDIDATES)) reconcile(node);
      node.querySelectorAll(CANDIDATES).forEach(reconcile);
    };
    const mutation = new MutationObserver(records => {
      if (disposed) return;
      const roots = new Set<Element>();
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target instanceof Element) roots.add(record.target);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) roots.add(node);
        }
        for (const node of record.removedNodes) {
          if (node instanceof Element) roots.add(node);
        }
      }
      // 一批中父子同时变更时只处理最外层：沿 parentElement 祖先链做 Set 成员测试，避免两两 contains。
      for (const element of roots) {
        let covered = false;
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
          if (roots.has(parent)) {
            covered = true;
            break;
          }
        }
        if (!covered) visit(element);
      }
    });
    const refresh = () => { for (const element of visible.keys()) paint(element); };
    visit(scope);
    mutation.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", refresh);
    reduced.addEventListener("change", refresh);
    return () => {
      disposed = true;
      mutation.disconnect();
      intersection?.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      reduced.removeEventListener("change", refresh);
      for (const element of visible.keys()) element.removeAttribute(MANAGED);
      visible.clear();
    };
  }, [scopeRef]);
}
