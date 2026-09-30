import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceWorkerNotice } from "./service-worker-register";
import { PwaUiProvider } from "./pwa-ui-provider";

type NoticeOverrides = Partial<React.ComponentProps<typeof ServiceWorkerNotice>>;

function renderNotice(overrides: NoticeOverrides = {}): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <ServiceWorkerNotice
        installPrompt={false}
        unsupported={false}
        onInstall={() => {}}
        onDismiss={() => {}}
        {...overrides}
      />
    </PwaUiProvider>,
  );
}

function buttonForLabel(html: string, label: string): string {
  const match = html.match(new RegExp(`<button\\b[^>]*>(?:(?!<\\/button>).)*${label}(?:(?!<\\/button>).)*<\\/button>`));
  expect(match, `expected a button labelled ${label}`).toBeTruthy();
  return match![0];
}

function dismissButton(html: string): string {
  const match = html.match(/<button\b(?=[^>]*aria-label="Dismiss PWA notice")[^>]*>(?:(?!<\/button>).)*<\/button>/);
  expect(match, "expected a PWA notice dismiss button").toBeTruthy();
  return match![0];
}

test("renders the install notice as a polite Mantine Alert with preserved actions", () => {
  const html = renderNotice({ installPrompt: true });
  const install = buttonForLabel(html, "Install app");
  const dismiss = dismissButton(html);

  expect(html).toMatch(/pwa-runtime-notice/);
  expect(html).toMatch(/role="status"/);
  expect(html).toMatch(/aria-live="polite"/);
  expect(html).toMatch(/aria-atomic="true"/);
  expect(html).toMatch(/Install Pi Reach/);
  expect(install).toMatch(/pwa-button/);
  expect(install).toMatch(/data-variant="default"/);
  expect(install).toMatch(/type="button"/);
  expect(dismiss).toMatch(/pwa-runtime-notice-dismiss/);
});

test("keeps update actions out of the persistent install and capability notice", () => {
  const html = renderNotice({ installPrompt: true });
  expect(buttonForLabel(html, "Install app")).toMatch(/data-variant="default"/);
  expect(html).not.toMatch(/Pi Reach update ready|>Refresh</);
});

test("keeps unsupported mode ahead of the install action", () => {
  const html = renderNotice({ unsupported: true, installPrompt: true });
  const dismiss = dismissButton(html);

  expect(html).toMatch(/Offline app mode unavailable/);
  expect(html).toMatch(/cannot provide PWA offline startup/);
  expect(dismiss).toMatch(/pwa-runtime-notice-dismiss/);
  expect(buttonForLabel(html, "Install app")).toMatch(/data-variant="default"/);
  expect(html).not.toMatch(/Pi Reach update ready|>Refresh</);
});
