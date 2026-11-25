import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
type Rule = { selector: string; media: string; declarations: Record<string, string> };

// 仅处理本批普通声明与嵌套媒体规则，不充当通用 CSS parser；逗号不能拆开 :is()/var()。
function selectors(text: string): string[] {
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    if (text[i] === "," && depth === 0) { result.push(normalize(text.slice(start, i))); start = i + 1; }
  }
  result.push(normalize(text.slice(start)));
  return result;
}
function rules(text: string, media = ""): Rule[] {
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const result: Rule[] = [];
  let start = 0;
  while (start < text.length) {
    const open = text.indexOf("{", start);
    if (open < 0) break;
    let end = open + 1;
    let depth = 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === "{") depth++;
      if (text[end] === "}") depth--;
    }
    if (depth) throw new Error("未闭合的测试 CSS");
    const header = normalize(text.slice(start, open));
    const body = text.slice(open + 1, end - 1);
    if (header.startsWith("@media")) {
      result.push(...rules(body, [media, header].filter(Boolean).join(" / ")));
    } else if (!header.startsWith("@")) {
      const declarations = Object.fromEntries(body.split(";").filter((line) => line.trim()).map((line) => {
        const colon = line.indexOf(":");
        if (colon < 0) throw new Error("缺少声明分隔符");
        return [normalize(line.slice(0, colon)), normalize(line.slice(colon + 1))];
      }));
      for (const selector of selectors(header)) result.push({ selector, media, declarations });
    }
    start = end;
  }
  return result;
}
function declarations(list: Rule[], selector: string, media = "") {
  const matched = list.filter((rule) => rule.selector === selector && rule.media === media);
  expect(matched.length, `${media} ${selector} 必须存在`).toBeGreaterThan(0);
  return Object.assign({}, ...matched.map((rule) => rule.declarations)) as Record<string, string>;
}
const controls = rules(read("../controls.css"));
const globals = rules(read("../../../pwa/src/app/globals.css"));
const sourceControls = rules(read("../../../pwa/src/app/pwa-controls.css"));
const sourceTheme = rules(read("../../../pwa/src/app/pwa-theme.css"));
const scope = ".pwa-ui-scope ";
const hover = "@media (hover: hover)";
const mobile = "@media (max-width: 767.98px)";
const reduced = "@media (prefers-reduced-motion: reduce)";
function equal(target: string, original = target, media = "", source = globals) {
  expect(declarations(controls, target, media), `${media} ${target} ← ${original}`).toEqual(declarations(source, original, media));
}

test("局部规范化保留媒体 scope、声明覆盖与函数内逗号", () => {
  const fixture = rules(`/*注释*/ .a, :is(.b, .c) { color: red; } .a { color: blue; }
    @media (pointer: coarse) { .a { color: green; padding: 0  4px; } }`);
  expect(declarations(fixture, ".a")).toEqual({ color: "blue" });
  expect(declarations(fixture, ":is(.b, .c)")).toEqual({ color: "red" });
  expect(declarations(fixture, ".a", "@media (pointer: coarse)")).toEqual({ color: "green", padding: "0 4px" });
});

test("控件选择器不泄漏到 scope 外，根规则只调整输入能力 token", () => {
  for (const rule of controls) {
    if (rule.selector === ":root") {
      expect(["@media (hover: hover) and (pointer: fine)", "@media (any-pointer: coarse), (hover: none)"]).toContain(rule.media);
      expect(Object.keys(rule.declarations).sort()).toEqual(["--pwa-button-height", "--pwa-button-radius"]);
    } else expect(rule.selector.startsWith(scope), rule.selector).toBe(true);
  }
});

