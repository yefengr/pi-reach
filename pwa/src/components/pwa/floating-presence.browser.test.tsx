import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { readPwaMotionDuration } from "@/lib/ui/motion-duration";
import { PwaConnectionBanner, PwaMessageActions, PwaStatusError } from "./pwa-app-actions";
import type { ConnectionViewState } from "./workspace-view";

type ActionsState = { latest: boolean; retry: boolean; unread: number };

let setActions!: (state: ActionsState) => void;
function Actions({ onLatest }: { onLatest: () => void }) {
  const [state, setState] = useState<ActionsState>({ latest: false, retry: false, unread: 0 });
  useLayoutEffect(() => { setActions = setState; }, []);
  return <div style={{ position: "relative", marginTop: 200 }}><PwaMessageActions show={state.latest || state.retry} showRetry={state.retry} showLatest={state.latest} unreadOutput={state.unread} onRetry={() => {}} onLatest={onLatest} /></div>;
}

afterEach(async () => { await cdp().send("Emulation.setEmulatedMedia", { features: [] }); });

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const latestWrapper = () => document.querySelector<HTMLElement>(".pwa-message-action:has(button svg.lucide-arrow-down-to-line)");
const opacity = (element: Element) => Number(getComputedStyle(element).opacity);
const fadeMs = () => readPwaMotionDuration("--pwa-duration-fade");
/** 指针命中测试：inert 元素不接收用户点击（脚本调用 click() 不受 inert 限制，不能用来验证）。 */
function hitsInside(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return hit !== null && element.contains(hit);
}

