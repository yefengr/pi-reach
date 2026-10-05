import { afterEach, expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { AttachmentCards } from "./attachment-cards";
import { QueuedMessages } from "./queued-messages";
import { ToolCard } from "./tool-card";
import { ToolOutput } from "./tool-output";
import type { ToolValue } from "./tool-presentation";
import "@/app/queued-messages.css";

/** 状态按语义取色：中断、预览缩短为中性；暂停、未确认、主机截断为运行色；失败为错误色。 */
const base = { event_id: "event", session_id: "session", leaf_id: "leaf", group_id: "group", timestamp: 1, kind: "tool" as const, tool_call_id: "call", truncated: false, tool: "bash", args: { command: "pnpm test" } };

function tokenColor(token: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.querySelector(".pwa-root")!.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;

afterEach(() => document.documentElement.removeAttribute("data-mantine-color-scheme"));

test.each(["light", "dark"])("status colors follow shared semantics in %s", async theme => {
  document.documentElement.setAttribute("data-mantine-color-scheme", theme);
  const longOutput: ToolValue = { ...base, status: "complete", truncated: true, result: Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n") };
  const screen = await renderPwa(<>
    <ToolCard value={{ ...base, status: "interrupted" }} onRead={() => {}} />
    <ToolCard value={{ ...base, tool_call_id: "failed", status: "error", error: "failed" }} onRead={() => {}} />
    <div className="preview"><ToolOutput value={longOutput} preview /></div>
    <div className="reader"><ToolOutput value={longOutput} /></div>
    <AttachmentCards items={[{ id: "paused", fileName: "paused.txt", byteLength: 2048, status: "paused" }, { id: "draft", fileName: "draft.txt", byteLength: 2048, status: "draft" }]} />
    <QueuedMessages isOnline onInsert={() => {}} onCancel={() => {}} items={[
      { id: "unconfirmed", text: "unconfirmed", status: "Unconfirmed", notice: "Check the conversation", attention: true, canManage: false },
      { id: "queued", text: "queued", status: "Queued", canManage: true },
    ]} />
  </>);
  const secondary = tokenColor("--pwa-secondary");
  const running = tokenColor("--pwa-running");
  const error = tokenColor("--pwa-error");
  expect(new Set([secondary, running, error]).size).toBe(3);

  expect(color(".pwa-tool-status-interrupted")).toBe(secondary);
  expect(color(".pwa-tool-status-error")).toBe(error);
  expect(color(".preview .pwa-tool-notice-preview")).toBe(secondary);
  expect(document.querySelector(".preview .pwa-tool-notice:not(.pwa-tool-notice-preview)")).toBeNull();
  expect(color(".reader .pwa-tool-notice")).toBe(running);
  expect(color('[data-status="paused"] .pwa-attachment-status')).toBe(running);
  expect(color('[data-status="draft"] .pwa-attachment-status')).toBe(secondary);
  const [unconfirmed, queued] = document.querySelectorAll(".pwa-queued-message");
  expect(getComputedStyle(unconfirmed.querySelector(".pwa-queued-message-status")!).color).toBe(running);
  expect(getComputedStyle(unconfirmed.querySelector(".pwa-queued-message-notice")!).color).toBe(running);
  expect(getComputedStyle(queued.querySelector(".pwa-queued-message-status")!).color).toBe(secondary);
  await screen.unmount();
});
