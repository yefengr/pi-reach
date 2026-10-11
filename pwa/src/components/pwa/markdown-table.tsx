import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Components } from "react-markdown";

const MAX_CELL_LINES = 2;
/** 换行落在词边界，按一半宽度排版仍可能多出一行；每轮把超高单元格放宽 25%，最多几轮即收敛到单行宽度。 */
const WIDEN_FACTOR = 1.25;
const MAX_FIT_PASSES = 4;
/** 行高换算存在亚像素误差，判断超高时留 1px 余量。 */
const HEIGHT_TOLERANCE_PX = 1;

/**
 * 单元格不截断、最多两行：按单行宽度的一半设最小宽度，超高的再逐轮放宽；列宽之和超出容器时由外层横向滚动。
 * 读写分批进行，每轮只触发一次布局。
 */
function fitCellsToLines(table: HTMLTableElement) {
  const cells = [...table.querySelectorAll<HTMLElement>(".pwa-markdown-cell")];
  for (const cell of cells) { cell.style.minWidth = ""; cell.style.width = "max-content"; }
  const singleLineWidths = cells.map((cell) => cell.getBoundingClientRect().width);
  for (const cell of cells) cell.style.width = "";
  let pending = cells.map((cell, index) => ({ cell, singleLine: singleLineWidths[index]!, width: Math.ceil(singleLineWidths[index]! / MAX_CELL_LINES) }));
  for (let pass = 0; pass < MAX_FIT_PASSES && pending.length > 0; pass += 1) {
    for (const item of pending) item.cell.style.minWidth = `max(var(--pwa-markdown-cell-min), ${item.width}px)`;
    pending = pending.filter(({ cell }) => {
      const maxHeight = Number.parseFloat(getComputedStyle(cell).lineHeight) * MAX_CELL_LINES + HEIGHT_TOLERANCE_PX;
      return cell.getBoundingClientRect().height > maxHeight;
    });
    for (const item of pending) item.width = Math.min(item.singleLine, Math.ceil(item.width * WIDEN_FACTOR));
  }
  // 轮数用尽仍超高（如长标识符夹在短词之间）时直接取单行宽度，单行必然不超过两行。
  for (const item of pending) item.cell.style.minWidth = `max(var(--pwa-markdown-cell-min), ${Math.ceil(item.singleLine)}px)`;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const fittedMarkupRef = useRef<string | null>(null);
  // 不设依赖：时间线流式更新会重渲染全部历史行，children 每次都是新对象，只能以测量后的 DOM 判断表格是否真的变化；
  // 未变化时在任何布局读取之前返回，避免每帧对所有历史表格强制重排。隐藏时测不到宽度，等到可见再测一次。
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || table.innerHTML === fittedMarkupRef.current) return;
    const fit = () => {
      fitCellsToLines(table);
      fittedMarkupRef.current = table.innerHTML;
    };
    if (table.offsetWidth > 0 || typeof ResizeObserver === "undefined") {
      fit();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (table.offsetWidth === 0) return;
      observer.disconnect();
      fit();
    });
    observer.observe(table);
    return () => observer.disconnect();
  });
  return <div className="pwa-markdown-table"><table ref={tableRef}>{children}</table></div>;
}

/** 单元格内容包一层用于测量和设置最小宽度；GFM 对齐以 style 传入。 */
export const markdownTableComponents: Components = {
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  th: ({ style, children }) => <th style={style}><div className="pwa-markdown-cell">{children}</div></th>,
  td: ({ style, children }) => <td style={style}><div className="pwa-markdown-cell">{children}</div></td>,
};
