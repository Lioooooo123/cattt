import type { ToolModel } from "./tool-loop.ts";

/** MODEL_PROVIDER=mock 的离线托付响应。 */
export const mockWorkerModel: ToolModel = {
  async complete(request, signal) {
    signal.throwIfAborted();
    const knownCalls = request.messages.flatMap((message) => message.role === "assistant" ? message.calls.map((call) => call.id) : []);
    return {
      finishReason: "tool-calls", text: "", reasoning: "", outputTokens: 32,
      calls: [{
        id: crypto.randomUUID(),
        name: "report",
        input: knownCalls.length === 0
          ? { status: "waiting", question: "你想先从哪个部分开始整理？" }
          : { status: "blocked", reason: "当前是模拟模型，需要配置执行模型才能继续整理。" },
      }],
    };
  },
};
