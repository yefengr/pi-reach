import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Menu } from "@mantine/core";
import type { WireModel } from "@/lib/pi-reach/types";
import { ComposerCommandMenuPanel, type ComposerCommandMenuPanelProps } from "./composer-command-menu";
import { PwaUiProvider } from "./pwa-ui-provider";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200000,
  vision: true,
};

const panelProps: Omit<ComposerCommandMenuPanelProps, "view"> = {
  isOnline: true,
  isWorking: false,
  pendingAction: null,
  models: [model],
  currentModel: model,
  currentModelFallback: null,
  thinking: "medium",
  onNewSession: () => {},
  onCompactSession: () => {},
  onSetModel: () => {},
  onSetThinking: () => {},
  onBack: () => {},
  onOpenModels: () => {},
  onOpenThinking: () => {},
};

function renderPanel(view: ComposerCommandMenuPanelProps["view"], overrides: Partial<ComposerCommandMenuPanelProps> = {}): string {
  return renderToStaticMarkup(<PwaUiProvider><Menu><ComposerCommandMenuPanel {...panelProps} {...overrides} view={view} /></Menu></PwaUiProvider>);
}

test("renders all root Pi commands with Mantine menu items", () => {
  const html = renderPanel("root");

  expect(html.match(/data-menu-item="true"/g)).toHaveLength(4);
  expect(html).toMatch(/mantine-Menu-item/);
  expect(html).toMatch(/\/new/);
  expect(html).toMatch(/New session/);
  expect(html).toMatch(/\/compact/);
  expect(html).toMatch(/Compact context/);
  expect(html).toMatch(/\/model/);
  expect(html).toMatch(/anthropic \/ Claude Sonnet 4/);
  expect(html).toMatch(/\/thinking/);
  expect(html).toMatch(/Thinking level: medium/);
});

test("renders Actions presentation without slash aliases", () => {
  const html = renderPanel("root", { presentation: "action" });

  expect(html).toMatch(/>New session</);
  expect(html).toMatch(/>Compact context</);
  expect(html).toMatch(/>Change model</);
  expect(html).toMatch(/>Thinking level</);
  expect(html).not.toMatch(/\/new/);
  expect(html).not.toMatch(/\/compact/);
  expect(html).not.toMatch(/\/model/);
  expect(html).not.toMatch(/\/thinking/);
});

test("falls back to endpoint metadata before the current model catalog arrives", () => {
  const html = renderPanel("root", { currentModel: null, currentModelFallback: "GPT-5.4" });

  expect(html).toMatch(/GPT-5.4/);
  expect(html).not.toMatch(/Current model unavailable/);
});

test("shows an explicit unavailable state when no current model is known", () => {
  const html = renderPanel("root", { currentModel: null, currentModelFallback: null });

  expect(html).toMatch(/Current model unavailable/);
});

test("disables new and compact while the active endpoint is working", () => {
  const html = renderPanel("root", { isWorking: true });

  expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
});

test("disables every command while offline", () => {
  const html = renderPanel("root", { isOnline: false });

  expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
});

test("disables every command while another action is pending", () => {
  const html = renderPanel("root", { pendingAction: "model_set" });

  expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
});

test("renders the model chooser with provider, name, and current model", () => {
  const html = renderPanel("models");

  expect(html).toMatch(/role="group" aria-label="Change model"/);
  expect(html).toMatch(/role="menuitem"/);
  expect(html).toMatch(/Back/);
  expect(html).toMatch(/Change model/);
  expect(html).toMatch(/anthropic \/ Claude Sonnet 4/);
  expect(html).toMatch(/aria-label="Current model"/);
});

test("renders every thinking level and marks the active level", () => {
  const html = renderPanel("thinking");

  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) expect(html).toMatch(new RegExp(`>${level}<`));
  expect(html).toMatch(/aria-label="Current thinking level"/);
});

test("keeps Back enabled when model and thinking choices are pending", () => {
  for (const view of ["models", "thinking"] as const) {
    const html = renderPanel(view, { pendingAction: "model_set" });
    expect(html).toMatch(/mantine-Menu-label/);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(view === "models" ? 1 : 6);
    const back = html.match(/<button\b[^>]*>[\s\S]*?Back[\s\S]*?<\/button>/)?.[0];
    expect(back).toBeDefined();
    expect(back).not.toMatch(/disabled=""/);
  }
});

test("keeps an empty model catalog readable with a Back action", () => {
  const html = renderPanel("models", { models: [] });
  expect(html).toContain("No models available.");
  expect(html.match(/role="menuitem"/g)).toHaveLength(1);
  expect(html).toContain("Back");
});
