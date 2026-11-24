import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { floatingShiftPadding, insetsEqual, readSafeAreaInsets } from "./safe-area.js";

const FOUNDATION_CSS = readFileSync(new URL("../foundation.css", import.meta.url), "utf8");

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function stubProbe(padding: { top: string; right: string; bottom: string; left: string }) {
  const probe = {
    attributes: new Map<string, string>(),
    style: { cssText: "" },
    setAttribute(name: string, value: string) {
      probe.attributes.set(name, value);
    },
    remove: vi.fn(),
  };
  const body = { append: vi.fn() };
  const documentStub = { body, createElement: vi.fn(() => probe) };
  const getComputedStyleStub = vi.fn(() => ({
    paddingTop: padding.top,
    paddingRight: padding.right,
    paddingBottom: padding.bottom,
    paddingLeft: padding.left,
  }));
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("getComputedStyle", getComputedStyleStub);
  return { probe, body, documentStub, getComputedStyleStub };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readSafeAreaInsets", () => {
  test("没有 document 的 SSR 环境返回零安全区", () => {
    vi.stubGlobal("document", undefined);
    expect(readSafeAreaInsets()).toEqual(ZERO_INSETS);
  });

  test("body 未就绪时返回零安全区且不创建探针", () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { body: null, createElement });
    expect(readSafeAreaInsets()).toEqual(ZERO_INSETS);
    expect(createElement).not.toHaveBeenCalled();
  });

  test("借隐藏探针解析四边 env() 计算值并移除探针", () => {
    const { probe, body, getComputedStyleStub } = stubProbe({ top: "12px", right: "0px", bottom: "34px", left: "5.5px" });
    expect(readSafeAreaInsets()).toEqual({ top: 12, right: 0, bottom: 34, left: 5.5 });
    expect(probe.attributes.get("aria-hidden")).toBe("true");
    expect(probe.style.cssText).toContain("visibility:hidden");
    expect(probe.style.cssText).toContain("padding:var(--pwa-safe-top) var(--pwa-safe-right) var(--pwa-safe-bottom) var(--pwa-safe-left)");
    expect(body.append).toHaveBeenCalledWith(probe);
    expect(getComputedStyleStub).toHaveBeenCalledWith(probe);
    expect(getComputedStyleStub.mock.invocationCallOrder[0]).toBeGreaterThan(body.append.mock.invocationCallOrder[0]);
    expect(probe.remove).toHaveBeenCalledTimes(1);
  });

  test("计算值无法解析时按 0 处理", () => {
    stubProbe({ top: "", right: "auto", bottom: "unset", left: "" });
    expect(readSafeAreaInsets()).toEqual(ZERO_INSETS);
  });
});

describe("floatingShiftPadding", () => {
  test("四边各取默认留白与安全区的较大值，不相加", () => {
    expect(floatingShiftPadding({ top: 0, right: 20, bottom: 3, left: 44 })).toEqual({ top: 5, right: 20, bottom: 5, left: 44 });
  });

  test("没有安全区时四边都是默认留白", () => {
    expect(floatingShiftPadding(ZERO_INSETS)).toEqual({ top: 5, right: 5, bottom: 5, left: 5 });
  });
});

describe("insetsEqual", () => {
  test("四边值相同视为同一个安全区", () => {
    expect(insetsEqual(ZERO_INSETS, { top: 0, right: 0, bottom: 0, left: 0 })).toBe(true);
  });

  test("任意一边变化即为新安全区", () => {
    expect(insetsEqual(ZERO_INSETS, { top: 0, right: 0, bottom: 0, left: 1 })).toBe(false);
  });
});

describe("foundation.css 合同", () => {
  const declarations = new Map<string, string>();
  for (const match of FOUNDATION_CSS.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }

  test("只定义四个安全区变量与最小点击区", () => {
    expect([...declarations.keys()].sort()).toEqual([
      "--pwa-hit-target",
      "--pwa-safe-bottom",
      "--pwa-safe-left",
      "--pwa-safe-right",
      "--pwa-safe-top",
    ]);
  });

  test("安全区保持 env() 的零回退", () => {
    expect(declarations.get("--pwa-safe-top")).toBe("env(safe-area-inset-top, 0px)");
    expect(declarations.get("--pwa-safe-right")).toBe("env(safe-area-inset-right, 0px)");
    expect(declarations.get("--pwa-safe-bottom")).toBe("env(safe-area-inset-bottom, 0px)");
    expect(declarations.get("--pwa-safe-left")).toBe("env(safe-area-inset-left, 0px)");
    expect(declarations.get("--pwa-hit-target")).toBe("44px");
  });

  test("不携带主题色、字体与断点规则", () => {
    expect(FOUNDATION_CSS).not.toMatch(/@media/);
    expect(FOUNDATION_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(FOUNDATION_CSS).not.toMatch(/--pwa-(?:bg|ink|accent|font|text|radius|z)-/);
    expect(FOUNDATION_CSS.match(/:root\s*\{/g)).toHaveLength(1);
  });
});
