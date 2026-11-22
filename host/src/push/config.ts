import { readFileSync } from "node:fs";
import { createApnsTransport, type PushTransport } from "./apns.ts";

export type ApnsConfig = { topic: string; send: PushTransport };

export function apnsConfigFromEnv(env: Record<string, string | undefined>): ApnsConfig | undefined {
  if (env.REMOTE_PUSH_ENABLED !== "true") return undefined;
  const teamId = env.APNS_TEAM_ID;
  const keyId = env.APNS_KEY_ID;
  const keyFile = env.APNS_PRIVATE_KEY_FILE;
  const topic = env.APNS_TOPIC;
  if (!teamId || !keyId || !keyFile || !topic) {
    throw new Error("启用远程推送需要 APNS_TEAM_ID、APNS_KEY_ID、APNS_PRIVATE_KEY_FILE 和 APNS_TOPIC");
  }
  return { topic, send: createApnsTransport({ teamId, keyId, privateKey: readFileSync(keyFile, "utf8") }) };
}
