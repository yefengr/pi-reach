import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartupErrorView } from "./pwa-startup";
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
