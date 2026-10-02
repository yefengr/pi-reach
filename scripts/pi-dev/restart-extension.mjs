import { closeSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PARENT_PID_ENV, REQUEST_FILE, STATE_DIR_ENV, validateRequest } from "./protocol.mjs";

function managedDirectory(runtime) {
  const directory = runtime.env[STATE_DIR_ENV];
  if (runtime.env[PARENT_PID_ENV] !== String(runtime.ppid) || !directory || !isAbsolute(directory)) {
    throw new Error("请先通过 scripts/pi-dev.sh 启动 Pi，再使用 /dev-restart。");
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== runtime.getuid()) {
    throw new Error("重启控制目录权限无效。");
  }
  return directory;
}

function preflight(ctx, runtime) {
  if (ctx.mode !== "tui") throw new Error("重启仅支持本地交互式终端。");
  const directory = managedDirectory(runtime);
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("临时会话无法恢复，请先使用持久会话。");
  return { directory, sessionFile };
}

function currentRequest(pi, ctx, runtime, sessionFile) {
  return validateRequest({
    version: 1,
    pid: runtime.pid,
    cwd: ctx.cwd,
    sessionFile,
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinking: pi.getThinkingLevel(),
  }, { pid: runtime.pid, cwd: runtime.cwd() });
}

function toolResult(status) {
  return {
    content: [{ type: "text", text: status === "already_requested"
      ? "已请求重启，请完成本轮总结，不要重复调用。"
      : "已请求在本轮结束后重启 Pi 并恢复当前会话。请完成本轮总结；无需用户输入命令。这不是重启完成通知。" }],
    details: { status },
  };
}

// runtime 注入仅用于离线测试；正常加载使用当前 Pi 进程。
export function registerRestart(pi, runtime = process) {
  let epoch = 0;
  let pending = false;
  pi.on("session_shutdown", () => {
    // reload/resume/new 会使旧 ctx 失效；等待中的请求不能跨运行时继续执行。
    epoch++;
    pending = false;
  });
  pi.registerCommand("dev-restart", {
    description: "开发模式：等待空闲后重启 Pi 并恢复当前会话（需要 pi-dev.sh）",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("用法：/dev-restart（先按现有方式完成扩展更新）", "warning");
        return;
      }
      if (pending) {
        ctx.ui.notify("已在等待当前轮结束，请勿重复请求。", "info");
        return;
      }
      const requestEpoch = epoch;
      let directory;
      let published = false;
      let temporaryCreated = false;
      try {
        const state = preflight(ctx, runtime);
        directory = state.directory;
        const sessionFile = state.sessionFile;
        pending = true;
        ctx.ui.notify("等待当前轮结束，然后重启并恢复此会话…", "info");
        await ctx.waitForIdle();
        if (epoch !== requestEpoch) return;
        if (sessionFile !== ctx.sessionManager.getSessionFile()) {
          throw new Error("当前会话已切换，已取消重启；请在目标会话中重新执行。");
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          throw new Error("仍有运行或排队消息，未重启；请处理完后重试。");
        }
        const request = currentRequest(pi, ctx, runtime, sessionFile);
        // 同步发布到本轮私有目录，避免状态捕获与 shutdown 之间插入其他命令。
        const fd = openSync(join(directory, "restart.tmp"), "wx", 0o600);
        temporaryCreated = true;
        try {
          writeFileSync(fd, JSON.stringify(request));
        } finally {
          closeSync(fd);
        }
        renameSync(join(directory, "restart.tmp"), join(directory, REQUEST_FILE));
        temporaryCreated = false;
        published = true;
        ctx.shutdown();
      } catch (error) {
        try {
          if (temporaryCreated) rmSync(join(directory, "restart.tmp"), { force: true });
          if (published) rmSync(join(directory, REQUEST_FILE), { force: true });
          published = false;
        } catch (cleanupError) {
          error = new Error(`${error.message}；清理请求失败：${cleanupError.message}`);
        }
        if (epoch === requestEpoch) ctx.ui.notify(`未重启：${error.message}`, "error");
      } finally {
        if (epoch === requestEpoch && !published) pending = false;
      }
    },
  });
  pi.registerTool({
    name: "dev_restart",
    label: "Restart Pi",
    description: "扩展更新且相关验证成功后，主动调用此工具请求重启 Pi 并恢复当前会话，不要让用户手动输入命令。"
      + "仅用于用户已授权的更新或重启；更新/验证失败时不得调用。作为本轮最后一个工具调用，再给出最终总结。"
      + "等待本轮结束后才重启，不中断当前工具，不自动发起下一轮；需要通过 scripts/pi-dev.sh 启动 Pi。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("本次工具调用已取消，未请求重启。");
      const { sessionFile } = preflight(ctx, runtime);
      currentRequest(pi, ctx, runtime, sessionFile);
      if (pending) return toolResult("already_requested");
      if (ctx.hasPendingMessages()) throw new Error("仍有排队消息，未请求重启；请处理完后重试。");
      // 原生命令分发提供 waitForIdle；工具不能等待自身所在的轮次结束。
      // 必须显式开启命令解析，否则 sendUserMessage 默认会把斜杠文本送给模型。
      pi.sendUserMessage("/dev-restart", { deliverAs: "followUp", expandPromptTemplates: true });
      return toolResult("requested");
    },
  });
}

export default function restartExtension(pi) {
  registerRestart(pi);
}
