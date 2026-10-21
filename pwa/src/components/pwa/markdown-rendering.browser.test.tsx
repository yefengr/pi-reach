import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setLanguagePreference } from "@/lib/i18n";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
import { MarkdownContent } from "./timeline-content";

const markdownProbe = vi.hoisted(() => ({ parse: vi.fn() }));
const copyProbe = vi.hoisted(() => ({ render: vi.fn() }));

// 用真实 Markdown 组件做探针，只统计解析次数，不改 DOM 与样式。
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const Markdown = actual.default;
  function CountingMarkdown(props: Parameters<typeof Markdown>[0]) {
    markdownProbe.parse();
    return <Markdown {...props} />;
  }
  return { ...actual, default: CountingMarkdown };
});

// CopyButton 只在 CodeBlock 重新渲染时重新执行，用真实组件计数避免把高亮缓存当渲染证据。
vi.mock("./copy-button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./copy-button")>();
  const ActualCopyButton = actual.CopyButton;
  function CountingCopyButton(props: Parameters<typeof ActualCopyButton>[0]) {
    copyProbe.render();
    return <ActualCopyButton {...props} />;
  }
  return { ...actual, CopyButton: CountingCopyButton };
});

const paragraphs = Array.from({ length: 8 }, (_, index) => `Historical paragraph ${index} with **markdown** content.`);

function Transcript({ tail }: { tail: string }) {
  return <div>
    {paragraphs.map(text => <MarkdownContent key={text} text={text} />)}
    <MarkdownContent text={tail} />
  </div>;
}

function transcript(tail: string) {
  return <PwaUiProvider><div className="pwa-root"><Transcript tail={tail} /></div></PwaUiProvider>;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".pwa-markdown")];
}

beforeEach(() => { setLanguagePreference("en"); markdownProbe.parse.mockClear(); copyProbe.render.mockClear(); });
afterEach(() => { setLanguagePreference("system"); });

test("advancing the tail parses one markdown message and keeps the others mounted", async () => {
  const screen = await renderPwa(<Transcript tail="Streaming tail" />);
  await expect.poll(() => rows().length).toBe(paragraphs.length + 1);
  const initial = rows();
  const before = markdownProbe.parse.mock.calls.length;

  await screen.rerender(transcript("Streaming tail **updated**"));
  await expect.poll(() => initial.at(-1)!.querySelector("strong")?.textContent).toBe("updated");

  expect(markdownProbe.parse.mock.calls.length - before).toBe(1);
  const next = rows();
  for (let index = 0; index < paragraphs.length; index += 1) expect(next[index]).toBe(initial[index]);
});

test("re-rendering unchanged text does not parse markdown again", async () => {
  const screen = await renderPwa(<Transcript tail="Stable tail" />);
  await expect.poll(() => rows().length).toBe(paragraphs.length + 1);
  const initial = rows();
  const before = markdownProbe.parse.mock.calls.length;

  await screen.rerender(transcript("Stable tail"));

  expect(markdownProbe.parse.mock.calls.length - before).toBe(0);
  const next = rows();
  expect(next.length).toBe(initial.length);
  next.forEach((row, index) => expect(row).toBe(initial[index]));
});

test("appending prose after a closed fence does not re-render the code block", async () => {
  const code = "```ts\nconst answer = 42;\n```";
  const screen = await renderPwa(<MarkdownContent text={code} />);
  await expect.poll(() => document.querySelector(".pwa-code-copy")).not.toBeNull();
  const block = document.querySelector(".pwa-code-block");
  const renders = copyProbe.render.mock.calls.length;
  expect(renders).toBeGreaterThan(0);

  await screen.rerender(<PwaUiProvider><div className="pwa-root"><MarkdownContent text={`${code}\n\nAfter the fence`} /></div></PwaUiProvider>);
  await expect.poll(() => document.querySelector(".pwa-markdown")?.textContent).toContain("After the fence");

  expect(copyProbe.render.mock.calls.length).toBe(renders);
  expect(document.querySelector(".pwa-code-block")).toBe(block);
});

test("changing code text or language still updates the code block", async () => {
  const screen = await renderPwa(<MarkdownContent text={"```ts\nconst answer = 1;\n```"} />);
  await expect.poll(() => document.querySelector(".pwa-code-language")?.textContent).toBe("ts");
  const renders = copyProbe.render.mock.calls.length;

  await screen.rerender(<PwaUiProvider><div className="pwa-root"><MarkdownContent text={"```js\nconst answer = 2;\n```"} /></div></PwaUiProvider>);
  await expect.poll(() => document.querySelector(".pwa-code-language")?.textContent).toBe("js");
  await expect.poll(() => document.querySelector(".pwa-code-block code")?.textContent).toContain("const answer = 2;");
  expect(copyProbe.render.mock.calls.length).toBeGreaterThan(renders);
});

test("locale updates still reach controls inside unchanged markdown", async () => {
  await renderPwa(<MarkdownContent text={"```ts\nconst answer = 42;\n```"} />);
  const copy = () => document.querySelector<HTMLElement>(".pwa-code-copy");
  await expect.poll(() => copy()?.getAttribute("aria-label")).toBe("Copy code");
  const before = markdownProbe.parse.mock.calls.length;

  setLanguagePreference("zh");
  await expect.poll(() => copy()?.getAttribute("aria-label")).toBe("复制代码");

  expect(markdownProbe.parse.mock.calls.length - before).toBe(0);
});
