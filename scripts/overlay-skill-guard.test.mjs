import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import test from "node:test";

// overlay 验证技能与 PWA 现状的同步守卫：技能引用失效，或新增、删除叠层组件未同步技能时失败。
const ROOT = new URL("..", import.meta.url).pathname;
const SKILL_PATH = ".agents/skills/validate-mantine-stacked-overlays/SKILL.md";
const PWA_SRC = "pwa/src";
const COMPONENT_DIR = "pwa/src/components/pwa";
const GUARD_DIR = "pwa/src/app";
const DESIGN_PATH = "docs/DESIGN.md";
const COMPONENT_LIST_PREFIX = "- 叠层组件清单";
const TEST_LIST_PREFIX = "- 现有目标测试";
// 技能覆盖的叠层种类；Tooltip 不接收焦点，也不参与 Escape 与焦点返回，不纳入。
const OVERLAY_EXPORTS = new Set(["Modal", "Drawer", "Menu", "Popover", "Notifications"]);
const MANTINE_IMPORT = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']@mantine\/(?:core|notifications)["']/g;

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const skill = read(SKILL_PATH);

function walk(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes("/test/");
const sourceFiles = walk(PWA_SRC).filter((path) => /\.(tsx?|css)$/.test(path));
const sourceText = sourceFiles.map(read).join("\n");

function codeSpans(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function skillLine(prefix) {
  const line = skill.split("\n").find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `${SKILL_PATH} 缺少以「${prefix}」开头的清单行`);
  return line;
}

function importedOverlays(text) {
  return [...text.matchAll(MANTINE_IMPORT)]
    .flatMap((match) => match[1].split(","))
    .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
    .filter((name) => OVERLAY_EXPORTS.has(name));
}

test("skill component list matches product components that import Mantine overlays", () => {
  // 状态展厅与评审页只组合产品组件，不作为独立叠层登记。
  const products = sourceFiles.filter((path) => path.endsWith(".tsx") && !isTest(path) && !path.startsWith(`${PWA_SRC}/dev/`));
  const overlays = products.filter((path) => importedOverlays(read(path)).length > 0).map((path) => basename(path, extname(path)));
  assert.ok(overlays.length > 0, "未扫描到任何叠层组件，检查扫描规则");
  const listed = codeSpans(skillLine(COMPONENT_LIST_PREFIX)).filter((name) => !name.includes("/") && !name.includes("."));
  assert.deepEqual([...listed].sort(), [...overlays].sort(), `${SKILL_PATH} 的叠层组件清单与源码不一致：同步清单，并核对验证矩阵是否覆盖新增或删除的叠层`);
});

test("skill test locations point to existing test files", () => {
  const tests = readdirSync(join(ROOT, COMPONENT_DIR)).filter(isTest);
  const names = codeSpans(skillLine(TEST_LIST_PREFIX)).filter((name) => !name.includes("/"));
  assert.ok(names.length > 0);
  const missing = names.filter((name) => !tests.some((file) => file.startsWith(`${name}.`)));
  assert.deepEqual(missing, [], `${SKILL_PATH} 引用的测试在 ${COMPONENT_DIR} 中不存在`);
});

test("skill DESIGN section references match existing headings", () => {
  const headings = new Set(read(DESIGN_PATH).split("\n").map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]).filter(Boolean));
  const sections = [...skill.matchAll(/DESIGN(?:\.md\))?(?:的)?((?:「[^」]+」)+)/g)]
    .flatMap((match) => [...match[1].matchAll(/「([^」]+)」/g)].map((section) => section[1]));
  assert.ok(sections.length > 0);
  const missing = [...new Set(sections)].filter((section) => !headings.has(section));
  assert.deepEqual(missing, [], `${SKILL_PATH} 引用的 DESIGN 章节不存在`);
});

test("skill code references exist in the PWA", () => {
  const spans = [...new Set(codeSpans(skill))];
  const checks = spans.flatMap((span) => {
    if (/^\.pwa-[a-z0-9-]+$/.test(span)) return [[span, sourceText.includes(span.slice(1))]];
    if (/^pwa-[a-z-]+-guard$/.test(span)) return [[span, existsSync(join(ROOT, GUARD_DIR, `${span}.node.test.ts`))]];
    if (/^[a-z]+\.config\.ts$/.test(span)) return [[span, existsSync(join(ROOT, "pwa", span))]];
    // 驼峰标识符（组件、hook、测试工具或 DOM／Mantine 选项）须在 PWA 源码或测试中实际使用。
    if (/^[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(span)) return [[span, new RegExp(`\\b${span}\\b`).test(sourceText)]];
    return [];
  });
  assert.ok(checks.length > 0);
  const missing = checks.filter(([, found]) => !found).map(([span]) => span);
  assert.deepEqual(missing, [], `${SKILL_PATH} 引用的代码标识在 PWA 中不存在`);
});
