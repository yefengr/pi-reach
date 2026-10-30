import { expect, test } from "vitest";
import { ActivityFollowTransition, activityFollowSpace } from "./timeline-follow-motion";

const NATURAL_PADDING = 88;

function mountList(contentHeight: number) {
  const list = document.createElement("div");
  list.style.cssText = `height: 300px; overflow-y: auto; padding-bottom: ${NATURAL_PADDING}px; scroll-padding-bottom: ${NATURAL_PADDING}px`;
  const content = document.createElement("div");
  content.style.height = `${contentHeight}px`;
  list.append(content);
  document.body.append(list);
  return list;
}

/** 与 TimelineViewportLayout.measure 同一口径：整数 scrollHeight 减去临时补偿。 */
function naturalBottom(list: HTMLDivElement) {
  return list.scrollHeight - list.clientHeight - activityFollowSpace(list).compensation;
}

test.each([1000, 1000.25, 1000.5, 1000.8])("keeps the measured natural bottom exact while holding fractional positions reachable (content %spx)", (contentHeight) => {
  const list = mountList(contentHeight);
  try {
    const natural = naturalBottom(list);
    for (const extra of [0.185, 0.5, 0.815, 7.37, 8.815, 120.6]) {
      const transition = new ActivityFollowTransition(list, natural + extra, () => natural);
      try {
        const applied = Number.parseFloat(getComputedStyle(list).paddingBottom);
        // 补偿为整数且足以让原位置可达；测得的自然底部与没有补偿时一致，收尾不会出现 1px 回退。
        expect(naturalBottom(list)).toBe(natural);
        expect(Number.isInteger(applied - NATURAL_PADDING)).toBe(true);
        expect(list.scrollHeight - list.clientHeight).toBeGreaterThanOrEqual(natural + extra);
      } finally {
        transition.finish();
      }
      expect(list.style.paddingBottom).toBe(`${NATURAL_PADDING}px`);
    }
  } finally {
    list.remove();
  }
});
