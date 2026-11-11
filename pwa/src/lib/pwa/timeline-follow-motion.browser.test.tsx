import { expect, test } from "vitest";
import { ActivityFollowTransition, activityFollowSpace, CollapseHoldTransition } from "./timeline-follow-motion";

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

/** 与 globals.css 同一规则：保持期间的临时空白由列表末尾伪元素承担。 */
function mountHoldList(contentHeight: number) {
  const style = document.createElement("style");
  style.textContent = ".hold-test[data-timeline-hold]::after { content: \"\"; display: block; height: var(--pwa-timeline-hold, 0px); }";
  document.head.append(style);
  const list = mountList(contentHeight);
  list.classList.add("hold-test");
  const content = list.firstElementChild as HTMLElement;
  return { list, content, remove: () => { list.remove(); style.remove(); } };
}

test("a taken-over hold keeps its whole reserve until the collapse clock ends, then shrinks with the position", () => {
  const { list, content, remove } = mountHoldList(1000);
  const from = list.scrollHeight - list.clientHeight;
  const hold = new CollapseHoldTransition(list, from, () => from, 100, 200);
  try {
    // 收起尚未开始收缩时，按所需只需 0；收起期间仍须保留全部 200，否则随后的收缩会逐帧钳制位置。
    expect(hold.track(from - 50, 0)).toBe(false);
    expect(hold.heldSpace()).toBe(200);
    content.style.height = "800px";
    expect(hold.track(from - 50, 50)).toBe(false);
    expect(hold.heldSpace()).toBe(200);
    // 收起结束后只保留让当前位置可达的部分。
    expect(hold.track(from - 50, 150)).toBe(false);
    expect(hold.heldSpace()).toBe(150);
    expect(list.scrollHeight - list.clientHeight).toBeGreaterThanOrEqual(from - 50);
    expect(hold.track(from - 200, 160)).toBe(true);
    expect(hold.heldSpace()).toBe(0);
    expect(list.hasAttribute("data-timeline-hold")).toBe(false);
  } finally {
    hold.finish();
    remove();
  }
});

test("a hold released while taken over returns its space smoothly once handed back", () => {
  const { list, content, remove } = mountHoldList(1000);
  const from = list.scrollHeight - list.clientHeight;
  const target = from - 200;
  const hold = new CollapseHoldTransition(list, from, () => target, 100, 200);
  try {
    hold.track(from, 0);
    content.style.height = "800px";
    hold.release();
    expect(hold.track(from, 150)).toBe(false);
    // 交回后收回时钟才起步：第一帧原位，之后逐帧移动，不一步跳到目标。
    expect(hold.advance(200)).toEqual({ top: from, finished: false });
    const middle = hold.advance(250);
    expect(middle.finished).toBe(false);
    expect(middle.top).toBeLessThan(from);
    expect(middle.top).toBeGreaterThan(target);
    const last = hold.advance(400);
    expect(last).toEqual({ top: target, finished: true });
  } finally {
    hold.finish();
    remove();
  }
});

test("a hold whose group head sits above the screen lifts the position with the collapse clock and keeps only the rest as space", () => {
  const { list, content, remove } = mountHoldList(1000);
  const from = list.scrollHeight - list.clientHeight;
  // 收回 500，其中 400 用于把组头带回可见区；带回用实际收起时长 80，保持时钟另含兜底余量。
  const hold = new CollapseHoldTransition(list, from, () => from - 500, 100, 500, { distance: 400, duration: 80 });
  try {
    const tops: number[] = [];
    for (const [now, height] of [[0, 1000], [20, 900], [40, 750], [60, 600], [80, 500], [120, 500]] as const) {
      content.style.height = `${height}px`;
      const step = hold.advance(now);
      tops.push(step.top);
      // 任一帧都可达：不会被浏览器钳制成跳动。
      expect(list.scrollHeight - list.clientHeight).toBeGreaterThanOrEqual(Math.ceil(step.top));
    }
    expect(tops[0]).toBe(from);
    for (let index = 1; index < tops.length; index += 1) expect(tops[index]!).toBeLessThanOrEqual(tops[index - 1]!);
    expect(tops[2]).toBeLessThan(from);
    expect(tops[2]).toBeGreaterThan(from - 400);
    expect(tops.at(-1)).toBe(from - 400);
    // 收起结束后只保留其余的 100 给后续正文。
    expect(hold.heldSpace()).toBe(100);
  } finally {
    hold.finish();
    remove();
  }
});

test("a user taking over during the lift stops it where the user is", () => {
  const { list, content, remove } = mountHoldList(1000);
  const from = list.scrollHeight - list.clientHeight;
  const hold = new CollapseHoldTransition(list, from, () => from - 500, 100, 500, { distance: 400, duration: 80 });
  try {
    hold.advance(0);
    content.style.height = "800px";
    const lifted = hold.advance(30).top;
    expect(hold.track(lifted - 10, 40)).toBe(false);
    content.style.height = "500px";
    // 交回后不再继续带回，位置停在用户留下的地方。
    expect(hold.advance(120).top).toBe(lifted - 10);
  } finally {
    hold.finish();
    remove();
  }
});
