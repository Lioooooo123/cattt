import { homedir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "./index.ts";

export function configFromEnv(env: Record<string, string | undefined>): HostConfig {
  const portText = env.CATTT_PORT ?? "8788";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("CATTT_PORT 必须是 0 至 65535 的整数");
  }
  return {
    dataDir: env.CATTT_DATA_DIR || join(homedir(), ".cattt", "host"),
    port,
    hostname: "127.0.0.1",
  };
}
