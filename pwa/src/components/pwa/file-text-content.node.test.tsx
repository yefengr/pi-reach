import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { FileTextContent } from "./file-text-content";

describe("file Markdown frontmatter", () => {
  test.each(["\n", "\r\n"])("preserves YAML as literal code with %j line endings", newline => {
    const metadata = ["---", "name: example-skill", "description: |", "  # not a heading", '  <img src="https://remote.test/private">', "---"].join(newline);
    const html = renderToStaticMarkup(<MantineProvider><FileTextContent markdown text={`${metadata}${newline}${newline}# Body`} /></MantineProvider>);
    expect(html).toContain('class="pwa-code-language">yaml</span>');
    expect(html).toContain(`---${newline}name: example-skill${newline}`);
    expect(html).toContain("# not a heading");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<hr\b|<h2\b|<img\b/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 id="[^"]+">Body<\/h1>/);
  });

  test("leaves ordinary rules, setext headings, and fenced metadata unchanged", () => {
    const text = 'Introduction\n\n---\n\nname: ordinary text\n---\n\n```yaml\n---\nname: fenced\n---\n```';
    const html = renderToStaticMarkup(<MantineProvider><FileTextContent markdown text={text} /></MantineProvider>);
    expect(html.match(/<hr\/>/g)).toHaveLength(1);
    expect(html).toMatch(/<h2 id="[^"]+">name: ordinary text<\/h2>/);
    expect(html.match(/class="pwa-code-language">yaml<\/span>/g)).toHaveLength(1);
    expect(html).toContain("---\nname: fenced\n---");
  });

  test("preserves UTF-8 BOM input and an empty metadata section", () => {
    for (const metadata of ["\uFEFF---\nname: example-skill\n---", "---\n---"]) {
      const html = renderToStaticMarkup(<MantineProvider><FileTextContent markdown text={`${metadata}\n\n# Body`} /></MantineProvider>);
      expect(html).toContain('class="pwa-code-language">yaml</span>');
      expect(html).not.toContain("<hr/>");
      expect(html).toMatch(/<h1 id="[^"]+">Body<\/h1>/);
    }
  });

  test("does not swallow an unclosed metadata block", () => {
    const html = renderToStaticMarkup(<FileTextContent markdown text={"---\nname: example-skill\ndescription: unfinished\n\n# Body"} />);
    expect(html).toContain("name: example-skill");
    expect(html).toContain("description: unfinished");
    expect(html).toContain("<hr/>");
    expect(html).toMatch(/<h1 id="[^"]+">Body<\/h1>/);
  });
});

describe("file Markdown never acquires resources", () => {
  test("images and HTML cannot become active elements", () => {
    const html = renderToStaticMarkup(<FileTextContent markdown text={'# 文档\n![remote](https://remote.test/a.png)\n![local](file:///tmp/a.svg)\n<img src="https://remote.test/b"><script>alert(1)</script><iframe src="/app"></iframe>'} />);
    expect(html).toMatch(/<h1 id="[^"]+">文档<\/h1>/);
    expect(html).toContain("remote");
    expect(html).not.toMatch(/<(img|script|iframe)\b/);
    expect(html).not.toContain("remote.test");
  });
  test("links use safe HTTP(S) only, in a separate window", () => {
    const html = renderToStaticMarkup(<FileTextContent markdown text={'[safe](https://example.test/a) [local](/tmp/x) [bad](javascript:alert%281%29)'} />);
    expect(html).toContain('href="https://example.test/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="/tmp');
    expect(html).not.toContain("javascript:");
  });
  test("headings come from rendered Markdown and each duplicate has a stable unique target", () => {
    const text = '# Same\n## Same\n\n```md\n# fake\n```\n\nSetext\n---\n\n### **Strong** `code` [link](https://example.test)\n#### ignored';
    const render = () => renderToStaticMarkup(<MantineProvider><FileTextContent markdown text={text} /></MantineProvider>);
    const html = render();
    const headings = [...html.matchAll(/<h([1-3]) id="([^"]+)">/g)];
    expect(headings.map(match => match[1])).toEqual(["1", "2", "2", "3"]);
    expect(new Set(headings.map(match => match[2])).size).toBe(4);
    expect(html).toContain("# fake");
    expect(html).toContain('class="pwa-code-language">md</span>');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).not.toContain("hljs");
    expect(html).toContain("<h4>ignored</h4>");
    expect(render()).toBe(html);
  });
  test("HTML and SVG source remain escaped plain text", () => {
    const html = renderToStaticMarkup(<FileTextContent markdown={false} text={'<svg onload="alert(1)"></svg>'} />);
    expect(html).toContain("&lt;svg");
    expect(html).not.toContain("<svg");
  });
});
