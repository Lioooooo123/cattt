import { expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { createApnsTransport, type ApnsRequest } from "../src/push/apns.ts";
import { configFromEnv } from "../src/runtime/config.ts";

test("APNs 请求固定使用 Apple origin、ES256 和稳定的投递 ID", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const requests: ApnsRequest[] = [];
  const send = createApnsTransport({
    teamId: "TEAM", keyId: "KEY", privateKey: await exportPKCS8(keys.privateKey),
    request: async (request) => { requests.push(request); return { status: 200 }; },
  });
  const input = {
    token: "a".repeat(64), environment: "sandbox" as const, topic: "test.cattt",
    apnsId: crypto.randomUUID(), payload: { aps: { alert: "团子" } },
  };
  expect(await send(input)).toEqual({ status: 200 });
  await send({ ...input, environment: "production" });
  expect(requests.map((r) => r.origin)).toEqual(["https://api.sandbox.push.apple.com", "https://api.push.apple.com"]);
  const first = requests[0]!;
  expect(first.headers).toMatchObject({
    ":method": "POST", ":path": "/3/device/" + input.token, "apns-id": input.apnsId,
    "apns-collapse-id": input.apnsId, "apns-topic": input.topic, "apns-expiration": "0", "apns-push-type": "alert",
  });
  expect(requests[1]!.headers.authorization).toBe(first.headers.authorization);
  const proof = await jwtVerify(first.headers.authorization!.slice(7), keys.publicKey, {
    issuer: "TEAM", algorithms: ["ES256"], maxTokenAge: 60,
  });
  expect(proof.protectedHeader.kid).toBe("KEY");
  expect(JSON.parse(first.body)).toEqual(input.payload);
});

test("既有 APNs 配置缺省关闭，开启时要求完整配置", () => {
  expect(configFromEnv({ APNS_TOPIC: "test.cattt" }).apns).toBeUndefined();
  expect(() => configFromEnv({ REMOTE_PUSH_ENABLED: "true" })).toThrow("APNS_");
});
