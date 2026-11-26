import { afterEach, expect, test } from "vitest";
import { TextInput } from "@mantine/core";
import { renderPwa } from "@/test/browser/render";
import { detectHairline, installHairlineDetection, HAIRLINE_ATTRIBUTE } from "@yefengr/pwa-foundation";
import "@yefengr/pwa-foundation/surfaces.css";

const root = document.documentElement;
afterEach(() => {
  root.removeAttribute(HAIRLINE_ATTRIBUTE);
  root.removeAttribute("data-mantine-color-scheme");
});

test.each(["light", "dark"])("候选包真实安装：%s 表面分层、发丝线回退及输入焦点保持独立", async (scheme) => {
  await renderPwa(<>
    <div className="pwa-surface-card" data-testid="embedded">嵌入内容</div>
    <div className="pwa-surface-float" data-testid="float">浮层内容</div>
    <div className="pwa-surface-panel" data-testid="panel">常驻内容</div>
    <TextInput label="测试输入" />
  </>);
  root.setAttribute("data-mantine-color-scheme", scheme);
  const style = (id: string) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!);
  expect(style("embedded").borderTopWidth).toBe("0px");
  expect(style("embedded").borderRadius).toBe("16px");
  expect(style("embedded").boxShadow).toBe("none");
  expect(style("embedded").backgroundColor).toBe(scheme === "light" ? "rgb(247, 247, 247)" : "rgb(45, 45, 45)");
  expect(style("float").borderRadius).toBe("12px");
  expect(style("float").boxShadow).not.toBe("none");
  expect(style("panel").borderRadius).toBe("16px");
  expect(style("panel").backgroundColor).toBe(scheme === "light" ? "rgb(247, 247, 247)" : "rgb(40, 40, 40)");
  expect(style("panel").boxShadow === "none").toBe(scheme === "dark");
  expect(style("panel").boxShadow).not.toBe(style("float").boxShadow);
  const release1 = installHairlineDetection();
  const release2 = installHairlineDetection();
  try {
    // Chromium的真实测量维持1px；单独释放一个使用者不改变另一个的接线。
    expect(detectHairline()).toBe(false);
    expect(style("float").borderTopWidth).toBe("1px");
    release1();
    expect(root.hasAttribute(HAIRLINE_ATTRIBUTE)).toBe(false);
    const regular = style("float").borderTopColor;
    root.setAttribute(HAIRLINE_ATTRIBUTE, "");
    expect(getComputedStyle(root).getPropertyValue("--pwa-hairline").trim()).toBe("0.5px");
    expect(style("float").borderTopColor).not.toBe(regular);
    const input = document.querySelector("input")!;
    expect(getComputedStyle(input).borderTopWidth).toBe("1px");
    input.focus();
    expect(getComputedStyle(input).outlineWidth).toBe("2px");
    expect(getComputedStyle(input).borderTopWidth).toBe("1px");
    expect(Math.round(input.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  } finally { release1(); release2(); }
});
