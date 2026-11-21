import { homedir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "./index.ts";

export const DEFAULT_MAX_MEMBERS = 2;
export const DEFAULT_HOUSEHOLD_NAME = "我们的家";
export const DEFAULT_HOST_NAME = "我的 Mac";

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
    householdName: env.CATTT_HOUSEHOLD_NAME ?? DEFAULT_HOUSEHOLD_NAME,
    hostName: env.CATTT_HOST_NAME ?? DEFAULT_HOST_NAME,
    maxMembers: DEFAULT_MAX_MEMBERS,
  };
}
