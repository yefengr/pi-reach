import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { getMessages, setLanguagePreference } from "@/lib/i18n";
import type { TimelineEvent } from "@/lib/pi-reach/protocol-v2/schema";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { renderPwa } from "@/test/browser/render";
import { MessageList } from "./message-list";

const scope = { session_id: "copy-session", leaf_id: "copy-leaf", timestamp: 1 };
const FINAL_REPLY = "## Final reply\n\nKeep **Markdown** and [the link](https://example.com).\n\n```ts\nconst value = 1;\n```\n";
const record = (event: TimelineEvent): TimelineViewItem => ({ kind: "event", event });
function answer(id: string, text: string, groupId = "turn-1"): TimelineViewItem {
  return record({ ...scope, event_id: id, group_id: groupId, kind: "assistant", status: "complete", blocks: [{ type: "text", text }] });
}
function thinking(groupId = "turn-1"): TimelineViewItem {
  return record({ ...scope, event_id: `thinking-${groupId}`, group_id: groupId, kind: "assistant", status: "complete", blocks: [{ type: "thinking", text: "Thinking is not reply text." }] });
}
function tool(groupId = "turn-1"): TimelineViewItem {
  return record({ ...scope, event_id: `tool-${groupId}`, group_id: groupId, kind: "tool", tool_call_id: `call-${groupId}`, tool: "read", args: { path: "example.ts" }, status: "complete", truncated: false, result: { content: [{ type: "text", text: "Tool output is not reply text." }] } });
}
function end(groupId = "turn-1", status: "complete" | "interrupted" | "error" = "complete"): TimelineViewItem {
  return record({ ...scope, event_id: `end-${groupId}`, group_id: groupId, kind: "run_end", status, timestamp: 2 });
}
function copyButton(groupId = "turn-1"): HTMLButtonElement | null {
  return document.querySelector(`[data-viewport-completion="${groupId}"] .pwa-turn-copy`);
}
async function copy(button: HTMLButtonElement) {
  button.focus();
  await userEvent.click(button);
}
async function fixture(initial: TimelineViewItem[], isLive = true) {
  let updateItems!: (items: TimelineViewItem[]) => void;
  function Harness() {
    const [items, setItems] = useState(initial);
    updateItems = setItems;
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    return <main className="pwa-main" style={{ width: "100vw", height: "100vh" }}>
      <MessageList items={items} isLive={isLive} hasEarlier={false} listRef={listRef} bottomSentinelRef={bottomRef} onScroll={() => {}} />
    </main>;
  }
  const screen = await renderPwa(<Harness />);
  return { screen, update: (items: TimelineViewItem[]) => flushSync(() => updateItems(items)) };
}

beforeEach(async () => {
  setLanguagePreference("en");
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  await page.viewport(1280, 900);
  setLanguagePreference("system");
});

test("one time-adjacent button copies only the final nonempty reply source", async () => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const user = record({ ...scope, event_id: "user", message_id: "user", group_id: "turn-1", kind: "user", origin: "pwa", sender_ref: "self", status: "committed", delivery: "normal", blocks: [{ type: "text", text: "User text is not reply text." }] });
  await fixture([user, answer("intro", "Earlier prose is not the final reply."), tool(), answer("final", FINAL_REPLY), thinking(), answer("empty", " \n "), end()]);
  expect(document.querySelectorAll(".pwa-turn-copy")).toHaveLength(1);
  expect(document.querySelectorAll(".pwa-user-row button, .pwa-message.assistant > button")).toHaveLength(0);
  const button = copyButton()!;
  const meta = button.closest(".pwa-turn-meta")!;
  const time = meta.querySelector("time")!;
  expect(button.getAttribute("title")).toBe(getMessages().timeline.copyReply);
  expect(Math.round(button.getBoundingClientRect().left - time.getBoundingClientRect().right)).toBe(6);
  expect(Math.round(button.getBoundingClientRect().width)).toBe(44);
  expect(Math.round(button.getBoundingClientRect().height)).toBe(44);
  const height = Math.round(meta.getBoundingClientRect().height);
  await copy(button);
  expect(write).toHaveBeenCalledExactlyOnceWith(FINAL_REPLY);
  await expect.poll(() => button.querySelector(".pwa-copy-icons")?.hasAttribute("data-copied")).toBe(true);
  expect(Math.round(meta.getBoundingClientRect().height)).toBe(height);
  expect(button.getAttribute("aria-label")).toBe(getMessages().timeline.copyReply);
});

