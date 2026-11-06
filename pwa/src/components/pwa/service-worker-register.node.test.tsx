import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceWorkerNotice } from "./service-worker-register";
import { PwaUiProvider } from "./pwa-ui-provider";

type NoticeOverrides = Partial<React.ComponentProps<typeof ServiceWorkerNotice>>;

function renderNotice(overrides: NoticeOverrides = {}): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <ServiceWorkerNotice onDismiss={() => {}} {...overrides} />
    </PwaUiProvider>,
  );
}

function dismissButton(html: string): string {
  const match = html.match(/<button\b(?=[^>]*aria-label="Dismiss PWA notice")[^>]*>(?:(?!<\/button>).)*<\/button>/);
  expect(match, "expected a PWA notice dismiss button").toBeTruthy();
  return match![0];
}

test("renders the unsupported notice as a polite Mantine Alert with only a dismiss action", () => {
  const html = renderNotice();
  const dismiss = dismissButton(html);

  expect(html).toMatch(/pwa-runtime-notice/);
  expect(html).toMatch(/role="status"/);
  expect(html).toMatch(/aria-live="polite"/);
  expect(html).toMatch(/aria-atomic="true"/);
  expect(html).toMatch(/Offline app mode unavailable/);
  expect(html).toMatch(/cannot provide PWA offline startup/);
  expect(dismiss).toMatch(/pwa-runtime-notice-dismiss/);
  expect(html.match(/<button\b/g)).toHaveLength(1);
});

test("keeps install and update actions out of the persistent capability notice", () => {
  const html = renderNotice();
  expect(html).not.toMatch(/Install|Add to Home Screen|Add to Dock/);
  expect(html).not.toMatch(/Pi Reach update ready|>Refresh</);
});
