import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceTitleBar } from "./workspace-title-bar";
import { PwaUiProvider } from "./pwa-ui-provider";

function render(props: Partial<Parameters<typeof WorkspaceTitleBar>[0]> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><WorkspaceTitleBar title="Release check" showTitle navigationExpanded={false} onOpenNavigation={() => {}} onRefresh={() => {}} {...props} /></PwaUiProvider>);
}

test("renders the session title, project line, refresh and navigation entry", () => {
  const html = render({ prefix: "pi-reach", status: <span className="probe-status">Connected</span>, moreMenu: <button type="button">More</button> });
  // 会话名是唯一的 h1，title 只含会话名；项目名是它后面的普通文本行。
  expect(html).toMatch(/<h1 class="pwa-title-bar-name" title="Release check">Release check<\/h1>/);
  expect(html).toMatch(/<div class="pwa-title-bar-project" title="pi-reach">pi-reach<\/div>/);
  expect(html).not.toContain("·");
  expect(html.indexOf("pwa-title-bar-name")).toBeLessThan(html.indexOf("pwa-title-bar-project"));
  expect(html.match(/<h1/g) ?? []).toHaveLength(1);
  expect(html).toContain("probe-status");
  expect(html).toMatch(/aria-label="Refresh app"/);
  // 移动端入口：菜单图标与会话名共同构成导航按钮。
  expect(html).toMatch(/class="[^"]*pwa-session-trigger[^"]*"[^>]*aria-label="Open navigation"/);
  expect(html).toMatch(/aria-haspopup="dialog"/);
  expect(html).toMatch(/aria-expanded="false"/);
  expect(html).not.toContain("pwa-notice-dot");
});

test("keeps the project line out when there is no prefix", () => {
  const html = render();
  expect(html).toMatch(/<h1 class="pwa-title-bar-name" title="Release check">Release check<\/h1>/);
  expect(html).not.toContain("pwa-title-bar-project");
});

test("hides the desktop title without a session and marks background completions", () => {
  const idle = render({ showTitle: false, title: "Studio Mac", prefix: "pi-reach", navigationNotice: true });
  expect(idle).not.toContain("pwa-title-bar-name");
  expect(idle).not.toContain("pwa-title-bar-project");
  expect(idle).toContain("Studio Mac");
  expect(idle).toContain("pwa-notice-dot");
});
