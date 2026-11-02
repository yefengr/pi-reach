import { afterEach, expect, test } from "vitest";
import { renderPwa } from "@/test/browser/render";
import { detectHairline, HAIRLINE_ATTRIBUTE } from "./hairline";

const root = document.documentElement;
const token = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();

/** 用真实边框解析颜色，避免在测试里重复维护各主题取值。 */
function resolvedBorder(value: string) {
  const probe = document.createElement("div");
  probe.style.borderTop = value;
  document.querySelector(".pwa-root")!.append(probe);
  const style = getComputedStyle(probe);
  const result = [style.borderTopWidth, style.borderTopColor];
  probe.remove();
  return result;
}

afterEach(() => {
  root.removeAttribute(HAIRLINE_ATTRIBUTE);
  root.removeAttribute("data-mantine-color-scheme");
});

test("Chromium draws 0.5px borders as a full pixel, so detection leaves the hairline flag off and removes the probe", async () => {
  await renderPwa(<div />);
  root.setAttribute(HAIRLINE_ATTRIBUTE, "");
  const children = document.body.childElementCount;
  expect(detectHairline()).toBe(false);
  expect(root.hasAttribute(HAIRLINE_ATTRIBUTE)).toBe(false);
  expect(document.body.childElementCount).toBe(children);
});

test.each(["light", "dark"])("the hairline flag switches width with the separator and edge tiers together in %s", async scheme => {
  root.setAttribute("data-mantine-color-scheme", scheme);
  await renderPwa(<div />);
  expect(token("--pwa-hairline")).toBe("1px");
  const tiers = ["separator", "edge"].map(role => ({
    role,
    regular: resolvedBorder(`1px solid var(--pwa-${role}-regular)`)[1],
    deeper: resolvedBorder(`1px solid var(--pwa-${role}-hairline)`)[1],
  }));
  for (const { role, regular } of tiers) expect(resolvedBorder(`var(--pwa-hairline) solid var(--pwa-${role})`)[1]).toBe(regular);

  root.setAttribute(HAIRLINE_ATTRIBUTE, "");
  expect(token("--pwa-hairline")).toBe("0.5px");
  for (const { role, regular, deeper } of tiers) {
    expect(resolvedBorder(`var(--pwa-hairline) solid var(--pwa-${role})`)[1]).toBe(deeper);
    expect(deeper).not.toBe(regular);
  }
});
