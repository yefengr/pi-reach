import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 与 pwa/Dockerfile、relay/Dockerfile 的构建输入对应；共享输入变化时两个组件都重建。
const SHARED_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'pi-extension/package.json', 'packages/protocol/'];
export const COMPONENT_INPUTS = {
  relay: [...SHARED_INPUTS, 'relay/'],
  pwa: [...SHARED_INPUTS, 'pi-extension/install.sh', 'pwa/'],
};

function matches(file, input) {
  return input.endsWith('/') ? file.startsWith(input) : file === input;
}

// 以分支相对 main 分叉点的全部改动选组件，staging 因此始终是该分支的完整状态，而非仅最近一次推送。
export function branchComponents(files) {
  return Object.fromEntries(Object.entries(COMPONENT_INPUTS).map(([component, inputs]) => [
    component,
    files.some((file) => inputs.some((input) => matches(file, input))),
  ]));
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function main() {
  const env = process.env;
  const note = (message) => {
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${message}\n`);
  };
  const base = git(['merge-base', 'origin/main', 'HEAD']);
  const files = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  const selected = branchComponents(files);
  for (const [component, value] of Object.entries(selected)) {
    note(value ? `部署 ${component}：分支相对 main 改动了其构建输入。` : `${component} 无改动，staging 对齐生产当前版本。`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${component}=${value}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
