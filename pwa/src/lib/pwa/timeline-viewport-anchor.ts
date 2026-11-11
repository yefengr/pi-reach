const READABLE_BLOCK_SELECTOR = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, table, figure, .pwa-stream-text";
/** 只识别显式声明的顶层语义行，不让视觉 class 或包装标签决定阅读位置。 */
const CONTENT_ROW_SELECTOR = "[data-viewport-row]";
const EXCLUDED_SELECTOR = "[hidden], [aria-hidden='true']";

type RowLocator = {
  attribute: "data-viewport-row";
  key: string;
  blockIndex: number | null;
};

export type TimelineViewportAnchor = {
  list: HTMLDivElement;
  element: HTMLElement;
  offsetTop: number;
  rowElement: HTMLElement;
  rowOffsetTop: number;
  rowLocator: RowLocator | null;
  scrollTop: number;
  preserveScrollTopFallback: boolean;
};

function isUsableElement(list: HTMLDivElement, element: HTMLElement): boolean {
  return element.isConnected && list.contains(element) && element.closest(EXCLUDED_SELECTOR) === null;
}

function isVisibleInList(list: HTMLDivElement, element: HTMLElement, listTop: number, listBottom: number): boolean {
  if (!isUsableElement(list, element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.bottom > listTop && rect.top < listBottom;
}

function rowLocator(row: HTMLElement, element: HTMLElement): RowLocator | null {
  const attribute = "data-viewport-row";
  const key = row.getAttribute(attribute);
  if (!key) return null;
  const blocks = [...row.querySelectorAll<HTMLElement>(READABLE_BLOCK_SELECTOR)];
  const blockIndex = element === row ? -1 : blocks.indexOf(element);
  return { attribute, key, blockIndex: blockIndex < 0 ? null : blockIndex };
}

function findLocatedRow(list: HTMLDivElement, locator: RowLocator): HTMLElement | null {
  return [...list.children].find((element): element is HTMLElement => element instanceof HTMLElement
    && element.getAttribute(locator.attribute) === locator.key && isUsableElement(list, element)) ?? null;
}

const hasBox = (rect: DOMRect) => rect.width > 0 || rect.height > 0;

/**
 * 列表直接子元素都在文档流中自上而下排列，底边随位置单调递增；二分找到第一个底边进入视口的子元素，
 * 长会话中每次滚动不必从第一行逐行测量。没有布局盒的子元素（如 display: none）报告 0 尺寸、位置不可比较，
 * 取区间内其后最近的有盒子元素代替；其前的子元素仍由调用方从返回位置起按原条件逐个判断。
 */
function firstChildReachingViewport(children: HTMLCollection, listTop: number): number {
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    let probe = middle;
    let rect = children[probe]!.getBoundingClientRect();
    while (!hasBox(rect) && probe + 1 < high) rect = children[++probe]!.getBoundingClientRect();
    if (!hasBox(rect)) { high = middle; continue; }
    if (rect.bottom <= listTop) low = probe + 1;
    else high = middle;
  }
  return low;
}

export function captureTimelineViewportAnchor(
  list: HTMLDivElement,
  preserveScrollTopFallback = false,
): TimelineViewportAnchor | null {
  const listTop = list.getBoundingClientRect().top;
  const listBottom = list.clientHeight > 0 ? listTop + list.clientHeight : Number.POSITIVE_INFINITY;
  const visible = (element: HTMLElement) => isVisibleInList(list, element, listTop, listBottom);
  // 先确定可见行，避免为了找正文跳过视口顶部的折叠工具或 Thinking。
  const children = list.children;
  let rowElement: HTMLElement | null = null;
  for (let index = firstChildReachingViewport(children, listTop); index < children.length && rowElement === null; index += 1) {
    const child = children[index];
    if (!(child instanceof HTMLElement)) continue;
    if (child.matches(CONTENT_ROW_SELECTOR) && visible(child)) rowElement = child;
    else {
      // 越过视口底边后不会再有可见行。
      const rect = child.getBoundingClientRect();
      if (hasBox(rect) && rect.top >= listBottom) break;
    }
  }
  if (!rowElement) return null;
  const element = [...rowElement.querySelectorAll<HTMLElement>(READABLE_BLOCK_SELECTOR)].find(visible) ?? rowElement;
  return {
    list,
    element,
    offsetTop: element.getBoundingClientRect().top - listTop,
    rowElement,
    rowOffsetTop: rowElement.getBoundingClientRect().top - listTop,
    rowLocator: rowLocator(rowElement, element),
    scrollTop: list.scrollTop,
    preserveScrollTopFallback,
  };
}

export function restoreTimelineViewportAnchor(list: HTMLDivElement, anchor: TimelineViewportAnchor): boolean {
  if (anchor.list !== list) return false;

  const sameRow = anchor.rowElement.parentElement === list && isUsableElement(list, anchor.rowElement)
    && anchor.rowElement.getAttribute("data-viewport-row") === anchor.rowLocator?.key;
  let target: HTMLElement | null = sameRow && anchor.rowElement.contains(anchor.element)
    && isUsableElement(list, anchor.element) ? anchor.element : null;
  let targetOffset = anchor.offsetTop;
  if (!target) {
    const row = sameRow
      ? anchor.rowElement
      : anchor.rowLocator
        ? findLocatedRow(list, anchor.rowLocator)
        : null;
    if (row) {
      const blocks = [...row.querySelectorAll<HTMLElement>(READABLE_BLOCK_SELECTOR)];
      const locatedBlock = anchor.rowLocator?.blockIndex === null || anchor.rowLocator?.blockIndex === undefined
        ? null
        : blocks[anchor.rowLocator.blockIndex] ?? null;
      target = locatedBlock && isUsableElement(list, locatedBlock) ? locatedBlock : row;
      targetOffset = target === row ? anchor.rowOffsetTop : anchor.offsetTop;
    }
  }

  if (!target) {
    if (!anchor.preserveScrollTopFallback) return false;
    list.scrollTop = anchor.scrollTop;
    return true;
  }

  const currentOffset = target.getBoundingClientRect().top - list.getBoundingClientRect().top;
  const delta = currentOffset - targetOffset;
  if (Math.abs(delta) > 0.5) list.scrollTop += delta;
  return true;
}
