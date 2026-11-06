import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { connectionHint, type ConnectionHintMessages } from "@/lib/pwa/connection-hint";
import { ComposerHint } from "./composer-hint";
import { PwaUiProvider } from "./pwa-ui-provider";
import { ConnectionIssueWorkspace } from "./workspace-content";

const messages: ConnectionHintMessages = { reconnecting: "reconnecting", relayAutoRetrying: "auto", unavailable: "unavailable", networkWaiting: "network" };

test("connection hints stay silent during the grace period and escalate from reconnecting to retry", () => {
  expect(connectionHint(null, "retry", true, messages)).toBeNull();
  expect(connectionHint("relay", null, true, messages)).toBeNull();
  expect(connectionHint("relay", "reconnecting", false, messages)).toEqual({ text: "reconnecting", busy: true, retry: false });
  expect(connectionHint("relay", "retry", true, messages)).toEqual({ text: "auto", busy: true, retry: true });
  expect(connectionHint("relay", "retry", false, messages)).toEqual({ text: "unavailable", busy: false, retry: true });
  // 无网络时重试没有意义：只说明原因，不给操作，也不转圈。
  for (const stage of ["reconnecting", "retry"] as const) expect(connectionHint("network", stage, true, messages)).toEqual({ text: "network", busy: false, retry: false });
});

const button = (html: string) => html.match(/<button\b[^>]*>/)?.[0] ?? null;

test.each([false, true])("renders the hint line text action with disabled=%s", (disabled) => {
  const html = renderToStaticMarkup(<PwaUiProvider><ComposerHint hint={{ text: "Can't reach Relay", tone: "neutral", busy: true, action: { label: "Retry now", onAction: () => {}, disabled } }} /></PwaUiProvider>);
  expect(html).toContain('role="status"');
  expect(html).toContain("Retry now");
  expect(button(html)).toContain("pwa-composer-hint-action");
  expect(/\bdisabled(?:=|\s|>)/.test(button(html)!)).toBe(disabled);
});

test("the main empty state offers retry only once the Relay issue reaches the retry stage", () => {
  const render = (props: Parameters<typeof ConnectionIssueWorkspace>[0]) => renderToStaticMarkup(<PwaUiProvider><ConnectionIssueWorkspace {...props} /></PwaUiProvider>);
  const reconnecting = render({ kind: "relay", stage: "reconnecting", busy: true, onRetry: () => {}, retryDisabled: false });
  expect(reconnecting).toContain("Can&#x27;t reach Relay");
  expect(reconnecting).toContain("Reconnecting…");
  expect(button(reconnecting)).toBeNull();
  const retry = render({ kind: "relay", stage: "retry", busy: true, onRetry: () => {}, retryDisabled: true });
  expect(retry).toContain("Retrying automatically…");
  expect(retry).toContain("Retry now");
  expect(/\bdisabled(?:=|\s|>)/.test(button(retry)!)).toBe(true);
  const network = render({ kind: "network", stage: "retry", busy: false, onRetry: () => {}, retryDisabled: false });
  expect(network).toContain("Network unavailable");
  expect(button(network)).toBeNull();
});
