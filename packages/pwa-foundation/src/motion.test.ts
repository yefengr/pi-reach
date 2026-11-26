import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { PWA_MOTION_FALLBACK_MS, readPwaMotionDuration, resolvePwaMotionDuration, pwaContentEasing, pwaStandardEasing, pwaMotionShiftDisabled } from "./motion.js";

const style = (values: Record<string, string>) => ({ getPropertyValue: (key: string) => values[key] ?? "" }) as CSSStyleDeclaration;
const root = (values: Record<string, string>, reduced = false) => ({ ownerDocument: { defaultView: {
  getComputedStyle: () => style(values), matchMedia: () => ({ matches: reduced }), CSS: { supports: () => false },
} } }) as unknown as HTMLElement;
afterEach(() => vi.unstubAllGlobals());

test("SSR、已知和宿主 token 的普通回退不依赖 DOM", () => {
  vi.stubGlobal("document", undefined);
  expect(readPwaMotionDuration("--pwa-duration-modal-in")).toBe(400);
  expect(readPwaMotionDuration("--pwa-duration-host")).toBe(0);
  expect(readPwaMotionDuration("--pwa-duration-host", 333)).toBe(333);
  expect(readPwaMotionDuration("--pwa-duration-host", -1)).toBe(0);
  expect(readPwaMotionDuration("--pwa-duration-modal-in", NaN)).toBe(400);
});

test("支持秒、毫秒、零与有界引用，拒绝异常数值和循环", () => {
  for (const [value, expected] of [["0ms", 0], ["0s", 0], [".24s", 240], [" 90ms ", 90], ["-1ms", 400], ["NaNms", 400], ["Infinitys", 400], ["12px", 400], ["20ms junk", 400]] as const) {
    expect(readPwaMotionDuration("--pwa-duration-modal-in", undefined, root({ "--pwa-duration-modal-in": value }))).toBe(expected);
  }
  const values = { "--pwa-duration-modal-in": "var(--pwa-tier-appear)", "--pwa-tier-appear": "0.4s" };
  expect(resolvePwaMotionDuration(style(values), "--pwa-duration-modal-in")).toBe("0.4s");
  expect(readPwaMotionDuration("--pwa-duration-modal-in", undefined, root(values))).toBe(400);
  expect(readPwaMotionDuration("--pwa-duration-modal-in", undefined, root({ "--pwa-duration-modal-in": "var(--pwa-duration-modal-in)" }))).toBe(400);
});

test("显式 root 使用自己的窗口，减少动态效果仅在读不到合法 CSS 时回退120", () => {
  vi.stubGlobal("getComputedStyle", () => { throw Error("wrong window"); });
  expect(readPwaMotionDuration("--pwa-duration-drawer", undefined, root({}, true))).toBe(120);
  expect(readPwaMotionDuration("--pwa-duration-drawer", undefined, root({ "--pwa-duration-drawer": "0ms" }, true))).toBe(0);
  const broken = root({});
  broken.ownerDocument.defaultView!.getComputedStyle = () => { throw Error("style unavailable"); };
  expect(readPwaMotionDuration("--pwa-duration-drawer", undefined, broken)).toBe(360);
});

test("基础曲线与shift沿用token，内容曲线不支持时回退标准常量", () => {
  const element = root({ "--pwa-ease-standard": "ease-out", "--pwa-ease-content": "linear(0, 1)", "--pwa-motion-shift": "0" });
  expect(pwaStandardEasing(element)).toBe("ease-out");
  expect(pwaContentEasing(element)).toBe("cubic-bezier(0.2, 0, 0, 1)");
  expect(pwaMotionShiftDisabled(element)).toBe(true);
});

test("所有公共时长与CSS普通档、reduced档一致且没有提取宿主token", () => {
  const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
  const [ordinary, reduced] = css.split("@media (prefers-reduced-motion: reduce)");
  const parse = (text: string) => Object.fromEntries([...text.matchAll(/(--pwa-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
  const values = parse(ordinary);
  for (const [token, fallback] of Object.entries(PWA_MOTION_FALLBACK_MS)) {
    expect(readPwaMotionDuration(token as keyof typeof PWA_MOTION_FALLBACK_MS, undefined, root(values)), token).toBe(fallback);
    expect(readPwaMotionDuration(token as keyof typeof PWA_MOTION_FALLBACK_MS, undefined, root({ ...values, ...parse(reduced) })), token).toBe(120);
  }
  expect(css).not.toMatch(/--pwa-duration-(?:sidebar|page|image|toast|keyboard)/);
});
