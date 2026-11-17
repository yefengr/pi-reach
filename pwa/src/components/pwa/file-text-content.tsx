import { isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { CopyButton } from "./copy-button";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { safeFileLink } from "@/lib/pwa/file-preview";
import { markdownTableComponents } from "./markdown-table";
import "./timeline-content.css";
import "./reader-document.css";

export type DocumentHeading = { id: string; text: string; level: number };
type MarkdownNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };
const headingText = (node: MarkdownNode): string => node.type === "text" ? node.value ?? "" : node.tagName === "img" ? String(node.properties?.alt ?? "") : (node.children ?? []).map(headingText).join("");

function headingCollector(prefix: string, headings: DocumentHeading[]) {
  return () => (tree: MarkdownNode) => {
    headings.length = 0;
    const visit = (node: MarkdownNode) => {
      if (/^h[1-3]$/.test(node.tagName ?? "")) {
        const id = `${prefix}-heading-${headings.length + 1}`;
        node.properties = { ...node.properties, id };
        headings.push({ id, text: headingText(node), level: Number(node.tagName![1]) });
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function FileCodeBlock({ text, language }: { text: string; language?: string }) {
  const { t } = useI18n();
  return <div className="pwa-code-block">
    <div className="pwa-code-head"><span className="pwa-code-language">{language}</span><CopyButton className="pwa-code-copy" text={text} label={t.files.copyCode} /></div>
    <pre><code>{text}</code></pre>
  </div>;
}

const fileMarkdownComponents: Components = {
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
    const language = /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1];
    return <FileCodeBlock text={String(code?.children ?? "").replace(/\n$/, "")} language={language} />;
  },
  // 文档中的图片只保留替代文字，不能产生任何远程或本地资源请求。
  img: ({ alt }) => <span className="pwa-file-image-alt">{alt ?? ""}</span>,
  a: ({ href, children }) => {
    const safe = href ? safeFileLink(href) : undefined;
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  ...markdownTableComponents,
};

// frontmatter 默认不进入 HTML；复用代码块呈现，并从原文保留边界与换行。
function frontmatterOptions(text: string): Options["remarkRehypeOptions"] {
  return { handlers: { yaml: (state, node, parent) => {
    const code = { type: "code" as const, lang: "yaml", value: text.slice(node.position!.start.offset!, node.position!.end.offset!), position: node.position };
    return state.one(code, parent);
  } } };
}

/** 文件正文不继承聊天 Markdown 的图片资源与代码高亮策略。 */
export function FileTextContent({ text, markdown, allowFrontmatter = true, onHeadings }: { text: string; markdown: boolean; allowFrontmatter?: boolean; onHeadings?: (headings: readonly DocumentHeading[]) => void }) {
  const id = useId();
  const collected = useMemo(() => {
    const headings: DocumentHeading[] = [];
    return { headings, plugin: headingCollector(id, headings), text,
      remarkPlugins: allowFrontmatter ? [remarkGfm, remarkFrontmatter] : [remarkGfm],
      remarkRehypeOptions: frontmatterOptions(text) };
  }, [id, text, allowFrontmatter]);
  const headingsCallback = useRef(onHeadings);
  useLayoutEffect(() => { headingsCallback.current = onHeadings; }, [onHeadings]);
  useEffect(() => {
    headingsCallback.current?.(markdown ? [...collected.headings] : []);
  }, [collected, markdown]);
  if (!markdown) return <pre className="pwa-file-plain">{text}</pre>;
  return <div className="pwa-markdown pwa-file-markdown"><ReactMarkdown
    remarkPlugins={collected.remarkPlugins}
    remarkRehypeOptions={collected.remarkRehypeOptions}
    rehypePlugins={[collected.plugin]}
    skipHtml
    urlTransform={(url) => safeFileLink(url) ?? ""}
    components={fileMarkdownComponents}
  >{collected.text}</ReactMarkdown></div>;
}
