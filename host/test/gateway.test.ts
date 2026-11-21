import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";

test("Gateway 健康检查与 JSON 404", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-gateway-"));
  const gateway = new Gateway();
  const host = await startHost({ dataDir: directory, port: 0, lanHttpsPort: 0 }, [gateway]);
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    const response = await fetch(`${base}/v2/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      hostId: host.hostId,
      protocolVersion: 1,
    });
    for (const [path, method] of [["/missing", "GET"], ["/v2/healthz", "POST"]]) {
      const missing = await fetch(`${base}${path}`, { method });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toContain("application/json");
      expect(await missing.json()).toEqual({ error: "未找到接口" });
    }
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
