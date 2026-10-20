import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setLanguagePreference } from "@/lib/i18n";
import { renderPwa } from "@/test/browser/render";
import { PwaUiProvider } from "./pwa-ui-provider";
import { MarkdownContent } from "./timeline-content";

const markdownProbe = vi.hoisted(() => ({ parse: vi.fn() }));

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

beforeEach(() => { setLanguagePreference("en"); markdownProbe.parse.mockClear(); });
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

test("locale updates still reach controls inside unchanged markdown", async () => {
  await renderPwa(<MarkdownContent text={"```ts\nconst answer = 42;\n```"} />);
  const copy = () => document.querySelector<HTMLElement>(".pwa-code-copy");
  await expect.poll(() => copy()?.getAttribute("aria-label")).toBe("Copy code");
  const before = markdownProbe.parse.mock.calls.length;

  setLanguagePreference("zh");
  await expect.poll(() => copy()?.getAttribute("aria-label")).toBe("复制代码");

  expect(markdownProbe.parse.mock.calls.length - before).toBe(0);
});
