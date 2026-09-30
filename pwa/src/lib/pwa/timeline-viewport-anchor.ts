const READABLE_BLOCK_SELECTOR = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, table, figure, .pwa-stream-text";
const CONTENT_ROW_SELECTOR = "[data-timeline-key], [data-tool-key], .pwa-timeline-row, .pwa-message, article";
const EXCLUDED_SELECTOR = ".pwa-earlier-button, .pwa-bottom-sentinel, .pwa-chat-empty, [hidden]";

type RowLocator = {
  attribute: "data-timeline-key" | "data-tool-key";
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
  const attribute = row.hasAttribute("data-timeline-key")
    ? "data-timeline-key"
    : row.hasAttribute("data-tool-key")
      ? "data-tool-key"
      : null;
  if (!attribute) return null;
  const key = row.getAttribute(attribute);
  if (key === null) return null;
  const blocks = [...row.querySelectorAll<HTMLElement>(READABLE_BLOCK_SELECTOR)];
  const blockIndex = element === row ? -1 : blocks.indexOf(element);
  return { attribute, key, blockIndex: blockIndex < 0 ? null : blockIndex };
}

function findLocatedRow(list: HTMLDivElement, locator: RowLocator): HTMLElement | null {
  return [...list.querySelectorAll<HTMLElement>(`[${locator.attribute}]`)]
    .find((element) => element.getAttribute(locator.attribute) === locator.key) ?? null;
}

export function captureTimelineViewportAnchor(
  list: HTMLDivElement,
  preserveScrollTopFallback = false,
): TimelineViewportAnchor | null {
  const listTop = list.getBoundingClientRect().top;
  const listBottom = list.clientHeight > 0 ? listTop + list.clientHeight : Number.POSITIVE_INFINITY;
  const visible = (element: HTMLElement) => isVisibleInList(list, element, listTop, listBottom);
  // 先确定可见行，避免为了找正文跳过视口顶部的折叠工具或 Thinking。
  const rowElement = [...list.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.matches(CONTENT_ROW_SELECTOR) && visible(child));
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

  let target: HTMLElement | null = isUsableElement(list, anchor.element) ? anchor.element : null;
  let targetOffset = anchor.offsetTop;
  if (!target) {
    const row = isUsableElement(list, anchor.rowElement)
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