test("所有提取 token 按原选择器及媒体 scope 比较，而非任意位置包含", () => {
  const extracted = rules(read("../theme.css"));
  for (const rule of extracted) {
    const tokens = Object.fromEntries(Object.entries(rule.declarations).filter(([key]) => key.startsWith("--pwa-")));
    if (!Object.keys(tokens).length) continue;
    const original = declarations(sourceTheme, rule.selector, rule.media);
    for (const [key, value] of Object.entries(tokens)) expect(original[key], `${rule.media} ${rule.selector} ${key}`).toBe(value);
  }
  // 防止删除某个主题/字号媒体分支后，逐条循环空过。
  for (const media of ["", "@media (pointer: coarse)"]) {
    for (const selector of [":root", ':root[data-pwa-text-size="large"]', ':root[data-pwa-text-size="xlarge"]']) {
      expect(declarations(extracted, selector, media)).toHaveProperty("--pwa-text-body");
    }
  }
  expect(declarations(extracted, ':root[data-mantine-color-scheme="dark"]')).toHaveProperty("--pwa-scrim");
  expect(declarations(extracted, ":root:not([data-mantine-color-scheme])", "@media (prefers-color-scheme: dark)")).toHaveProperty("--pwa-scrim");
  expect(declarations(extracted, ":root", reduced)).toHaveProperty("--pwa-motion-shift", "0");
});

test("Button 全部已提取变体、交互与两种禁用声明映射", () => {
  const button = `${scope}.pwa-button`;
  equal(button);
  for (const variant of ["filled", "default", "transparent", "outline"]) {
    const selector = `${button}[data-variant="${variant}"]`;
    equal(selector);
    equal(`${selector}:hover:not(:disabled):not([data-disabled])`, undefined, hover);
    if (["filled", "default"].includes(variant)) equal(`${selector}:active:not(:disabled):not([data-disabled])`);
  }
  for (const state of [":disabled", "[data-disabled]"]) {
    equal(button + state);
    equal(`${button}[data-variant="transparent"]${state}`);
  }
});

test("ActionIcon 基底、伪元素、focus、filled 与禁用声明映射", () => {
  const icon = `${scope}.pwa-icon-button`;
  equal(icon);
  // ::before 的后续 press transition 以真实级联合并后比较。
  equal(`${icon}::before`, undefined, "", [...globals, ...sourceControls.map((rule) => ({ ...rule, selector: rule.selector.replace(".pwa-root ", "") }))]);
  equal(`${icon}:focus-visible`);
  equal(`${icon}:hover:not(:disabled):not([data-disabled])`, undefined, hover);
  equal(`${icon}:hover:not(:disabled):not([data-disabled])::before`, undefined, hover);
  equal(`${icon}:active:not(:disabled):not([data-disabled])::before`);
  const filled = `${icon}[data-variant="filled"]`;
  for (const suffix of ["", "::before", ":active:not(:disabled):not([data-disabled])::before"]) equal(filled + suffix);
  for (const suffix of ["", "::before"]) equal(`${filled}:hover:not(:disabled):not([data-disabled])${suffix}`, undefined, hover);
  for (const state of [":disabled", "[data-disabled]"]) {
    equal(icon + state); equal(`${icon}${state}::before`); equal(`${filled}${state}::before`);
  }
});

const input = `${scope}:is(.pwa-input, .pwa-textarea, .pwa-select)`;
const field = `${input} :is(input, textarea, select)`;
test("Input 合并规则逐项映射，扩展部分显式检查", () => {
  const { "font-size": fontSize, ...base } = declarations(controls, field);
  for (const selector of [".pwa-input input", ".pwa-textarea textarea", ".pwa-select .mantine-Select-input"]) {
    const { "font-size": originalFont, ...sourceBase } = declarations(globals, scope + selector);
    expect(base).toEqual(sourceBase);
    expect(originalFont).toBe("var(--pwa-text-body)");
    equal(`${field}:focus`, scope + selector + ":focus");
  }
  for (const selector of [".pwa-input input", ".pwa-textarea textarea"]) {
    equal(`${field}::placeholder`, scope + selector + "::placeholder");
    equal(`${field}:is([aria-invalid=\"true\"], [data-error])`, scope + selector + '[aria-invalid="true"]');
    equal(`${field}:is(:disabled, [data-disabled])`, scope + selector + ":disabled");
    for (const part of ["label", "description"]) {
      const root = selector.split(" ")[0];
      equal(`${input} .mantine-InputWrapper-${part}`, `${scope}${root} .mantine-InputWrapper-${part}`);
    }
  }
  expect(fontSize).toBe("max(16px, var(--pwa-text-body))"); // 全尺寸 16 下限为本批扩展。
  // Select/NativeSelect 与 data-error/data-disabled 扩展共享同一 :is 声明，不伪称源已覆盖这些节点。
  expect(declarations(controls, `${input} .mantine-InputWrapper-error`)).toEqual({ "margin-top": "4px", color: "var(--pwa-error)", "font-size": "var(--pwa-text-meta)" });
  expect(declarations(controls, `${field}:is([aria-invalid="true"], [data-error])`)).toEqual({ "border-color": "var(--pwa-error)" });
});

