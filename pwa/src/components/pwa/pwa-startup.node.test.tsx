import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartupErrorView, StartupLoading } from "./pwa-startup";
import { PwaUiProvider } from "./pwa-ui-provider";

test("renders the startup error with a Mantine reload action", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <StartupErrorView
        error={{ title: "Local workspace is busy", message: "Close the other tab.", action: "Reload the app" }}
        onRetry={() => {}}
      />
    </PwaUiProvider>,
  );
  const reloadButton = html.match(/<button\b[^>]*>(?:(?!<\/button>).)*Reload(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";

  expect(html).toMatch(/Local workspace is busy/);
  expect(html).toMatch(/Close the other tab\./);
  expect(html).toMatch(/Reload the app/);
  expect(reloadButton).toMatch(/pwa-button/);
  expect(reloadButton).toMatch(/data-variant="filled"/);
  expect(reloadButton).toMatch(/type="button"/);
  expect(reloadButton).toMatch(/data-position="left"/);
});

test("startup loading keeps only the background until it is due, then shows the mark and status", () => {
  const render = (visible: boolean) => renderToStaticMarkup(<PwaUiProvider><StartupLoading visible={visible} /></PwaUiProvider>);
  // 启动图之后先接一片同色底，快速打开时不闪出标识与文字。
  const pending = render(false);
  expect(pending).toContain('class="pwa-loading"');
  expect(pending).not.toContain("pwa-loading-mark");
  expect(pending).not.toContain("Opening local workspace");
  const due = render(true);
  expect(due).toContain("pwa-loading-mark");
  expect(due).toContain("Opening local workspace…");
});
