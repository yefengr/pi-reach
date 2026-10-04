import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeFileLink } from "@/lib/pwa/file-preview";
import "./timeline-content.css";

const fileMarkdownComponents: Components = {
  // 文档中的图片只保留替代文字，不能产生任何远程或本地资源请求。
  img: ({ alt }) => <span className="pwa-file-image-alt">{alt ?? ""}</span>,
  a: ({ href, children }) => {
    const safe = href ? safeFileLink(href) : undefined;
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  table: ({ children }) => <div className="pwa-markdown-table"><table>{children}</table></div>,
};

/** 文件正文不继承聊天 Markdown 的图片资源与代码高亮策略。 */
export function FileTextContent({ text, markdown }: { text: string; markdown: boolean }) {
  if (!markdown) return <pre className="pwa-file-plain">{text}</pre>;
  return <div className="pwa-markdown pwa-file-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={(url) => safeFileLink(url) ?? ""}
    components={fileMarkdownComponents}
  >{text}</ReactMarkdown></div>;
}
