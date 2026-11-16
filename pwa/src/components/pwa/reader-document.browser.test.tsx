import { useState } from "react";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { resetTextSizeStateForTest, setTextSize, TEXT_SIZE_STORAGE_KEY } from "@/lib/ui/text-size";
import { FileTextContent, type DocumentHeading } from "./file-text-content";
import { ReaderDocument } from "./reader-document";
import { ReaderToc } from "./reader-toc";
import { ReaderShell } from "./reader-shell";
import "./published-files.css";

const markdown = '# Same\n\n## Same\n\n```md\n# fake\n```\n\nSetext\n---\n\n### **Strong** `code` [link](https://example.test)\n\n#### excluded';

test("rendered heading descriptors match actual targets, including duplicates and setext headings", async () => {
  const onHeadings = vi.fn();
  const screen = await renderPwa(<FileTextContent text={markdown} markdown onHeadings={onHeadings} />);
  await expect.poll(() => onHeadings.mock.lastCall?.[0]?.length).toBe(4);
  const headings = onHeadings.mock.lastCall![0] as DocumentHeading[];
  expect(headings.map(heading => [heading.level, heading.text])).toEqual([[1, "Same"], [2, "Same"], [2, "Setext"], [3, "Strong code link"]]);
  expect(new Set(headings.map(heading => heading.id)).size).toBe(4);
  for (const heading of headings) expect(document.getElementById(heading.id)?.textContent).toBe(heading.text);
  await screen.unmount();
});

