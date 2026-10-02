import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";
import { parseOptions, PARENT_PID_ENV, readRequest, resumeOptions, STATE_DIR_ENV } from "./protocol.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(SCRIPT_DIR, "restart-extension.mjs");
const DEFAULT_TEMP_BASE = resolve(SCRIPT_DIR, "../../.pi/tmp");

export const HELP = `用法：bash scripts/pi-dev.sh [Pi 参数]

仅供本地开发：在当前终端启动 Pi。Agent 在扩展更新及验证成功后调用
 dev_restart 工具，完成本轮总结后自动重启并恢复同一会话，无需手动输入命令。
/dev-restart 保留作手动备用。普通退出或异常退出不会重启。
脚本不负责构建、安装或核验更新，不会自动发送“继续”。

示例：
  bash scripts/pi-dev.sh
  bash scripts/pi-dev.sh --session /absolute/path/to/session.jsonl
  bash scripts/pi-dev.sh --continue
  bash scripts/pi-dev.sh -e ./pi-extension/dist/index.js

支持的 Pi 参数（值必须单独传入，不支持 --key=value）：
  --session <path|id> | --session-id <id> | --fork <path|id>
  --continue / -c | --resume / -r         上述会话选择参数互斥
  --session-dir <dir>
  --provider <name>  --model <id>  --thinking <level>
  --extension / -e <path>                可重复
  --no-extensions / -ne
  --name / -n <name>                     只在首次启动使用
  --offline  --verbose  --tui-mode <mode>
  --approve / -a  --no-approve / -na
  --help / -h

需要 Node.js、PATH 中可用的 Pi 和交互式终端；不支持 Windows、临时会话、
print/RPC/JSON 模式、初始提示词或未列出的参数。只有已保存到磁盘的会话可重启。
重启恢复当前会话、目录、模型和思考级别；不恢复工具进程或未发送输入。
排队消息未处理完时拒绝重启。
`;

function waitForChild(child) {
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
}

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 1);
}

// 注入进程边界供离线测试使用；CLI 不提供任意命令或绕过 TTY 的开关。
export async function runLauncher(args, {
  cwd = process.cwd(),
  env = process.env,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  platform = process.platform,
  spawnPi = (piArgs, options) => spawn("pi", piArgs, options),
  signals = process,
  tempBase = DEFAULT_TEMP_BASE,
  log = (message) => console.log(message),
  reportError = (message) => console.error(message),
} = {}) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    log(HELP);
    return 0;
  }
  let root;
  let child;
  let stoppedBy;
  const stop = (signal) => {
    stoppedBy ??= signal;
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  // 终端信号会发给整个前台进程组；Pi 自己处理 Ctrl+C，外层不能抢先退出。
  const interrupt = () => {};
  const terminate = () => stop("SIGTERM");
  const hangup = () => stop("SIGHUP");
  try {
    const { initial, retained } = parseOptions(args);
    if (platform === "win32") throw new Error("请在 macOS、Linux 或 WSL 中运行。");
    if (!isTTY) throw new Error("请从交互式终端运行启动脚本，不要在 Pi 的 bash 工具或管道中启动。");
    mkdirSync(tempBase, { recursive: true });
    root = mkdtempSync(join(tempBase, "pi-dev-"));
    chmodSync(root, 0o700);
    signals.on("SIGINT", interrupt);
    signals.on("SIGTERM", terminate);
    signals.on("SIGHUP", hangup);
    let nextArgs = initial;
    while (!stoppedBy) {
      const stateDir = mkdtempSync(join(root, "run-"));
      chmodSync(stateDir, 0o700);
      child = spawnPi([...nextArgs, "--extension", EXTENSION_PATH], {
        cwd,
        env: { ...env, [STATE_DIR_ENV]: stateDir, [PARENT_PID_ENV]: String(process.pid) },
        stdio: "inherit",
        shell: false,
      });
      const { code, signal } = await waitForChild(child);
      if (stoppedBy) return signalExitCode(stoppedBy);
      if (signal) return signalExitCode(signal);
      if (code !== 0) return code ?? 1;
      const request = readRequest(stateDir, { pid: child.pid, cwd });
      rmSync(stateDir, { recursive: true, force: true });
      if (!request) return 0;
      nextArgs = resumeOptions(retained, request);
      log("[pi-dev] 正在重启 Pi 并恢复原会话…");
    }
    return signalExitCode(stoppedBy);
  } catch (error) {
    reportError(`[pi-dev] ${error.message}`);
    return 1;
  } finally {
    signals.removeListener("SIGINT", interrupt);
    signals.removeListener("SIGTERM", terminate);
    signals.removeListener("SIGHUP", hangup);
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLauncher(process.argv.slice(2));
}
