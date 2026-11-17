import { createRef, useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { Bot, Check, CircleAlert, X } from "lucide-react";
import { afterEach, expect, test } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderPwa } from "@/test/browser/render";
import type { TimelineViewItem } from "@/lib/pwa/timeline-runtime";
import { ComposerHint } from "./composer-hint";
import { MessageList } from "./message-list";
import { ComposerAttachmentMenu, ReadOnlyComposer } from "./message-composer";
import "./tool-reader.css";

function AttachmentMenuFixture() {
  const [opened, onChange] = useState(false);
  return <div data-testid="menu-trigger"><ComposerAttachmentMenu disabled={false} opened={opened} onChange={onChange} onChooseFiles={() => {}} onUseCamera={() => {}} /></div>;
}

const sizes = ["standard", "large", "xlarge"] as const;
const cases = [false, true].flatMap(touch => sizes.map(size => ({ touch, size })));
const scope = { session_id: "icon-session", leaf_id: "icon-leaf", group_id: "icon-turn", timestamp: 1 };
const items: TimelineViewItem[] = [
  { kind: "event", event: { ...scope, event_id: "reply", kind: "assistant", status: "complete", blocks: [{ type: "text", text: "A completed reply." }] } },
  { kind: "event", event: { ...scope, event_id: "end", kind: "run_end", status: "complete" } },
];
const element = (selector: string) => {
  const node = document.querySelector(selector);
  expect(node, selector).not.toBeNull();
  return node!;
};
const pixels = (node: Element, property: "width" | "height" | "fontSize") => Math.round(parseFloat(getComputedStyle(node)[property]));

function sameSize(iconSelector: string, textSelector: string, stroke = 1.5) {
  const icon = element(iconSelector);
  const text = element(textSelector);
  const font = pixels(text, "fontSize");
  expect([pixels(icon, "width"), pixels(icon, "height")], iconSelector).toEqual([font, font]);
  for (const shape of icon.children) {
    expect(getComputedStyle(shape).vectorEffect).toBe("non-scaling-stroke");
    expect(parseFloat(getComputedStyle(shape).strokeWidth)).toBe(stroke);
  }
}

afterEach(async () => {
  delete document.documentElement.dataset.pwaTextSize;
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 900);
});

test.each(cases)("inline icons follow their own text at $size, touch=$touch", async ({ touch, size }) => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: touch });
  await page.viewport(touch ? 390 : 1280, 900);
  document.documentElement.dataset.pwaTextSize = size;
  const screen = await renderPwa(<div style={{ maxWidth: "100vw" }}>
    <MessageList items={items} isLive={false} hasEarlier={false} listRef={createRef()} bottomSentinelRef={createRef()} onScroll={() => {}} />
    <ReadOnlyComposer notice="Saved history" modelName="Model" thinking="medium" />
    <ComposerHint hint={{ text: "Reconnecting…", tone: "neutral", busy: true }} instant />
    <div className="pwa-nav-section-heading"><Bot size={16} /><span>Online Pi</span></div>
    <div className="pwa-tool-reader-status"><Check size={16} /><span>Complete</span></div>
    <div className="pwa-tool-reader-title"><span className="pwa-reader-heading"><Bot size={16} /><span>Read file</span></span></div>
    <div className="pwa-field-error"><CircleAlert size={16} /><span>Invalid value</span></div>
    <Button data-testid="text-button" leftSection={<Check size={16} />}>Continue</Button>
    <Button className="pwa-settings-back" leftSection={<Check size={16} />}><span className="pwa-settings-back-label">Back</span></Button>
    <ActionIcon data-testid="close-button" aria-label="Close fixture"><X size={20} /></ActionIcon>
    <span className="pwa-attachment-tile-badge"><X size={16} /></span>
    <AttachmentMenuFixture />
  </div>);

  sameSize(".pwa-turn-copy .pwa-copy-icon-copy", ".pwa-turn-meta time");
  sameSize(".pwa-turn-copy .pwa-copy-icon-check", ".pwa-turn-meta time");
  sameSize(".pwa-composer-model svg", ".pwa-composer-model-name");
  sameSize(".pwa-composer-hint .pwa-spin", ".pwa-composer-hint:has(.pwa-spin) > span");
  sameSize(".pwa-nav-section-heading svg", ".pwa-nav-section-heading span");
  sameSize(".pwa-tool-reader-status svg", ".pwa-tool-reader-status span");
  sameSize(".pwa-reader-heading svg", ".pwa-reader-heading span");
  sameSize(".pwa-field-error svg", ".pwa-field-error span");
  sameSize('[data-testid="text-button"] svg', '[data-testid="text-button"] .mantine-Button-label', 2);

  const meta = { standard: 13, large: 14, xlarge: 15 }[size] + Number(touch);
  expect(pixels(element(".pwa-turn-meta time"), "fontSize")).toBe(meta);
  const copy = element(".pwa-turn-copy").getBoundingClientRect();
  expect([Math.round(copy.width), Math.round(copy.height)]).toEqual([44, 44]);
  expect(pixels(element('[data-testid="close-button"] svg'), "width")).toBe(touch ? 22 : 20);
  expect(pixels(element(".pwa-attachment-tile-badge svg"), "width")).toBe({ standard: 16, large: 18, xlarge: 20 }[size]);
  if (touch) expect(pixels(element(".pwa-settings-back svg"), "width")).toBe(22);
  else sameSize(".pwa-settings-back svg", ".pwa-settings-back-label", 2);

  const trigger = element('[data-testid="menu-trigger"] button') as HTMLButtonElement;
  trigger.focus();
  await userEvent.click(trigger);
  await expect.poll(() => document.querySelector('[role="menu"]')).not.toBeNull();
  sameSize('[role="menuitem"] svg', '[role="menuitem"] .mantine-Menu-itemLabel');
  expect(element('[role="menu"]').closest(".pwa-root")).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
  await expect.poll(() => document.activeElement).toBe(trigger);
  await screen.unmount();
});