test("partial Markdown starts in source, preserves file line numbers, and copies the unchanged original", async () => {
  const text = '# Title\n\n## Next\n';
  const onHeadings = vi.fn();
  const preview = vi.fn();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<ReaderDocument text={text} markdown partial startLine={41} onHeadings={onHeadings} onPreviewChange={preview} />);
  await expect.element(screen.getByRole("button", { name: "Source", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect([...document.querySelectorAll(".pwa-reader-line-number")].map(element => element.textContent)).toEqual(["41", "42", "43"]);
  expect(document.querySelector(".pwa-file-markdown")).toBeNull();
  await screen.getByRole("button", { name: "Copy content", exact: true }).click();
  expect(copy).toHaveBeenCalledWith(text);
  await screen.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(() => onHeadings.mock.lastCall?.[0]?.length).toBe(2);
  expect(preview).toHaveBeenLastCalledWith(true);
  await screen.getByRole("button", { name: "Source", exact: true }).click();
  await expect.poll(() => onHeadings.mock.lastCall?.[0]).toEqual([]);
  expect(preview).toHaveBeenLastCalledWith(false);
  copy.mockRestore();
  await screen.unmount();
});

test("source without a reliable starting line never fabricates line numbers", async () => {
  const screen = await renderPwa(<ReaderDocument text="<svg onload='bad'>" markdown={false} />);
  expect(document.querySelector(".pwa-reader-line-number")).toBeNull();
  expect(document.querySelector(".pwa-file-plain")?.textContent).toBe("<svg onload='bad'>");
  expect(document.querySelector("svg[onload]")).toBeNull();
  await screen.unmount();
});

test.each(["standard", "large", "xlarge"] as const)("document toolbar matches the compact design at %s text size", async size => {
  setTextSize(size);
  const screen = await renderPwa(<div style={{ width: "288px" }}><ReaderDocument text="# Title" markdown sourceLabel="Written content" /></div>);
  try {
    const toolbar = document.querySelector<HTMLElement>(".pwa-reader-document-toolbar")!;
    const label = toolbar.querySelector<HTMLElement>(".pwa-reader-source-label")!;
    const actions = toolbar.querySelector<HTMLElement>(".pwa-reader-document-actions")!;
    const preview = screen.getByRole("button", { name: "Preview", exact: true }).element();
    const source = screen.getByRole("button", { name: "Source", exact: true }).element();
    expect(label.textContent).toBe("Written content · Markdown");
    for (const width of [288, 680]) {
      toolbar.parentElement!.parentElement!.style.width = `${width}px`;
      expect(Math.round(label.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(actions.getBoundingClientRect().left));
      expect(Math.round(label.getBoundingClientRect().top)).toBeLessThan(Math.round(actions.getBoundingClientRect().bottom));
      expect(Math.round(label.getBoundingClientRect().bottom)).toBeGreaterThan(Math.round(actions.getBoundingClientRect().top));
      expect(toolbar.scrollWidth).toBe(toolbar.clientWidth);
      for (const button of toolbar.querySelectorAll("button")) {
        expect(Math.round(button.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
        expect(Math.round(button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
    }
    expect(getComputedStyle(toolbar).borderBottomStyle).toBe("solid");
    expect(Number.parseFloat(getComputedStyle(toolbar).borderBottomWidth)).toBeGreaterThan(0);
    expect(getComputedStyle(preview).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(preview).borderRadius).toBe("0px");
    expect(getComputedStyle(preview).borderBottomColor).toBe(getComputedStyle(preview).color);
    expect(getComputedStyle(source).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
    await screen.getByRole("button", { name: "Source", exact: true }).click();
    await expect.poll(() => getComputedStyle(source).borderBottomColor === getComputedStyle(source).color).toBe(true);
    await expect.poll(() => getComputedStyle(preview).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
    expect(document.querySelector(".pwa-file-plain")?.textContent).toBe("# Title");
  } finally {
    await screen.unmount();
    localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
    resetTextSizeStateForTest();
  }
});

test.each([320, 1280])("file metadata shares one toolbar with preview actions at width %s", async width => {
  await page.viewport(width, 740);
  const screen = await renderPwa(<div style={{ width: width === 320 ? "288px" : "680px" }}><ReaderDocument text="# Title" markdown fileInfo="Markdown · 3 KiB" /></div>);
  try {
    const toolbar = document.querySelector<HTMLElement>(".pwa-reader-document-toolbar")!;
    const info = toolbar.querySelector<HTMLElement>(".pwa-reader-file-info")!;
    const actions = toolbar.querySelector<HTMLElement>(".pwa-reader-document-actions")!;
    const content = document.querySelector<HTMLElement>(".pwa-file-markdown")!;
    expect(info.textContent).toBe("Markdown · 3 KiB");
    expect(document.querySelectorAll(".pwa-reader-document-toolbar")).toHaveLength(1);
    expect(Math.round(info.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(actions.getBoundingClientRect().left));
    expect(Math.round(content.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom)).toBe(16);
    expect(Number.parseFloat(getComputedStyle(info).borderBottomWidth)).toBe(0);
    expect(toolbar.scrollWidth).toBe(toolbar.clientWidth);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("document code blocks retain language and a separate original-code copy action", async () => {
  await page.viewport(320, 740);
  const code = `const value = "${"x".repeat(100)}";\n\nconsole.log(value);`;
  const text = `# Title\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nInline \`value\`.`;
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const screen = await renderPwa(<div style={{ width: "288px" }}><ReaderDocument text={text} markdown /></div>);
  try {
    const block = document.querySelector<HTMLElement>(".pwa-file-markdown .pwa-code-block")!;
    expect(block.querySelector(".pwa-code-language")?.textContent).toBe("typescript");
    expect(block.querySelector("pre code")?.textContent).toBe(code);
    expect(block.querySelector(".hljs, script")).toBeNull();
    const button = screen.getByRole("button", { name: "Copy code", exact: true });
    expect(Math.round(button.element().getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(button.element().getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await button.click();
    expect(copy).toHaveBeenLastCalledWith(code);
    await screen.getByRole("button", { name: "Copy content", exact: true }).click();
    expect(copy).toHaveBeenLastCalledWith(text);
    const pre = block.querySelector("pre")!;
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    expect(block.parentElement!.scrollWidth).toBe(block.parentElement!.clientWidth);
    expect(block.querySelector(".pwa-code-head")!.contains(button.element())).toBe(true);
  } finally {
    copy.mockRestore();
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("numbered source wraps long lines beneath the first character and keeps a fixed gutter on narrow screens", async () => {
  await page.viewport(320, 740);
  const label = "Read · L999–1000 · Only part of this document is available";
  const text = `${"x".repeat(300)}\nshort\n`;
  const screen = await renderPwa(<div style={{ width: "288px" }}><ReaderDocument text={text} markdown initialSource startLine={999} sourceLabel={label} /></div>);
  try {
    const source = document.querySelector<HTMLElement>(".pwa-reader-source")!;
    const numbers = [...source.querySelectorAll<HTMLElement>(".pwa-reader-line-number")];
    expect(numbers.map(number => number.textContent)).toEqual(["999", "1000"]);
    expect(Math.round(numbers[0].getBoundingClientRect().width)).toBe(Math.round(numbers[1].getBoundingClientRect().width));
    const firstLine = source.querySelector<HTMLElement>(".pwa-reader-source-text")!;
    const range = document.createRange();
    range.selectNodeContents(firstLine);
    const wrapped = [...range.getClientRects()];
    expect(wrapped.length).toBeGreaterThan(1);
    expect(new Set(wrapped.map(rect => Math.round(rect.left))).size).toBe(1);
    expect(Math.round(wrapped[0].left)).toBe(Math.round(firstLine.getBoundingClientRect().left));
    expect(Math.round(wrapped[1].top)).toBeGreaterThan(Math.round(wrapped[0].top));
    expect(Math.round(source.scrollWidth)).toBeLessThanOrEqual(Math.round(source.clientWidth));
    const toolbar = document.querySelector<HTMLElement>(".pwa-reader-document-toolbar")!;
    const sourceLabel = toolbar.querySelector<HTMLElement>(".pwa-reader-source-label")!;
    const switcher = toolbar.querySelector<HTMLElement>(".pwa-reader-view-switch")!;
    expect(sourceLabel.textContent).toBe(`${label} · Markdown`);
    expect(Math.round(sourceLabel.getBoundingClientRect().right)).toBeLessThanOrEqual(Math.round(switcher.getBoundingClientRect().left));
    expect(Math.round(toolbar.scrollWidth)).toBeLessThanOrEqual(Math.round(toolbar.clientWidth));
    await expect.element(screen.getByRole("button", { name: "Copy content", exact: true })).toBeVisible();
    for (const button of toolbar.querySelectorAll("button")) {
      expect(Math.round(button.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
    await screen.getByRole("button", { name: "Preview", exact: true }).click();
    expect(document.querySelector(".pwa-reader-source-label")?.textContent).toBe(`${label} · Markdown`);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 900);
  }
});

test("inline consumer callbacks settle and source switches never leave invalid TOC targets", async () => {
  const headingsChanged = vi.fn();
  const previewChanged = vi.fn();
  function Harness() {
    const [headings, setHeadings] = useState<readonly DocumentHeading[]>([]);
    const [preview, setPreview] = useState(false);
    const [revision, setRevision] = useState(0);
    return <><button onClick={() => setRevision(value => value + 1)}>Rerender parent {revision}</button>
      <output data-heading-count>{headings.length}</output>
      {preview ? <ReaderToc headings={headings} scroll={null} /> : null}
      <ReaderDocument text={"# First\n\n## Second"} markdown sourceLabel="Pending write content" onHeadings={value => { headingsChanged(value); setHeadings([...value]); }} onPreviewChange={value => { previewChanged(value); setPreview(value); }} />
    </>;
  }
  const screen = await renderPwa(<Harness />);
  await expect.poll(() => headingsChanged.mock.lastCall?.[0]).toHaveLength(2);
  await expect.element(screen.getByRole("button", { name: "Contents", exact: true })).toBeVisible();
  expect(headingsChanged).toHaveBeenCalledTimes(1);
  expect(previewChanged).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Rerender parent 0", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Rerender parent 1", exact: true })).toBeVisible();
  expect(headingsChanged).toHaveBeenCalledTimes(1);
  expect(previewChanged).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Source", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Contents", exact: true })).not.toBeInTheDocument();
  await expect.poll(() => document.querySelector("[data-heading-count]")?.textContent).toBe("0");
  expect(headingsChanged.mock.lastCall?.[0]).toEqual([]);
  expect(previewChanged).toHaveBeenLastCalledWith(false);
  await screen.getByRole("button", { name: "Preview", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Contents", exact: true })).toBeVisible();
  expect(headingsChanged).toHaveBeenCalledTimes(3);
  expect(previewChanged).toHaveBeenCalledTimes(3);
  for (const heading of headingsChanged.mock.lastCall![0] as DocumentHeading[]) expect(document.getElementById(heading.id)?.textContent).toBe(heading.text);
  expect(document.querySelector(".pwa-reader-source-label")?.textContent).toBe("Pending write content · Markdown");
  await screen.unmount();
});

async function tocHarness(text: string, partial = false) {
  function Harness() {
    const [opened, setOpened] = useState(false);
    const [entered, setEntered] = useState(false);
    const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
    const [headings, setHeadings] = useState<readonly DocumentHeading[]>([]);
    const [preview, setPreview] = useState(false);
    return <><button onClick={() => setOpened(true)}>Open document</button><ReaderShell opened={opened} onClose={() => setOpened(false)} onEnterTransitionEnd={() => setEntered(true)} title="Document fixture" closeLabel="Close document" historyKey="readerDocumentTest" actions={preview ? <ReaderToc headings={headings} scroll={scroll} partial={partial} /> : null}>
      {entered ? <div ref={setScroll} className="pwa-file-reader-scroll"><ReaderDocument text={text} markdown partial={partial} initialSource={false} onHeadings={setHeadings} onPreviewChange={setPreview} /></div> : null}
    </ReaderShell></>;
  }
  const screen = await renderPwa(<Harness />);
  await screen.getByRole("button", { name: "Open document" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Document fixture", exact: true })).toBeVisible();
  await expect.poll(() => document.querySelector(".pwa-file-markdown")).not.toBeNull();
  const close = async () => {
    await screen.getByRole("button", { name: "Close document", exact: true }).click();
    await expect.poll(() => window.history.state?.readerDocumentTest).toBeFalsy();
    await expect.element(screen.getByRole("dialog", { name: "Document fixture", exact: true })).not.toBeInTheDocument();
    await screen.unmount();
  };
  return { screen, close };
}

test("TOC needs two rendered headings and disappears in source", async () => {
  const h = await tocHarness("# One\n\n```md\n## fake\n```\n\n#### deep");
  expect(h.screen.getByRole("button", { name: "Contents", exact: true }).query()).toBeNull();
  await h.close();
  const next = await tocHarness("# One\n\n## Two");
  await expect.element(next.screen.getByRole("button", { name: "Contents", exact: true })).toBeVisible();
  await next.screen.getByRole("button", { name: "Source", exact: true }).click();
  await expect.element(next.screen.getByRole("button", { name: "Contents", exact: true })).not.toBeInTheDocument();
  await next.close();
});

test.each([320, 390, 1280].flatMap(width => (["standard", "large", "xlarge"] as const).map(size => ({ width, size }))))("TOC keeps the confirmed width, title and close action at $width / $size", async ({ width, size }) => {
  await page.viewport(width, 740);
  setTextSize(size);
  const h = await tocHarness("# First\n\n## Second");
  try {
    const trigger = h.screen.getByRole("button", { name: "Contents", exact: true });
    (trigger.element() as HTMLButtonElement).focus();
    await trigger.click();
    await expect.poll(() => document.querySelector(".pwa-reader-toc") && getComputedStyle(document.querySelector(".pwa-reader-toc")!).opacity).toBe("1");
    const panel = document.querySelector<HTMLElement>(".pwa-reader-toc")!;
    await expect.poll(() => panel.getAnimations().length).toBe(0);
    expect(Math.round(panel.getBoundingClientRect().width)).toBe(Math.min(320, width - 32));
    expect(panel.querySelector(".pwa-reader-toc-head span")?.textContent).toBe("Contents");
    const item = panel.querySelector<HTMLElement>(".pwa-reader-toc-item")!;
    expect(getComputedStyle(item).fontSize).toBe(getComputedStyle(panel).getPropertyValue("--pwa-text-body").trim());
    expect(Math.round(Number.parseFloat(getComputedStyle(item).lineHeight))).toBe(Math.round(Number.parseFloat(getComputedStyle(item).fontSize) * 1.4));
    const close = h.screen.getByRole("button", { name: "Close contents", exact: true });
    expect(Math.round(close.element().getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(close.element().getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect.poll(() => document.querySelector(".pwa-reader-toc")).toBeNull();
    expect(document.activeElement).toBe(trigger.element());
    await expect.element(h.screen.getByRole("dialog", { name: "Document fixture", exact: true })).toBeVisible();
  } finally {
    await h.close();
    localStorage.removeItem(TEXT_SIZE_STORAGE_KEY);
    resetTextSizeStateForTest();
    await page.viewport(1280, 900);
  }
});

test("system Back while TOC is open preserves the reader history and reading surface", async () => {
  const h = await tocHarness("# First\n\n## Second");
  const trigger = h.screen.getByRole("button", { name: "Contents", exact: true });
  await trigger.click();
  await expect.poll(() => document.querySelector("[data-pwa-reader-overlay]")).not.toBeNull();
  const popped = vi.fn();
  window.addEventListener("popstate", popped);
  window.history.back();
  await expect.poll(() => popped.mock.calls.length).toBeGreaterThan(0);
  await expect.poll(() => history.state?.readerDocumentTest).toBeTruthy();
  await expect.element(h.screen.getByRole("dialog", { name: "Document fixture", exact: true })).toBeVisible();
  window.removeEventListener("popstate", popped);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-reader-toc")).toBeNull();
  await h.close();
});

test.each([null, 0.75, "none"] as const)("TOC owns its scroll, preserves URL/history, jumps only within the reader and reveals the current chapter (scale=%s)", async scale => {
  await page.viewport(390, 740);
  const longTitle = "A long chapter title with enough words to wrap over multiple lines on a narrow phone viewport";
  const text = Array.from({ length: 36 }, (_, index) => `## Chapter ${index} ${longTitle}\n\n${"Paragraph content. ".repeat(30)}`).join("\n\n");
  const h = await tocHarness(text, true);
  const url = location.href;
  const state = history.state;
  const backgroundY = window.scrollY;
  const trigger = h.screen.getByRole("button", { name: "Contents", exact: true });
  (trigger.element() as HTMLButtonElement).focus();
  await trigger.click();
  await expect.poll(() => document.querySelector(".pwa-reader-toc")?.getAttribute("data-pwa-reader-overlay")).toBe("true");
  await expect.poll(() => getComputedStyle(document.querySelector(".pwa-reader-toc")!).opacity).toBe("1");
  const panel = document.querySelector<HTMLElement>(".pwa-reader-toc")!;
  expect(panel.closest(".pwa-root")).not.toBeNull();
  const list = panel.querySelector<HTMLElement>(".pwa-reader-toc-scroll")!;
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(panel.querySelector(".pwa-reader-toc-notice")?.textContent).toBeTruthy();
  await h.screen.getByRole("menuitem", { name: `Chapter 18 ${longTitle}`, exact: true }).click();
  await expect.poll(() => document.querySelector(".pwa-reader-toc")).toBeNull();
  await expect.poll(() => document.querySelector(".pwa-file-reader-scroll")!.scrollTop).toBeGreaterThan(0);
  // 等定位完成后重开，当前章节应在目录自身可见范围内。
  await expect.poll(() => {
    const scroll = document.querySelector(".pwa-file-reader-scroll")!;
    const target = [...scroll.querySelectorAll("h2")][18];
    return Math.round(target.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
  }).toBe(0);
  // 固定菜单进入期的缩放，放大视觉坐标与 scrollTop 布局坐标的差异。
  const enteringStyle = document.createElement("style");
  enteringStyle.textContent = scale === null ? "" : `.pwa-reader-toc { transform: ${scale === "none" ? "none" : `scale(${scale})`} !important; }`;
  document.head.append(enteringStyle);
  try {
    await trigger.click();
    await expect.poll(() => getComputedStyle(document.querySelector(".pwa-reader-toc")!).opacity).toBe("1");
    await expect.poll(() => document.querySelector(".pwa-reader-toc")!.getAnimations().length).toBe(0);
  } finally {
    enteringStyle.remove();
  }
  await expect.poll(() => document.querySelector(".pwa-reader-toc")!.getAnimations().length).toBe(0);
  const selected = document.querySelector<HTMLElement>('[data-reader-current="true"]')!;
  expect(selected.textContent).toBe(`Chapter 18 ${longTitle}`);
  const bounds = document.querySelector(".pwa-reader-toc-scroll")!.getBoundingClientRect();
  expect(Math.round(selected.getBoundingClientRect().top)).toBeGreaterThanOrEqual(Math.round(bounds.top));
  expect(Math.round(selected.getBoundingClientRect().bottom)).toBeLessThanOrEqual(Math.round(bounds.bottom));
  expect(location.href).toBe(url);
  expect(history.state).toEqual(state);
  expect(window.scrollY).toBe(backgroundY);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector(".pwa-reader-toc")).toBeNull();
  await expect.element(h.screen.getByRole("dialog", { name: "Document fixture", exact: true })).toBeVisible();
  expect(document.activeElement).toBe(trigger.element());
  await h.close();
  await page.viewport(1280, 900);
});
