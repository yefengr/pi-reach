import { afterEach, expect, test, vi } from "vitest";
import { readSystemBodySize, supportsSystemTextSize, textSizeForSystemBody } from "./text-size.js";
afterEach(() => vi.unstubAllGlobals());

test("系统字号按18和20阈值映射，只放大不缩小", () => {
  for (const value of [null, NaN, Infinity, -1, 0, 17.9]) expect(textSizeForSystemBody(value)).toBe("standard");
  expect(textSizeForSystemBody(18)).toBe("large");
  expect(textSizeForSystemBody(19.9)).toBe("large");
  expect(textSizeForSystemBody(20)).toBe("xlarge");
});

test("SSR和不支持系统字体时返回null", () => {
  vi.stubGlobal("document", undefined);
  expect(readSystemBodySize()).toBeNull();
  expect(supportsSystemTextSize()).toBe(false);
});

function fixture(size = "19px", supported = true, throws = false) {
  const remove = vi.fn();
  const probe = { style: { cssText: "" }, remove };
  const append = vi.fn();
  const doc = { createElement: vi.fn(() => probe), defaultView: {
    CSS: { supports: vi.fn(() => supported) },
    getComputedStyle: vi.fn(() => { if (throws) throw Error("measurement failed"); return { fontSize: size }; }),
  } };
  return { root: { ownerDocument: doc, append } as unknown as HTMLElement, doc, probe, remove, append };
}

test("探针只在root所属document实测并移除", () => {
  const f = fixture();
  vi.stubGlobal("document", { createElement: () => { throw Error("wrong document"); } });
  expect(readSystemBodySize(f.root)).toBe(19);
  expect(f.append).toHaveBeenCalledWith(f.probe);
  expect(f.probe.style.cssText).toContain("font: -apple-system-body");
  expect(f.remove).toHaveBeenCalledOnce();
  expect(supportsSystemTextSize(f.root)).toBe(true);
});

test("CSS不支持、异常和非法尺寸保守回退，异常也清理探针", () => {
  const unsupported = fixture("19px", false);
  expect(readSystemBodySize(unsupported.root)).toBeNull();
  expect(unsupported.doc.createElement).not.toHaveBeenCalled();
  for (const f of [fixture("0px"), fixture("NaN"), fixture("-1px"), fixture("19px", true, true)]) {
    expect(readSystemBodySize(f.root)).toBeNull();
    expect(f.remove).toHaveBeenCalledOnce();
  }
});
