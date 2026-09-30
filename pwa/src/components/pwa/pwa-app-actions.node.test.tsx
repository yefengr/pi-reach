import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PwaConnectionBanner, PwaMessageActions, PwaStatusToast } from "./pwa-app-actions";
import { PwaUiProvider } from "./pwa-ui-provider";

function renderActions(unreadOutput = 3): string {
  return renderToStaticMarkup(
    <PwaUiProvider>
      <div className="pwa-root">
        <PwaMessageActions show showRetry showLatest unreadOutput={unreadOutput} onRetry={() => {}} onLatest={() => {}} />
        <PwaStatusToast message="Relay is not connected." onDismiss={() => {}} />
      </div>
    </PwaUiProvider>,
  );
}

test("renders Mantine message and toast actions with their semantics", () => {
  const html = renderActions();

  expect(html).toMatch(/pwa-button/);
  expect(html).toMatch(/pwa-icon-button/);
  expect(html).toMatch(/>Try again</);
  expect(html).toMatch(/>3 new output</);
  expect(html).toMatch(/role="status"/);
  expect(html).toMatch(/Message could not be sent\. Check the connection and try again\./);
  expect(html).not.toMatch(/Relay is not connected/);
  expect(html).toMatch(/aria-label="Dismiss"/);
});

test("renders readable, passive connection banners with status semantics", () => {
  const html = renderToStaticMarkup(
    <PwaUiProvider>
      <PwaConnectionBanner kind="relay" connection="retrying" />
      <PwaConnectionBanner kind="network" connection="no_network" />
      <PwaConnectionBanner kind="relay" connection="offline" />
    </PwaUiProvider>,
  );

  expect(html.match(/role="status"/g)).toHaveLength(3);
  expect(html).toMatch(/reach Relay\. Retrying…/);
  expect(html).toMatch(/Network unavailable\. Check your connection\./);
  expect(html).toMatch(/Connection unavailable\. Try again\./);
  expect(html).not.toMatch(/<button/);
  expect(html).not.toMatch(/Dismiss|Close/);
});

test.each([
  ["retrying", false, false],
  ["offline", false, false],
  ["connecting", true, false],
  ["no_network", true, false],
  ["retrying", true, true],
] as const)("renders the retry action for %s with disabled=%s and explicit lock=%s", (connection, disabled, retryDisabled) => {
  const html = renderToStaticMarkup(<PwaUiProvider><PwaConnectionBanner kind={connection === "no_network" ? "network" : "relay"} connection={connection} onRetry={() => {}} retryDisabled={retryDisabled} /></PwaUiProvider>);
  expect(html).toContain("Retry now");
  const button = html.match(/<button\b[^>]*>/)?.[0];
  expect(button).toBeDefined();
  expect(/\bdisabled(?:=|\s|>)/.test(button!)).toBe(disabled);
});

test("renders Latest when output is unread-free", () => {
  const html = renderActions(0);

  expect(html).toMatch(/>Latest</);
  expect(html).not.toMatch(/new output/);
});

test("does not expose arbitrary raw errors in the remaining toast", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><PwaStatusToast message="WebSocket endpoint_id=550e8400-e29b-41d4-a716-446655440000" onDismiss={() => {}} /></PwaUiProvider>);
  expect(html).toMatch(/Something went wrong\. Try again\./);
  expect(html).not.toMatch(/WebSocket|endpoint_id|550e8400/);
});

test("does not render the toast without a message", () => {
  const html = renderToStaticMarkup(<PwaUiProvider><PwaStatusToast message={null} onDismiss={() => {}} /></PwaUiProvider>);

  expect(html).not.toMatch(/pwa-toast/);
  expect(html).not.toMatch(/Dismiss/);
});

test("does not render message actions without visible actions", () => {
  const hidden = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show={false} showRetry showLatest unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);
  const empty = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry={false} showLatest={false} unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);

  expect(hidden).not.toMatch(/pwa-message-actions/);
  expect(empty).not.toMatch(/pwa-message-actions/);
});

test("renders Retry and Latest independently", () => {
  const retry = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry showLatest={false} unreadOutput={3} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);
  const latest = renderToStaticMarkup(<PwaUiProvider><PwaMessageActions show showRetry={false} showLatest unreadOutput={0} onRetry={() => {}} onLatest={() => {}} /></PwaUiProvider>);

  expect(retry).toMatch(/>Try again</);
  expect(retry).not.toMatch(/>Latest</);
  expect(latest).toMatch(/>Latest</);
  expect(latest).not.toMatch(/>Try again</);
});
