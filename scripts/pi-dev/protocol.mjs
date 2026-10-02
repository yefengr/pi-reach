import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const STATE_DIR_ENV = "PI_REACH_DEV_STATE_DIR";
export const PARENT_PID_ENV = "PI_REACH_DEV_PARENT_PID";
export const REQUEST_FILE = "restart.json";
const REQUEST_LIMIT = 64 * 1024;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REQUEST_KEYS = ["version", "pid", "cwd", "sessionFile", "provider", "model", "thinking"];

const VALUE_OPTIONS = new Set([
  "--session", "--session-id", "--fork", "--session-dir", "--provider", "--model", "--thinking",
  "--extension", "-e", "--name", "-n", "--tui-mode",
]);
const FLAG_OPTIONS = new Set([
  "--continue", "-c", "--resume", "-r", "--no-extensions", "-ne",
  "--offline", "--verbose", "--approve", "-a", "--no-approve", "-na",
]);
const SELECTORS = new Set(["--session", "--session-id", "--fork", "--continue", "-c", "--resume", "-r"]);
const INITIAL_ONLY = new Set([...SELECTORS, "--name", "-n", "--provider", "--model", "--thinking"]);

export function parseOptions(args) {
  const initial = [];
  const retained = [];
  let selector;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!VALUE_OPTIONS.has(option) && !FLAG_OPTIONS.has(option)) {
      throw new Error(`不支持的启动参数：${option}。请用 --help 查看允许的参数；不接受初始提示词。`);
    }
    if (SELECTORS.has(option)) {
      if (selector) throw new Error("只能指定一个会话选择参数。");
      selector = option;
    }
    const entry = [option];
    if (VALUE_OPTIONS.has(option)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`${option} 缺少参数值。`);
      entry.push(value);
    }
    initial.push(...entry);
    if (!INITIAL_ONLY.has(option)) retained.push(...entry);
  }
  return { initial, retained };
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

export function validateRequest(request, { pid, cwd }) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).length !== REQUEST_KEYS.length
    || !REQUEST_KEYS.every((key) => Object.hasOwn(request, key))) {
    throw new Error("重启请求格式无效。");
  }
  if (request.version !== 1 || !Number.isSafeInteger(request.pid) || request.pid !== pid) {
    throw new Error("重启请求不属于本轮 Pi 进程。");
  }
  if (!nonempty(request.cwd) || !isAbsolute(request.cwd) || request.cwd !== cwd) {
    throw new Error("重启请求的工作目录不匹配。");
  }
  if (!nonempty(request.sessionFile) || !isAbsolute(request.sessionFile)
    || !statSync(request.sessionFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("会话尚未保存或会话文件不存在，无法安全重启。");
  }
  if (!nonempty(request.provider) || request.provider.startsWith("-")
    || !nonempty(request.model) || request.model.startsWith("-")
    || !THINKING_LEVELS.has(request.thinking)) {
    throw new Error("重启请求的模型或思考级别无效。");
  }
  return request;
}

export function readRequest(directory, identity) {
  const path = join(directory, REQUEST_FILE);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.size > REQUEST_LIMIT) throw new Error("重启请求文件无效。");
  return validateRequest(JSON.parse(readFileSync(path, "utf8")), identity);
}

export function resumeOptions(retained, request) {
  return [...retained, "--session", request.sessionFile, "--provider", request.provider,
    "--model", request.model, "--thinking", request.thinking];
}