test("Modal 重命名、合并声明及确认区桌面/手机映射", () => {
  equal(`${scope}.pwa-dialog`, ".pwa-confirm-dialog");
  const originalHead = `${scope}:is(.pwa-pairing-head, .pwa-rename-head, .pwa-confirm-head)`;
  equal(`${scope}.pwa-dialog-head`, originalHead);
  equal(`${scope}.pwa-dialog-head > .mantine-Modal-close`, `${originalHead} > .mantine-Modal-close`);
  equal(`${scope}:is(.pwa-dialog-title, .pwa-drawer-title)`, ".pwa-confirm-title");
  expect(read("../../../pwa/src/components/pwa/confirm-action-dialog.tsx")).toContain("styles={{ body: { padding: 0 } }}");
  expect(declarations(controls, `${scope}.pwa-dialog-body`)).toEqual({ padding: "0" }); // 源由实例 styles 提供。
  equal(`${scope}.pwa-confirm-description`, ".pwa-confirm-description");
  equal(`${scope}.pwa-confirm-error`, ".pwa-confirm-error");
  equal(`${scope}.pwa-confirm-actions`, ".pwa-confirm-actions");
  equal(`${scope}.pwa-confirm-actions .pwa-button`, ".pwa-confirm-actions .pwa-button");
  for (const selector of [".pwa-dialog", ".pwa-confirm-actions", ".pwa-confirm-actions .pwa-button"]) {
    equal(scope + selector, selector === ".pwa-dialog" ? ".pwa-confirm-dialog" : selector, mobile);
  }
  const sourceOffset = declarations(globals, ":root .mantine-Modal-root", mobile)["--modal-x-offset"];
  expect(declarations(controls, `${scope}.mantine-Modal-root`, mobile)).toEqual({ "--modal-x-offset": `${sourceOffset} !important` });
});

test("危险确认禁用时仍沿用源实心错误色，交互差异显式限定", () => {
  const danger = `${scope}.pwa-button.pwa-danger-confirm`;
  equal(danger);
  for (const state of [":disabled", "[data-disabled]"]) {
    equal(`${scope}.pwa-button${state}`);
    expect(controls.some((rule) => rule.selector.startsWith(danger + state))).toBe(false);
    expect(declarations(controls, danger)).toEqual({ "border-color": "var(--pwa-error)", color: "var(--pwa-on-status)", background: "var(--pwa-error)" });
  }
  equal(`${danger}:hover:not(:disabled):not([data-disabled])`, `${danger}:hover:not(:disabled)`, hover);
  const active = declarations(globals, `${danger}:active:not(:disabled)`);
  // 本包 token 闭包已保证 active 存在，提取时去掉源 fallback；data-disabled guard 为已冻结扩展。
  expect(declarations(controls, `${danger}:active:not(:disabled):not([data-disabled])`)).toEqual(Object.fromEntries(Object.entries(active).map(([key, value]) => [key, value.replace("var(--pwa-error-active, var(--pwa-error-hover))", "var(--pwa-error-active)")])));
});

