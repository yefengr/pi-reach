/** Chromium 的媒体模拟不支持 display-mode；取出 standalone 媒体查询内的规则直接生效，模拟主屏 PWA。 */
export function applyStandaloneRules() {
  const blocks: string[] = [];
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("display-mode: standalone")) blocks.push([...rule.cssRules].map(inner => inner.cssText).join("\n"));
    }
  }
  const style = document.createElement("style");
  style.textContent = blocks.join("\n");
  document.head.append(style);
  return { blocks: blocks.length, remove: () => style.remove() };
}
