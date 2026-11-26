import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { createPwaTheme, pwaCssVariablesResolver, PWA_DIALOG_SIZE, PWA_CONFIRM_DIALOG_SIZE, pwaModalTransition } from "./mantine-theme.js";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], state: undefined as number[] | undefined, cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useState: (initial: () => number) => {
    const index = hooks.cursor++;
    const value = initial();
    return [hooks.state?.[index] ?? value, (next: number) => { (hooks.state ??= [400, 200])[index] = next; }];
  },
  useMemo: (factory: () => unknown) => factory(),
}));
import { usePwaTheme } from "./mantine.js";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../theme.css");
const controls = read("../controls.css");
afterEach(() => { vi.unstubAllGlobals(); hooks.effects = []; hooks.state = undefined; hooks.cursor = 0; });

test("入口保持向后兼容并把 Mantine 限制在可选入口", async () => {
  const manifest = JSON.parse(read("../package.json"));
  expect(Object.keys(manifest.exports)).toEqual([".", "./foundation.css", "./theme.css", "./controls.css", "./surfaces.css", "./mantine"]);
  expect(manifest.exports["."].default).toBe("./dist/index.js");
  expect(manifest.files).toContain("CHANGELOG.md");
  expect(manifest.description).toContain("safe-area");
  expect(manifest.description).toContain("theme");
  expect(manifest.description).toContain("Mantine");
  expect(manifest).not.toHaveProperty("homepage");
  expect(manifest.repository.directory).toBe("packages/pwa-foundation");
  expect(read("./index.ts")).not.toMatch(/mantine|lucide/);
  expect(manifest.peerDependencies.react).toBe("^19.2.4");
  for (const name of ["@mantine/core", "@mantine/hooks", "lucide-react"]) {
    expect(manifest.peerDependenciesMeta[name].optional).toBe(true);
    expect(manifest.peerDependencies[name]).toBe(manifest.devDependencies[name]);
  }
  expect(await import("./mantine.js")).toHaveProperty("usePwaTheme");
});

test("默认组件类、输入能力与宽度不依赖应用配置", () => {
  const theme = createPwaTheme(401, 201);
  expect(theme.primaryColor).toBe("pwaFoundation");
  expect(PWA_DIALOG_SIZE).toBe(480);
  expect(PWA_CONFIRM_DIALOG_SIZE).toBe(400);
  expect(theme.components?.Button.defaultProps).toMatchObject({ variant: "filled", size: "md" });
  for (const [name, className] of Object.entries({ TextInput: "pwa-input", Textarea: "pwa-textarea", Select: "pwa-select", NativeSelect: "pwa-select" })) {
    expect(theme.components?.[name].classNames).toEqual({ root: className });
    expect(theme.components?.[name].defaultProps).toMatchObject({ size: "md", inputWrapperOrder: ["label", "input", "description", "error"] });
  }
  expect(theme.components?.Modal.classNames).toMatchObject({ content: "pwa-dialog", close: "pwa-icon-button", overlay: "pwa-scrim" });
  expect(theme.components?.Modal.defaultProps).not.toHaveProperty("overlayProps");
  expect(theme.components?.Modal.defaultProps).not.toHaveProperty("xOffset");
  expect(theme.components?.Modal.defaultProps).toMatchObject({ size: 480, transitionProps: { duration: 401, exitDuration: 201 } });
  expect(pwaModalTransition).toHaveProperty("transitionProperty", "opacity, transform");
});

test("resolver 明暗同组语义且 palette 去品牌化", () => {
  const resolver = pwaCssVariablesResolver as (...args: unknown[]) => { light: object; dark: object };
  const result = resolver();
  expect(result.light).toEqual(result.dark);
  expect(result.light).toHaveProperty("--mantine-color-primary-filled", "var(--pwa-accent)");
  expect(JSON.stringify(result)).not.toContain("piReach");
});

test("无 DOM 首次调用不读样式，模拟 effect 读取引用与秒单位并刷新/清理",  () => {
  vi.stubGlobal("document", undefined);
  expect(usePwaTheme().components?.Modal.defaultProps.transitionProps).toMatchObject({ duration: 400, exitDuration: 200 });
  const listeners = new Set<() => void>();
  const change = () => { for (const listener of listeners) listener(); };
  const remove = vi.fn((_event: string, fn: () => void) => { listeners.delete(fn); });
  const media = { matches: false, addEventListener: vi.fn((_event: string, fn: () => void) => { listeners.add(fn); }), removeEventListener: remove };
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("document", { documentElement: {} });
  let values: Record<string, string> = { "--pwa-duration-modal-in": "var(--pwa-tier-appear)", "--pwa-tier-appear": "0.4s", "--pwa-duration-modal-out": "200ms" };
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (key: string) => values[key] ?? "" }));
  const cleanups = hooks.effects.map((effect) => effect());
  expect(hooks.state).toEqual([400, 200]);
  media.matches = true; values = {}; change();
  expect(hooks.state).toEqual([120, 120]);
  values = { "--pwa-duration-modal-in": "90ms", "--pwa-duration-modal-out": "0ms" }; change();
  expect(hooks.state).toEqual([90, 0]);
  values = { "--pwa-duration-modal-in": "-1ms", "--pwa-duration-modal-out": "NaNms" }; change();
  expect(hooks.state).toEqual([120, 120]);
  for (const cleanup of cleanups) cleanup?.();
  expect(remove).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
});

test("token 依赖闭包、提取值与来源等价，明暗回退和字号保留", () => {
  const definitions = new Set([...css.matchAll(/(--pwa-[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const match of (css + controls + read("./mantine-theme.ts")).matchAll(/var\((--pwa-[\w-]+)/g)) {
    expect(definitions.has(match[1]) || ["--pwa-hit-target", "--pwa-safe-left", "--pwa-safe-right", "--pwa-modal-ease"].includes(match[1]), match[1]).toBe(true);
  }
  const dark = css.match(/:root\[data-mantine-color-scheme="dark"\] \{([^}]+)\}/)![1];
  const fallback = css.match(/:root:not\(\[data-mantine-color-scheme\]\) \{([^}]+)\}/)![1];
  expect(dark.trim()).toBe(fallback.trim());
  for (const rule of ["data-pwa-text-size=\"large\"", "data-pwa-text-size=\"xlarge\"", "pointer: coarse", "prefers-reduced-motion: reduce"]) expect(css).toContain(rule);
  expect(css).not.toMatch(/--pwa-(z-|app-height|complete|running|syntax|code-)/);
  expect(controls).toContain("max(16px, var(--pwa-text-body))");
  expect(controls).not.toMatch(/\.pwa-root|\border\s*:/);
});
