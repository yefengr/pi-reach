import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 仅隔离 Docker 验收使用：无网络、无凭据、无推理或工具调用。 */
export default function registerE2eProvider(pi: ExtensionAPI) {
  pi.registerProvider("pi-reach-e2e", {
    api: "pi-reach-e2e",
    baseUrl: "http://e2e.invalid",
    apiKey: "pi-reach-e2e-not-a-credential",
    models: [{ id: "fixture", name: "Pi Reach E2E fixture", reasoning: false, input: ["text"],
      contextWindow: 131072, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
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
            stream.push({ type: "done", reason: "stop", message: { ...message, stopReason: "stop" } });
          }
        } catch {
          stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "E2E fixture failed" } });
        } finally { stream.end(); }
      });
      return stream;
    },
  });
}
