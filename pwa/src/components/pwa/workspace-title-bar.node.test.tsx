import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceTitleBar } from "./workspace-title-bar";
import { PwaUiProvider } from "./pwa-ui-provider";

function render(props: Partial<Parameters<typeof WorkspaceTitleBar>[0]> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><WorkspaceTitleBar title="Release check" showTitle navigationExpanded={false} onOpenNavigation={() => {}} onRefresh={() => {}} {...props} /></PwaUiProvider>);
}

test("renders the session title, directory prefix, refresh and navigation entry", () => {
  const html = render({ prefix: "pi-reach", status: <span className="probe-status">Connected</span>, moreMenu: <button type="button">More</button> });
  expect(html).toMatch(/<h1 class="pwa-title-bar-name" title="pi-reach · Release check">/);
  expect(html).toContain("pwa-title-bar-prefix");
  expect(html).toContain("probe-status");
  expect(html).toMatch(/aria-label="Refresh app"/);
  // 移动端入口：菜单图标与会话名共同构成导航按钮。
  expect(html).toMatch(/class="[^"]*pwa-session-trigger[^"]*"[^>]*aria-label="Open navigation"/);
  expect(html).toMatch(/aria-haspopup="dialog"/);
  expect(html).toMatch(/aria-expanded="false"/);
  expect(html).not.toContain("pwa-notice-dot");
});

test("shows the history kicker, hides the desktop title without a session, and marks background completions", () => {
  expect(render({ kicker: "Local history · Read only" })).toContain("pwa-title-bar-kicker");
  const idle = render({ showTitle: false, title: "Studio Mac", navigationNotice: true });
  expect(idle).not.toContain("pwa-title-bar-name");
  expect(idle).toContain("Studio Mac");
  expect(idle).toContain("pwa-notice-dot");
});
