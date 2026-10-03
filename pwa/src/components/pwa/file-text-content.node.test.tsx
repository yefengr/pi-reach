import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTextContent } from "./file-text-content";

describe("file Markdown never acquires resources", () => {
  test("images and HTML cannot become active elements", () => {
    const html = renderToStaticMarkup(<FileTextContent markdown text={'# 文档\n![remote](https://remote.test/a.png)\n![local](file:///tmp/a.svg)\n<img src="https://remote.test/b"><script>alert(1)</script><iframe src="/app"></iframe>'} />);
    expect(html).toContain("<h1>文档</h1>");
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
  test("HTML and SVG source remain escaped plain text", () => {
    const html = renderToStaticMarkup(<FileTextContent markdown={false} text={'<svg onload="alert(1)"></svg>'} />);
    expect(html).toContain("&lt;svg");
    expect(html).not.toContain("<svg");
  });
});
