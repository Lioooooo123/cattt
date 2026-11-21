import { homedir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "./index.ts";

export const DEFAULT_MAX_MEMBERS = 2;
export const DEFAULT_HOUSEHOLD_NAME = "我们的家";
export const DEFAULT_HOST_NAME = "我的 Mac";
export const DEFAULT_LAN_HTTPS_PORT = 8789;

function parsePort(text: string, name: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`${name} 必须是 0 至 65535 的整数`);
  }
  return port;
}

export function configFromEnv(env: Record<string, string | undefined>): HostConfig {
  const port = parsePort(env.CATTT_PORT ?? "8788", "CATTT_PORT");
  return {
    dataDir: env.CATTT_DATA_DIR || join(homedir(), ".cattt", "host"),
    port,
    lanHttpsPort: parsePort(env.CATTT_LAN_HTTPS_PORT ?? String(DEFAULT_LAN_HTTPS_PORT), "CATTT_LAN_HTTPS_PORT"),
    hostname: "127.0.0.1",
    householdName: env.CATTT_HOUSEHOLD_NAME ?? DEFAULT_HOUSEHOLD_NAME,
    hostName: env.CATTT_HOST_NAME ?? DEFAULT_HOST_NAME,
    maxMembers: DEFAULT_MAX_MEMBERS,
  };
}
