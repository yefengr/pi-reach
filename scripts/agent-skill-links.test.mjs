import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 项目技能真源在 .agents/skills/；Claude Code 只发现 .claude/skills/，那里只放指向真源的同名相对软链。
const ROOT = new URL("..", import.meta.url).pathname;
const SKILL_SOURCE = ".agents/skills";
const SKILL_LINKS = ".claude/skills";

const entries = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : []);
const skills = entries(SKILL_SOURCE).filter((name) => existsSync(join(ROOT, SKILL_SOURCE, name, "SKILL.md")));

test("every project skill has a Claude Code link to its source", () => {
  assert.ok(skills.length > 0, `${SKILL_SOURCE} 下没有技能`);
  const problems = skills.flatMap((name) => {
    const link = join(ROOT, SKILL_LINKS, name);
    const stat = lstatSync(link, { throwIfNoEntry: false });
    if (!stat) return [`${name}：缺少 ${SKILL_LINKS}/${name}`];
    if (!stat.isSymbolicLink()) return [`${name}：${SKILL_LINKS}/${name} 不是软链，不要复制技能内容`];
    const target = readlinkSync(link);
    return target === `../../${SKILL_SOURCE}/${name}` ? [] : [`${name}：软链指向 ${target}，应为 ../../${SKILL_SOURCE}/${name}`];
  });
  assert.deepEqual(problems, []);
});

test("Claude Code skill directory only contains links to project skills", () => {
  const orphans = entries(SKILL_LINKS).filter((name) => !skills.includes(name));
  assert.deepEqual(orphans, [], `${SKILL_LINKS} 中存在没有对应 ${SKILL_SOURCE} 技能的条目`);
});
