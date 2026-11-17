import type { ReactNode } from "react";
import type { Components } from "react-markdown";

/** 列宽交给原生自动布局：优先按容器宽度分配，内容完整换行，不做逐字测量或写入内联宽度。 */
function MarkdownTable({ children }: { children?: ReactNode }) {
  return <div className="pwa-markdown-table"><table>{children}</table></div>;
}

/** 单元格内容包一层以保留列宽下限与长词换行；GFM 对齐以 style 传入。 */
export const markdownTableComponents: Components = {
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  th: ({ style, children }) => <th style={style}><div className="pwa-markdown-cell">{children}</div></th>,
  td: ({ style, children }) => <td style={style}><div className="pwa-markdown-cell">{children}</div></td>,
};
