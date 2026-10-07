import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useSettingsRoute, type SettingsRoute } from "./settings-route";

const origin = { kind: "navigation", scrollTop: 120 } as const;
const settingsState = { piReachSettings: { origin } };
let originalState: unknown;
let originalUrl: string;

function RouteHarness({ onCommit }: { onCommit?: (route: SettingsRoute) => void }) {
  const { route, openSettings } = useSettingsRoute();
  useLayoutEffect(() => { onCommit?.(route); }, [onCommit, route]);
  return <>
    <button onClick={() => openSettings(origin)}>Open settings</button>
    <output data-testid="route">{JSON.stringify(route)}</output>
    {route.open ? <div data-testid="settings">Settings</div> : <div data-testid="workspace">Workspace</div>}
  </>;
}

// 只控制事件字段；不模拟浏览器提供的视觉转场。
function popstate(state: unknown, native: boolean | undefined) {
  window.history.replaceState(state, "");
  const event = new PopStateEvent("popstate", { state });
  Object.defineProperty(event, "hasUAVisualTransition", { value: native });
  window.dispatchEvent(event);
}

beforeEach(() => {
  originalState = window.history.state;
  originalUrl = window.location.href;
  window.history.replaceState(null, "");
});
afterEach(() => {
  window.history.replaceState(originalState, "", originalUrl);
  vi.restoreAllMocks();
});

test("commits native back before popstate dispatch returns", async () => {
  const screen = await render(<RouteHarness />);
  await screen.getByRole("button", { name: "Open settings" }).click();
  popstate(null, true);
  // 不包 act、不等待轮询：UA 转场结束时目标界面必须已经提交。
  expect(document.querySelector('[data-testid="settings"]')).toBeNull();
  expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();
  await screen.unmount();
});

test("skips the author animation for native back and forward while preserving origin and change", async () => {
  const screen = await render(<RouteHarness />);
  const readRoute = () => JSON.parse(screen.getByTestId("route").element().textContent!) as SettingsRoute;
  await screen.getByRole("button", { name: "Open settings" }).click();
  popstate(null, true);
  await expect.poll(readRoute).toEqual({ open: false, origin, animate: false, change: 2 });
  popstate(settingsState, true);
  expect(readRoute()).toEqual({ open: true, origin, animate: false, change: 3 });
  expect(document.querySelector('[data-testid="settings"]')).not.toBeNull();
  await screen.unmount();
});

test.each([false, undefined])("keeps ordinary back and forward animated when native is %s", async (native) => {
  const screen = await render(<RouteHarness />);
  const readRoute = () => JSON.parse(screen.getByTestId("route").element().textContent!) as SettingsRoute;
  await screen.getByRole("button", { name: "Open settings" }).click();
  popstate(null, native);
  await expect.poll(readRoute).toEqual({ open: false, origin, animate: true, change: 2 });
  popstate(settingsState, native);
  await expect.poll(readRoute).toEqual({ open: true, origin, animate: true, change: 3 });
  await screen.unmount();
});

test("keeps same-view popstate a no-op and removes the listener on unmount", async () => {
  const commits: SettingsRoute[] = [];
  const onCommit = (route: SettingsRoute) => { commits.push(route); };
  const remove = vi.spyOn(window, "removeEventListener");
  const screen = await render(<RouteHarness onCommit={onCommit} />);
  popstate(null, true);
  expect(commits).toHaveLength(1);
  await screen.getByRole("button", { name: "Open settings" }).click();
  const current = commits.at(-1);
  popstate({ piReachSettings: { origin: { kind: "workspace" } } }, true);
  expect(commits.at(-1)).toBe(current);
  expect(commits).toHaveLength(2);
  await screen.unmount();
  expect(remove.mock.calls.some(([type]) => String(type) === "popstate")).toBe(true);
  popstate(null, true);
  expect(commits).toHaveLength(2);
});
