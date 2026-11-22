// 与 server/src/push/apns.ts 使用同一套 Apple HTTP/2、ES256 与投递头契约。
import { connect } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { SystemClock } from "../clock/index.ts";

const providerClock = new SystemClock("apns");

export type PushEnvironment = "sandbox" | "production";
export type PushRequest = {
  token: string;
  environment: PushEnvironment;
  topic: string;
  apnsId: string;
  payload: Record<string, unknown>;
};
export type PushResponse = { status: number; reason?: string; timestamp?: number };
export type ApnsRequest = { origin: string; headers: Record<string, string>; body: string };
export type PushTransport = (request: PushRequest, signal?: AbortSignal) => Promise<PushResponse>;

export async function apnsHTTP2(input: ApnsRequest, signal?: AbortSignal): Promise<PushResponse> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const client = connect(input.origin);
    let settled = false;
    const abort = () => finish(new Error("apns_aborted"));
    const timer = setTimeout(() => finish(new Error("apns_timeout")), 10_000);
    const finish = (error: Error | undefined, value?: PushResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      client.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    signal?.addEventListener("abort", abort, { once: true });
    client.once("error", finish);
    const stream = client.request(input.headers);
    let status = 0;
    let body = "";
    stream.once("response", (headers) => { status = Number(headers[":status"]); });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 10_000) finish(new Error("apns_response_too_large"));
    });
    stream.once("error", finish);
    stream.once("end", () => {
      if (!Number.isInteger(status) || status < 100) {
        finish(new Error("apns_no_response"));
        return;
      }
      let data: { reason?: unknown; timestamp?: unknown } = {};
      try { data = JSON.parse(body) ?? {}; } catch {}
      finish(undefined, {
        status, reason: typeof data.reason === "string" ? data.reason : undefined,
        timestamp: typeof data.timestamp === "number" ? data.timestamp : undefined,
      });
    });
    stream.end(input.body);
  });
}

export function createApnsTransport(options: {
  teamId: string;
  keyId: string;
  privateKey: string;
  request?: (input: ApnsRequest, signal?: AbortSignal) => Promise<PushResponse>;
}): PushTransport {
  let key: ReturnType<typeof importPKCS8> | undefined;
  let jwt: Promise<string> | undefined;
  let issued = 0;
  return async (input, signal) => {
    signal?.throwIfAborted();
    const now = Math.floor(providerClock.wallMs() / 1000);
    if (!jwt || now < issued || now - issued >= 3000) {
      key ??= importPKCS8(options.privateKey, "ES256");
      jwt = key.then((privateKey) => new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: options.keyId })
        .setIssuer(options.teamId).setIssuedAt(now).sign(privateKey));
      issued = now;
    }
    const authorization = "bearer " + await jwt;
    return (options.request ?? apnsHTTP2)({
      origin: input.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com",
      headers: {
        ":method": "POST",
        ":path": "/3/device/" + input.token,
        authorization,
        "apns-topic": input.topic,
        "apns-id": input.apnsId,
        "apns-collapse-id": input.apnsId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "0",
        "content-type": "application/json",
      },
      body: JSON.stringify(input.payload),
    }, signal);
  };
}
