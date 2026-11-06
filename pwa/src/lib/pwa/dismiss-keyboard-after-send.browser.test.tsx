import { afterEach, expect, test, vi } from "vitest";
import { MOBILE_LAYOUT_QUERY, TOUCH_INPUT_QUERY } from "@/lib/ui/viewport-queries";
import { dismissKeyboardAfterSend } from "./dismiss-keyboard-after-send";

/** 只替换布局与触屏两条查询；无头 Chromium 关闭触控模拟后无法恢复指针媒体特性，这里不用真实模拟。 */
function stubDevice({ mobile, touch }: { mobile: boolean; touch: boolean }) {
  const original = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query === MOBILE_LAYOUT_QUERY) return { ...original(query), matches: mobile };
    if (query === TOUCH_INPUT_QUERY) return { ...original(query), matches: touch };
    return original(query);
  });
}

function mountComposer({ ownSend }: { ownSend: boolean }) {
  const footer = document.createElement("div");
  footer.className = "pwa-chat-footer";
  if (ownSend) footer.dataset.ownSend = "";
  const input = document.createElement("textarea");
  footer.append(input);
  document.body.append(footer);
  input.focus();
  return { footer, input };
}

const mutationsDelivered = () => new Promise<void>(resolve => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test("waits for the own-send transition to finish before dismissing the keyboard on a touch phone", async () => {
  stubDevice({ mobile: true, touch: true });
  const { footer, input } = mountComposer({ ownSend: true });
  dismissKeyboardAfterSend(input);
  await mutationsDelivered();
  expect(document.activeElement).toBe(input);
  delete footer.dataset.ownSend;
  await mutationsDelivered();
  expect(document.activeElement).not.toBe(input);
});

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

test("dismisses on the next frame when no own-send transition is running", async () => {
  stubDevice({ mobile: true, touch: true });
  const { input } = mountComposer({ ownSend: false });
  dismissKeyboardAfterSend(input);
  await nextFrame();
  expect(document.activeElement).not.toBe(input);
});

test("keeps the keyboard when the send failed and the draft was kept", async () => {
  stubDevice({ mobile: true, touch: true });
  const { input } = mountComposer({ ownSend: false });
  input.value = "Retry me";
  dismissKeyboardAfterSend(input);
  await nextFrame();
  expect(document.activeElement).toBe(input);
});

test("keeps the keyboard when the next message was started during the transition", async () => {
  stubDevice({ mobile: true, touch: true });
  const { footer, input } = mountComposer({ ownSend: true });
  dismissKeyboardAfterSend(input);
  input.value = "Next";
  delete footer.dataset.ownSend;
  await mutationsDelivered();
  expect(document.activeElement).toBe(input);
});

test("stops waiting after cancel", async () => {
  stubDevice({ mobile: true, touch: true });
  const { footer, input } = mountComposer({ ownSend: true });
  dismissKeyboardAfterSend(input)();
  delete footer.dataset.ownSend;
  await mutationsDelivered();
  expect(document.activeElement).toBe(input);
});

test.each([
  { mobile: false, touch: true },
  { mobile: true, touch: false },
])("keeps focus outside touch phone layouts: %o", async (device) => {
  stubDevice(device);
  const { input } = mountComposer({ ownSend: false });
  dismissKeyboardAfterSend(input);
  await nextFrame();
  expect(document.activeElement).toBe(input);
});

test("does nothing when focus already left the input", async () => {
  stubDevice({ mobile: true, touch: true });
  const { input } = mountComposer({ ownSend: false });
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  dismissKeyboardAfterSend(input);
  await nextFrame();
  expect(document.activeElement).toBe(other);
});
