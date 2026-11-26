import { afterEach, expect, test, vi } from "vitest";
import { detectHairline, HAIRLINE_ATTRIBUTE, installHairlineDetection } from "./hairline.js";

function dom(initial: string | null = null) {
  let height = 0.5;
  let failure = "";
  const attributes = new Map<string, string>();
  if (initial !== null) attributes.set(HAIRLINE_ATTRIBUTE, initial);
  const children = new Set<unknown>();
  const resize = new Set<() => void>();
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const view = {
    devicePixelRatio: 1,
    addEventListener: vi.fn((_type: string, fn: () => void) => resize.add(fn)),
    removeEventListener: vi.fn((_type: string, fn: () => void) => resize.delete(fn)),
    matchMedia: vi.fn((media: string) => {
      const listeners = new Set<() => void>();
      queries.push({ media, listeners });
      return {
        addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
        addListener: (fn: () => void) => listeners.add(fn),
        removeListener: (fn: () => void) => listeners.delete(fn),
      };
    }),
  };
  const doc = {
    defaultView: view,
    createElement: vi.fn(() => {
      if (failure === "create") throw new Error("create failed");
      const probe = {
        style: { cssText: "" },
        getBoundingClientRect: () => {
          if (failure === "measure") throw new Error("measure failed");
          return { height };
        },
        remove: vi.fn(() => children.delete(probe)),
      };
      return probe;
    }),
  };
  const target = {
    ownerDocument: doc,
    append: (probe: unknown) => {
      children.add(probe);
      if (failure === "append") throw new Error("append failed");
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    toggleAttribute: (name: string, on: boolean) => on ? attributes.set(name, "") : attributes.delete(name),
  };
  return { root: target as unknown as HTMLElement, view, doc, queries, resize, children,
    height: (value: number) => { height = value; }, fail: (value: string) => { failure = value; } };
}

afterEach(() => vi.unstubAllGlobals());

test("SSR 无模块加载副作用，默认 API 安全回退", () => {
  vi.stubGlobal("document", undefined);
  expect(detectHairline()).toBe(false);
  const release = installHairlineDetection();
  expect(release).toBeTypeOf("function");
  release(); release();
});

test("只依据实测正的亚像素高度，不依据 DPR，探针始终移除", () => {
  const d = dom();
  vi.stubGlobal("document", { createElement: () => { throw new Error("wrong document"); } });
  for (const height of [0.25, 0.5, 0, 1, 2, -1, NaN, Infinity]) {
    d.height(height);
    d.view.devicePixelRatio = height < 1 ? 1 : 3;
    const expected = height > 0 && height < 1;
    expect(detectHairline(d.root)).toBe(expected);
    expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe(expected ? "" : null);
    expect(d.children.size).toBe(0);
  }
  expect(d.doc.createElement).toHaveBeenCalledWith("div");
});

test.each(["create", "append", "measure"])("探针 %s 异常清理并恢复常规档", (failure) => {
  const d = dom("old");
  d.fail(failure);
  expect(detectHairline(d.root)).toBe(false);
  expect(d.children.size).toBe(0);
  expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBeNull();
});

test.each([null, "", "original"])("重复安装与幂等释放恢复原值 %s，包括显式检测后的改动", (original) => {
  const d = dom(original);
  const first = installHairlineDetection(d.root);
  const second = installHairlineDetection(d.root);
  expect(d.view.matchMedia).toHaveBeenCalledTimes(1);
  expect(d.resize.size).toBe(1);
  first(); first();
  expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe("");
  expect(d.resize.size).toBe(1);
  d.height(0);
  detectHairline(d.root);
  second(); second();
  expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe(original);
  expect(d.resize.size).toBe(0);
  expect(d.queries.every((q) => q.listeners.size === 0)).toBe(true);
  const again = installHairlineDetection(d.root);
  again();
  expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe(original);
});

test("每次密度变化和 resize 都重测并重绑当前 resolution，最终释放全部监听", () => {
  const d = dom();
  const stop = installHairlineDetection(d.root);
  expect(d.queries[0].media).toBe("(resolution: 1dppx)");
  d.height(1); d.view.devicePixelRatio = 1.5;
  [...d.queries[0].listeners].forEach((fn) => fn());
  expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBeNull();
  expect(d.queries[0].listeners.size).toBe(0);
  expect(d.queries[1].media).toBe("(resolution: 1.5dppx)");
  d.height(0.5); d.view.devicePixelRatio = 2;
  [...d.resize].forEach((fn) => fn());
  expect(d.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe("");
  expect(d.queries[1].listeners.size).toBe(0);
  expect(d.queries[2].media).toBe("(resolution: 2dppx)");
  stop();
  expect(d.queries.every((q) => q.listeners.size === 0)).toBe(true);
  expect(d.resize.size).toBe(0);
});

test("独立根元素及其窗口的安装互不影响", () => {
  const a = dom("a"); const b = dom("b");
  const stopA = installHairlineDetection(a.root);
  const stopB = installHairlineDetection(b.root);
  stopA();
  expect(a.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe("a");
  expect(b.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe("");
  expect(b.resize.size).toBe(1);
  stopB();
  expect(b.root.getAttribute(HAIRLINE_ATTRIBUTE)).toBe("b");
});

test("默认 documentElement、无窗口及无 matchMedia 的回退", () => {
  const d = dom();
  vi.stubGlobal("document", { documentElement: d.root });
  expect(detectHairline()).toBe(true);
  Object.assign(d.view, { matchMedia: undefined });
  const stop = installHairlineDetection();
  expect(d.resize.size).toBe(1);
  stop();
  Object.assign(d.doc, { defaultView: null });
  expect(() => installHairlineDetection(d.root)()).not.toThrow();
});

test("旧版 MediaQueryList addListener 路径同样移除监听", () => {
  const d = dom();
  const original = d.view.matchMedia;
  d.view.matchMedia = vi.fn((media: string) => {
    const q = original(media);
    return Object.assign(q, { addEventListener: undefined, removeEventListener: undefined }) as unknown as ReturnType<typeof original>;
  });
  const stop = installHairlineDetection(d.root);
  expect(d.queries[0].listeners.size).toBe(1);
  stop();
  expect(d.queries[0].listeners.size).toBe(0);
});