test("其余图形、通用焦点与宿主表面的提取/扩展边界均有声明约束", () => {
  for (const selector of ['.lucide[width="16"]', '.lucide[width="16"] > *', '.pwa-button .lucide[width="16"]', '.pwa-icon-button .lucide[width="20"]']) {
    equal(scope + selector, selector);
  }
  equal(`${scope}:is(button, a, input, select, textarea, [tabindex]):focus-visible`, "button:focus-visible");
  expect(declarations(controls, `${scope}:is(button, input, select, textarea)`)).toEqual({ "font-family": declarations(globals, "body")["font-family"] });
  expect(declarations(controls, `${scope}:is(button, a, input, select, textarea, [tabindex])`)).toEqual({ "-webkit-tap-highlight-color": declarations(globals, "button")["-webkit-tap-highlight-color"] });
  // Drawer 仅提取已约定的直角/通用表面，不迁移导航自己的 panel 底、转场或遮罩强制覆盖。
  expect(declarations(controls, `${scope}.pwa-drawer`)).toEqual({ "border-radius": "0", color: "var(--pwa-ink)", background: "var(--pwa-surface)" });
  expect(declarations(controls, `${scope}.pwa-drawer-head`)).toEqual({ background: "var(--pwa-surface)" });
  // 公共遮罩只给语义底色；不带导航专用 !important/backdrop-filter，宿主可显式覆盖。
  expect(declarations(controls, `${scope}.pwa-scrim`)).toEqual({ background: "var(--pwa-scrim)" });
});

test("press/reduced 与输入能力按源媒体作用域比较", () => {
  const pressSelectors = [
    ".pwa-button:active", ".pwa-icon-button:active", ".pwa-icon-button::before",
    ".pwa-button .mantine-Button-inner", ".pwa-icon-button .mantine-ActionIcon-icon",
    ".pwa-icon-button:is(:active, [data-pwa-pressed]):not(:disabled):not([data-disabled])::before",
    ".pwa-icon-button:is(:active, [data-pwa-pressed]):not(:disabled):not([data-disabled]) .mantine-ActionIcon-icon",
    ".pwa-button:is(:active, [data-pwa-pressed]):not(:disabled):not([data-disabled]) .mantine-Button-inner",
    ".pwa-icon-button:is(:disabled, [data-disabled])::before",
    ".pwa-icon-button:is(:disabled, [data-disabled]) .mantine-ActionIcon-icon",
    ".pwa-button:is(:disabled, [data-disabled]) .mantine-Button-inner",
  ];
  const normalizedSource = sourceControls.map((rule) => ({ ...rule, selector: rule.selector.replace(".pwa-root ", "") }));
  for (const selector of pressSelectors) {
    if (selector === ".pwa-icon-button::before") {
      expect(declarations(controls, scope + selector)).toMatchObject(declarations(normalizedSource, scope + selector));
    } else equal(scope + selector, undefined, "", normalizedSource);
  }
  for (const selector of [
    ".pwa-icon-button:active:not(:hover):not(:focus-visible)::before",
    ".pwa-icon-button:active:not(:hover):not(:focus-visible) .mantine-ActionIcon-icon",
    ".pwa-button:active:not(:hover):not(:focus-visible) .mantine-Button-inner",
  ]) equal(scope + selector, undefined, hover, normalizedSource);
  for (const selector of [
    ".pwa-icon-button:is(:active, [data-pwa-pressed])::before",
    ".pwa-icon-button:is(:active, [data-pwa-pressed]) .mantine-ActionIcon-icon",
    ".pwa-button:is(:active, [data-pwa-pressed]) .mantine-Button-inner",
  ]) equal(scope + selector, undefined, reduced, normalizedSource);
  for (const selector of ["*", "*::before", "*::after"]) equal(scope + selector, selector, reduced, sourceTheme);
  for (const media of ["@media (hover: hover) and (pointer: fine)", "@media (any-pointer: coarse), (hover: none)"]) {
    const actual = declarations(controls, ":root", media);
    const original = declarations(sourceControls, ":root", media);
    expect(actual).toEqual({ "--pwa-button-height": original["--pwa-button-height"], "--pwa-button-radius": original["--pwa-button-radius"] });
  }
});
