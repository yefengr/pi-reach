import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PUBLISH_TRIGGER = "E2E publish file fixtures";
const PUBLISH_PATHS = [
  "/workspace/pi-reach-published-files/report-中文.md",
  "/workspace/pi-reach-published-files/image.png",
  "/workspace/pi-reach-published-files/data.bin",
];

/** 仅隔离 Docker 验收使用：无网络、无凭据，仅精确指令触发固定发布工具。 */
export default function registerE2eProvider(pi: ExtensionAPI) {
  pi.registerProvider("pi-reach-e2e", {
    api: "pi-reach-e2e",
    baseUrl: "http://e2e.invalid",
    apiKey: "pi-reach-e2e-not-a-credential",
    models: [{ id: "fixture", name: "Pi Reach E2E fixture", reasoning: false, input: ["text"],
      contextWindow: 131072, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      // 只检查最后一条消息；工具结果之后正常结束，绝不重扫旧 user 形成循环。
      const last = context.messages.at(-1);
      const text = last?.role === "user"
        ? typeof last.content === "string" ? last.content
          : last.content.length === 1 && last.content[0]?.type === "text" ? last.content[0].text : null
        : null;
      const calls: ToolCall[] = text === PUBLISH_TRIGGER ? PUBLISH_PATHS.map(path => ({
        type: "toolCall", id: `e2e-publish-${crypto.randomUUID()}`, name: "publish_file", arguments: { path },
      })) : [];
      const message: AssistantMessage = {
        role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: "pending" as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(async () => {
        try {
          await options?.onPayload?.({ fixture: true }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          if (options?.signal?.aborted) {
            stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "E2E fixture aborted" } });
          } else {
            stream.push({ type: "start", partial: message });
            for (const toolCall of calls) {
              const contentIndex = message.content.length;
              message.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex, partial: message });
              stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
            }
            const reason = calls.length ? "toolUse" : "stop";
            stream.push({ type: "done", reason, message: { ...message, stopReason: reason } });
          }
        } catch {
          stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "E2E fixture failed" } });
        } finally { stream.end(); }
      });
      return stream;
    },
  });
}