test("Latest fades and rises in, then fades out without accepting clicks before it is removed", async () => {
  const onLatest = vi.fn();
  const screen = await renderPwa(<Actions onLatest={onLatest} />);
  try {
    flushSync(() => setActions({ latest: true, retry: false, unread: 0 }));
    const wrapper = latestWrapper()!;
    await frame();
    // 出现从透明与下方开始过渡，而不是直接显示。
    expect(opacity(wrapper)).toBeLessThan(1);
    expect(getComputedStyle(wrapper).transform).not.toBe("none");
    await expect.poll(() => opacity(wrapper)).toBe(1);
    await expect.poll(() => getComputedStyle(wrapper).transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expect(hitsInside(wrapper)).toBe(true);

    flushSync(() => setActions({ latest: false, retry: false, unread: 0 }));
    expect(latestWrapper()).toBe(wrapper);
    expect(wrapper.dataset.presence).toBe("leaving");
    expect(wrapper.inert).toBe(true);
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Latest" }).query()).toBeNull();
    expect(hitsInside(wrapper)).toBe(false);
    await expect.poll(() => latestWrapper(), { timeout: fadeMs() + 1000 }).toBeNull();
    expect(document.querySelector(".pwa-message-actions")).toBeNull();
  } finally { await screen.unmount(); }
});

test("a reappearing entry reverses from where it is, and the unread count stays put while it fades", async () => {
  const screen = await renderPwa(<Actions onLatest={() => {}} />);
  try {
    flushSync(() => setActions({ latest: true, retry: false, unread: 3 }));
    const wrapper = latestWrapper()!;
    await expect.poll(() => opacity(wrapper)).toBe(1);

    flushSync(() => setActions({ latest: false, retry: false, unread: 0 }));
    expect(wrapper.textContent).toBe("3 new output");
    await frame();
    flushSync(() => setActions({ latest: true, retry: false, unread: 0 }));
    // 同一个节点直接反向，不卸载重来；文字原位更新。
    expect(latestWrapper()).toBe(wrapper);
    expect(wrapper.dataset.presence).toBeUndefined();
    expect(wrapper.inert).toBe(false);
    expect(wrapper.textContent).toBe("Latest");
    await new Promise((resolve) => setTimeout(resolve, fadeMs() + 100));
    expect(latestWrapper()).toBe(wrapper);
    await expect.poll(() => opacity(wrapper)).toBe(1);
  } finally { await screen.unmount(); }
});

test("Retry enters on its own without replaying Latest", async () => {
  const screen = await renderPwa(<Actions onLatest={() => {}} />);
  try {
    flushSync(() => setActions({ latest: true, retry: false, unread: 0 }));
    const wrapper = latestWrapper()!;
    await expect.poll(() => opacity(wrapper)).toBe(1);
    flushSync(() => setActions({ latest: true, retry: true, unread: 0 }));
    expect(latestWrapper()).toBe(wrapper);
    await frame();
    expect(opacity(wrapper)).toBe(1);
    const retry = screen.getByRole("button", { name: "Try again" }).element().parentElement!;
    expect(opacity(retry)).toBeLessThan(1);
  } finally { await screen.unmount(); }
});

let setBanner!: (state: { kind: "relay" | null; connection: ConnectionViewState }) => void;
function Banner() {
  const [state, setState] = useState<{ kind: "relay" | null; connection: ConnectionViewState }>({ kind: "relay", connection: "retrying" });
  useLayoutEffect(() => { setBanner = setState; }, []);
  return <div className="pwa-root"><PwaConnectionBanner kind={state.kind} connection={state.connection} onRetry={() => {}} /></div>;
}

test("the connection banner keeps its reconnecting text while it fades out after recovery", async () => {
  const screen = await renderPwa(<Banner />);
  try {
    const banner = document.querySelector<HTMLElement>(".pwa-connection-banner")!;
    await expect.poll(() => opacity(banner)).toBe(1);
    flushSync(() => setBanner({ kind: null, connection: "online" }));
    expect(document.querySelector(".pwa-connection-banner")).toBe(banner);
    expect(banner.textContent).toContain("Can't reach Relay. Retrying…");
    expect(banner.dataset.presence).toBe("leaving");
    expect(banner.inert).toBe(true);
    await expect.poll(() => document.querySelector(".pwa-connection-banner"), { timeout: fadeMs() + 1000 }).toBeNull();
  } finally { await screen.unmount(); }
});

let setError!: (message: string | null) => void;
function StatusError({ onDismiss }: { onDismiss: () => void }) {
  const [message, setMessage] = useState<string | null>("Could not update local history.");
  useLayoutEffect(() => { setError = setMessage; }, []);
  return <PwaStatusError message={message} onDismiss={() => { onDismiss(); setMessage(null); }} />;
}

test("a dismissed error fades out with its text, and its dismiss button cannot be pressed again", async () => {
  const onDismiss = vi.fn();
  const screen = await renderPwa(<StatusError onDismiss={onDismiss} />);
  try {
    const error = document.querySelector<HTMLElement>(".pwa-status-error")!;
    await expect.poll(() => opacity(error)).toBe(1);
    await screen.getByRole("button", { name: "Dismiss" }).click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(document.querySelector(".pwa-status-error")).toBe(error);
    expect(error.textContent).toContain("Could not update local history.");
    expect(error.inert).toBe(true);
    expect(hitsInside(error.querySelector("button")!)).toBe(false);
    await expect.poll(() => document.querySelector(".pwa-status-error"), { timeout: fadeMs() + 1000 }).toBeNull();

    // 新的错误照常出现。
    flushSync(() => setError("Could not update local history."));
    await expect.poll(() => document.querySelector(".pwa-status-error")).not.toBeNull();
  } finally { await screen.unmount(); }
});

test("reduced motion keeps only the fade, without the shift", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const screen = await renderPwa(<Actions onLatest={() => {}} />);
  try {
    flushSync(() => setActions({ latest: true, retry: false, unread: 0 }));
    const wrapper = latestWrapper()!;
    await frame();
    expect(getComputedStyle(wrapper).transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expect(opacity(wrapper)).toBeLessThan(1);
    await expect.poll(() => opacity(wrapper)).toBe(1);
    flushSync(() => setActions({ latest: false, retry: false, unread: 0 }));
    await frame();
    expect(getComputedStyle(wrapper).transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await expect.poll(() => latestWrapper(), { timeout: fadeMs() + 1000 }).toBeNull();
  } finally { await screen.unmount(); }
});
