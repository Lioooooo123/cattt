import type { ModelClient, ModelMessage } from "../src/llm/types.ts";
import type { ToolModel, ToolRequest, ToolResponse, ToolMessage } from "../src/llm/tool-loop.ts";

export interface ModelCallTrace {
  purpose?: "target" | "judge";
  provider: string;
  model: string;
  request: { system?: string; messages: ModelMessage[]; extraBody?: Record<string, unknown>; maxOutputTokens?: number };
  text: string;
  latency_ms: number;
  error?: string;
  tool_request?: Omit<ToolRequest, "tools" | "guard"> & { tools: string[] };
  tool_response?: ToolResponse;
}
export interface WorkerStepTrace { step: number; history: ToolMessage[] }
export function traceToolModel(client: ToolModel, trace: ModelCallTrace[], provider: string, model: string): ToolModel {
  return { async complete(request, signal) {
    const entry: ModelCallTrace = { purpose: "target", provider, model, request: { system: request.system, messages: [] },
      text: "", latency_ms: 0, tool_request: structuredClone({ system: request.system, messages: request.messages,
        maxOutputTokens: request.maxOutputTokens, tools: request.tools.map((tool) => tool.name) }) };
    trace.push(entry);
    const start = performance.now();
    try {
      const response = await client.complete(request, signal);
      entry.text = response.text; entry.tool_response = structuredClone(response);
      return response;
    } catch (error) { entry.error = String(error); throw error; }
    finally { entry.latency_ms = performance.now() - start; }
  } };
}
export function traceModel(client: ModelClient, trace: ModelCallTrace[]): ModelClient {
  return {
    provider: client.provider, modelId: client.modelId,
    async *stream(request, signal) {
      const entry: ModelCallTrace = {
        provider: client.provider, model: client.modelId,
        request: structuredClone({ system: request.system, messages: request.messages,
          extraBody: request.extraBody, maxOutputTokens: request.maxOutputTokens }),
        text: "", latency_ms: 0,
      };
      trace.push(entry);
      const start = performance.now();
      try {
        for await (const event of client.stream(request, signal)) {
          if (event.type === "text-delta") entry.text += event.delta;
          yield event;
        }
      } catch (error) {
        entry.error = String(error);
        throw error;
      } finally { entry.latency_ms = performance.now() - start; }
    },
  };
}