test("reply copy appears with completion metadata and stays attached to its own turn after prepend", async () => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const first = answer("first", "First reply");
  const { update } = await fixture([first]);
  expect(copyButton()).toBeNull();
  expect(document.querySelector(".pwa-turn-meta")).toBeNull();
  update([first, end()]);
  const retained = copyButton()!;
  const second = answer("second", "Second reply", "turn-2");
  update([first, end(), second]);
  expect(copyButton("turn-2")).toBeNull();
  update([answer("earlier", "Earlier history", "turn-0"), end("turn-0"), first, end(), second, end("turn-2")]);
  expect(copyButton()).toBe(retained);
  expect(document.querySelectorAll(".pwa-turn-copy")).toHaveLength(3);
  await copy(copyButton("turn-2")!);
  expect(write).toHaveBeenLastCalledWith("Second reply");
  await copy(retained);
  expect(write).toHaveBeenLastCalledWith("First reply");
});

test.each(["complete", "interrupted", "error"] as const)("%s history copies its saved reply without a live Pi", async status => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await fixture([answer("saved", "Saved reply"), end("turn-1", status)], false);
  await copy(copyButton()!);
  expect(write).toHaveBeenCalledExactlyOnceWith("Saved reply");
  const text = document.querySelector(".pwa-turn-meta")!.textContent;
  if (status !== "complete") expect(text).toContain(status === "error" ? getMessages().timeline.turnError : getMessages().timeline.turnInterrupted);
});

test.each(["thinking", "tool"] as const)("a completed %s-only turn keeps its time without an empty copy action", async kind => {
  await fixture([kind === "thinking" ? thinking() : tool(), end()]);
  expect(document.querySelectorAll(".pwa-turn-meta")).toHaveLength(1);
  expect(copyButton()).toBeNull();
});

test.each([1280, 390])("reply copy stays visible without hover or focus and remains keyboard accessible at %ipx", async width => {
  await page.viewport(width, 900);
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await fixture([answer("final", "Reply without a link or code block."), end()]);
  const button = copyButton()!;
  const meta = button.closest<HTMLElement>(".pwa-turn-meta")!;
  const list = document.querySelector<HTMLElement>(".pwa-message-list")!;
  const reply = document.querySelector<HTMLElement>(".pwa-message.assistant")!;
  list.focus();
  await userEvent.hover(reply);
  expect(meta.matches(":hover, :focus-within")).toBe(false);
  expect(getComputedStyle(button).opacity).toBe("1");
  expect(getComputedStyle(button).pointerEvents).toBe("auto");
  await userEvent.click(button);
  expect(write).toHaveBeenCalledExactlyOnceWith("Reply without a link or code block.");
  list.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(button);
  expect(getComputedStyle(button).opacity).toBe("1");
});

test("coarse-pointer devices show the copy action even at desktop width", async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  expect(matchMedia("(any-pointer: coarse)").matches).toBe(true);
  await fixture([answer("final", "Touch reply"), end()]);
  await expect.poll(() => getComputedStyle(copyButton()!).opacity).toBe("1");
  expect(getComputedStyle(copyButton()!).pointerEvents).toBe("auto");
});

test("copy failure uses the existing local feedback without changing row geometry", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard denied"));
  await fixture([answer("final", "Text remains selectable after failure."), end()]);
  const button = copyButton()!;
  const meta = button.closest(".pwa-turn-meta")!;
  const height = Math.round(meta.getBoundingClientRect().height);
  await copy(button);
  await expect.poll(() => document.querySelector(".pwa-copy-error")?.textContent).toBe(getMessages().workspace.copyFailed);
  expect(Math.round(meta.getBoundingClientRect().height)).toBe(height);
  expect(document.querySelector(".pwa-message.assistant")!.textContent).toContain("Text remains selectable after failure.");
  expect(document.body.textContent).not.toContain("clipboard denied");
});

test("copy action follows the Chinese interface language", async () => {
  setLanguagePreference("zh");
  await fixture([answer("final", "正文"), end()]);
  expect(copyButton()!.getAttribute("aria-label")).toBe("复制回复原文");
  expect(copyButton()!.getAttribute("title")).toBe("复制回复原文");
});
