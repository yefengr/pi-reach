import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import { enableTouch, resetTouch, touchDrag, touchOrigin } from "@/test/browser/swipe";
import { MessageList } from "./message-list";
import type { SummaryEvent } from "./summary-presentation";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";

const summary: SummaryEvent = { event_id: "summary", session_id: "session", leaf_id: "leaf", timestamp: 1, kind: "compaction", payload: { summary: "## Original heading\n\nOriginal English instructions.", details: "HIDDEN_DETAIL", internal_id: "HIDDEN_ID" }, truncated: false };
const error: SummaryEvent = { ...summary, group_id: "group", kind: "provider_error", message: "HTTP 429 Authorization: Bearer PRIVATE_TOKEN\nrequest body\nstack trace" };

afterEach(async () => {
  vi.restoreAllMocks();
  await page.viewport(1280, 900);
});

async function harness(initial: TimelineEvent[], reading = vi.fn()) {
  let update!: (events: TimelineEvent[]) => void;
  function Harness() {
    const [events, setEvents] = useState(initial);
    update = events => flushSync(() => setEvents(events));
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
      <MessageList items={events.map(event => ({ kind: "event", event }))} hasEarlier={false} listRef={useRef<HTMLDivElement>(null)} bottomSentinelRef={useRef<HTMLDivElement>(null)} onScroll={() => {}} onReadingChange={reading} />
    </main>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, update, reading };
}

async function openReader(trigger = document.querySelector<HTMLButtonElement>(".pwa-summary-action")!) {
  trigger.focus();
  await userEvent.click(trigger);
  await expect.poll(() => document.querySelector("[role='dialog'].pwa-summary-reader")).not.toBeNull();
  await expect.poll(() => window.history.state?.piReachSummaryReader).toBe(true);
  return document.querySelector<HTMLElement>(".pwa-summary-reader")!;
}

async function closed() {
  await expect.poll(() => window.history.state?.piReachSummaryReader === true).toBe(false);
  await expect.poll(() => document.querySelector(".pwa-summary-reader")).toBeNull();
}

