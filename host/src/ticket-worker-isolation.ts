import { ToolProtocolError } from "./llm/tool-loop.ts";
import type { ComputeRequest, ComputeResult } from "./ticket-workers/compute.ts";

export type ComputeReply = { ok: true; result: ComputeResult } | { ok: false };

/** 计算线程只收可克隆的数据。数据库、槽位密钥与发布能力留在宿主线程。 */
export function computeInWorker<Request extends ComputeRequest>(
  request: Request, signal: AbortSignal,
): Promise<ComputeResult<Request>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./ticket-workers/compute-worker.ts", import.meta.url), { env: {} });
    function close(): void {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    }
    function abort(): void {
      close();
      reject(signal.reason);
    }
    worker.onmessage = (event: MessageEvent<ComputeReply>) => {
      close();
      if (event.data.ok) {
        resolve(event.data.result as ComputeResult<Request>);
      } else {
        reject(new ToolProtocolError("计算器拒绝无效的输入"));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      close();
      reject(new Error("隔离计算失败"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      worker.postMessage(request);
    } catch (error) {
      close();
      reject(error);
    }
  });
}