test.each([1280, 390])("summary entry opens a named, scrollable reader with safe-area header, copy and focus return at %ipx", async width => {
  await page.viewport(width, 844);
  const body = `${"Original paragraph.\n\n".repeat(150)}FINAL_SUMMARY_LINE`;
  const { screen, reading } = await harness([{ ...summary, payload: { summary: `## Original heading\n\n${body}`, details: "HIDDEN_DETAIL" } }]);
  expect(document.querySelector(".pwa-message-list")?.textContent).not.toContain("Original heading");
  const trigger = document.querySelector<HTMLButtonElement>(".pwa-summary-action")!;
  expect(Math.round(trigger.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const before = list.scrollTop;
  const reader = await openReader(trigger);
  await expect.element(screen.getByRole("dialog", { name: "Context summary", exact: true })).toBeVisible();
  await expect.poll(() => Math.round(reader.getBoundingClientRect().right)).toBe(width);
  expect(Math.round(reader.getBoundingClientRect().width)).toBe(width >= 768 ? 720 : width);
  expect(Math.round(reader.getBoundingClientRect().height)).toBe(844);
  expect(document.querySelector(".pwa-root")?.contains(reader)).toBe(true);
  expect(reading).toHaveBeenLastCalledWith(true);
  const scroll = reader.querySelector<HTMLElement>(".pwa-summary-reader-scroll")!;
  scroll.scrollTop = scroll.scrollHeight;
  expect(scroll.scrollTop).toBeGreaterThan(0);
  expect(Math.round(scroll.scrollTop + scroll.clientHeight)).toBe(Math.round(scroll.scrollHeight));
  expect(scroll.textContent).toContain("FINAL_SUMMARY_LINE");
  expect(reader.textContent).not.toContain("HIDDEN_DETAIL");
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.click(screen.getByRole("button", { name: "Copy reader text" }));
  expect(write).toHaveBeenCalledWith(`## Original heading\n\n${body}`);
  await userEvent.keyboard("{Escape}");
  await closed();
  expect(reading).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(trigger);
  expect(list.scrollTop).toBe(before);
});

test("browser back closes only the branch reader and a later open starts with fresh content", async () => {
  const { update, reading } = await harness([{ ...summary, kind: "branch_summary", payload: "Branch-only original" }]);
  const url = window.location.href;
  await openReader();
  expect(document.querySelector(".pwa-summary-reader")?.textContent).toContain("Branch-only original");
  window.history.back();
  await closed();
  expect(window.location.href).toBe(url);
  expect(reading).toHaveBeenLastCalledWith(false);
  update([{ ...summary, kind: "branch_summary", payload: { details: "MUST_NOT_RENDER" } }]);
  await openReader();
  expect(document.querySelector(".pwa-summary-reader")?.textContent).toContain("Summary text is unavailable.");
  expect(document.body.textContent).not.toContain("MUST_NOT_RENDER");
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-summary-reader .pwa-tool-reader-close")!);
  await closed();
});

test("provider error entry, reader and clipboard contain only fixed explanation and recovery advice", async () => {
  const { screen } = await harness([error]);
  expect(document.querySelector(".pwa-message-list")?.textContent).toBe("Model service error");
  await openReader();
  const reader = document.querySelector<HTMLElement>(".pwa-summary-reader")!;
  expect(reader.textContent).toContain("Reliable error details are unavailable here.");
  expect(reader.textContent).toContain("Check Pi and your model service configuration");
  expect(document.body.textContent).not.toMatch(/PRIVATE_TOKEN|429|request body|stack trace/);
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.click(screen.getByRole("button", { name: "Copy reader text" }));
  expect(write.mock.calls[0]?.[0]).not.toMatch(/PRIVATE_TOKEN|429|request body|stack trace/);
  await userEvent.keyboard("{Escape}");
  await closed();
});

test.each(["remove", "session"])("invalidated summary closes and releases reading with list fallback (%s)", async change => {
  const { update, reading } = await harness([summary]);
  await openReader();
  update(change === "remove" ? [{ event_id: "other", session_id: "session", leaf_id: "leaf", timestamp: 2, kind: "compaction", payload: "Other summary", truncated: false }] : [{ ...summary, session_id: "other-session", payload: "Different session" }]);
  await closed();
  expect(reading).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(document.querySelector(".pwa-message-list"));
});

test("summary keeps existing inline reading lock until the inline section is closed", async () => {
  const assistant: TimelineEvent = { event_id: "thinking", session_id: "session", leaf_id: "leaf", timestamp: 0, group_id: "group", kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: "Existing thought" }] };
  const { reading } = await harness([assistant, summary]);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
  await openReader();
  await userEvent.keyboard("{Escape}");
  await closed();
  expect(reading).toHaveBeenLastCalledWith(true);
  await userEvent.click(document.querySelector<HTMLButtonElement>(".pwa-thinking .pwa-timeline-toggle")!);
  expect(reading).toHaveBeenLastCalledWith(false);
});

test("reduced motion uses the existing short fade and closes through the shared shell", async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await harness([summary]);
    const reader = await openReader();
    expect(getComputedStyle(reader).transitionProperty).not.toContain("transform");
    expect(parseFloat(getComputedStyle(reader).transitionDuration)).toBeLessThanOrEqual(0.12);
    await userEvent.keyboard("{Escape}");
    await closed();
  } finally {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  }
});

test("mobile summary reuses right-swipe close and status-bar safe-area layout", async () => {
  await page.viewport(390, 844);
  const { reading } = await harness([summary]);
  const root = document.querySelector<HTMLElement>(".pwa-root")!;
  root.style.setProperty("--pwa-safe-top", "24px");
  const trigger = document.querySelector<HTMLButtonElement>(".pwa-summary-action")!;
  await enableTouch();
  try {
    const reader = await openReader(trigger);
    const header = reader.querySelector<HTMLElement>(".pwa-topbar")!;
    expect(Math.round(header.getBoundingClientRect().height)).toBe(72);
    const scroll = reader.querySelector<HTMLElement>(".pwa-summary-reader-scroll")!;
    expect(getComputedStyle(scroll).touchAction).toBe("pan-y");
    expect(getComputedStyle(scroll).fontSize).toBe("16px");
    expect(getComputedStyle(scroll).lineHeight).toBe("26.4px");
    await expect.poll(() => reader.hasAttribute("data-pwa-moving")).toBe(false);
    await touchDrag(touchOrigin(scroll, 80, 32), 200, 0);
    await closed();
    expect(reading).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(trigger);
  } finally {
    root.style.removeProperty("--pwa-safe-top");
    await resetTouch();
  }
});
