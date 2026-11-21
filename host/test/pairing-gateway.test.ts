import { afterEach, expect, spyOn, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { ChatEvents } from "../src/chat-events/index.ts";
import { ManualClock, SystemClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { createDevice, createMember, resolveDeviceToken } from "../src/store/identity.ts";
import { pairingCodes } from "../src/store/schema/identity.ts";

const hosts: Awaited<ReturnType<typeof startHost>>[] = [];
const directories: string[] = [];

async function setup(
  options: ConstructorParameters<typeof Gateway>[0] = {},
  onError?: (error: unknown, source: string) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "cattt-pairing-http-"));
  directories.push(directory);
  const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" }, ...options });
  const clock = new ManualClock("test", new SystemClock("test").wallMs());
  const host = await startHost({ dataDir: directory, port: 0, clock, onError }, [gateway]);
  hosts.push(host);
  return {
    host, gateway, clock, directory,
    ca: readFileSync(join(directory, "tls/ca.crt"), "utf8"),
    admin: readFileSync(join(directory, "host-admin.token"), "utf8"),
    http: `http://127.0.0.1:${gateway.port}`,
    https: `https://127.0.0.1:${gateway.lanPort}`,
  };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("回环管理签发两成员配对码，HTTPS 仅信任本机 CA，解除和管理撤销立即生效", async () => {
  const { host, clock, gateway, http, https, ca, admin } = await setup();
  const adminHeaders = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };
  const members = ["甲", "乙"].map((displayName) => createMember(host.store.db, clock, {
    householdId: host.householdId, homeHostId: host.hostId, displayName,
  }));
  for (const path of ["/host/status", "/host/devices"]) {
    const response = await fetch(http + path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
    const remote = await fetch(https + path, { tls: { ca }, headers: adminHeaders });
    expect(remote.status).toBe(404);
    await remote.body?.cancel();
  }
  expect((await fetch(https + "/host/pairing-codes", {
    method: "POST", tls: { ca }, headers: adminHeaders, body: JSON.stringify({ member_id: members[0] }),
  })).status).toBe(404);
  const status = await fetch(http + "/host/status", { headers: adminHeaders });
  expect(await status.json()).toMatchObject({ lan: { enabled: true, port: gateway.lanPort }, devices: [] });
  const tokens: { device_id: string; device_token: string }[] = [];
  for (const [index, memberId] of members.entries()) {
    const issued = await fetch(http + "/host/pairing-codes", {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ member_id: memberId }),
    });
    expect(issued.status).toBe(200);
    const pairing = await issued.json() as { code: string; pair_url: string; ca_fingerprint: string; expires_at: number };
    const link = new URL(pairing.pair_url);
    expect(link.protocol).toBe("maomao:");
    expect(link.searchParams.get("v")).toBe("2");
    expect(link.searchParams.get("p")).toBe(String(gateway.lanPort));
    expect(link.searchParams.get("fp")).toBe(pairing.ca_fingerprint);
    expect(link.searchParams.get("c")).toBe(pairing.code.replace(/-/g, ""));
    expect(link.searchParams.get("h")).toBe("test.local");
    const paired = await fetch(https + "/v2/pair", {
      method: "POST", tls: { ca }, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code.toLowerCase(), device_name: `手机${index}` }),
    });
    expect(paired.status).toBe(200);
    const result = await paired.json() as { device_id: string; device_token: string; member: { id: string }; household: { id: string } };
    tokens.push(result);
    expect(result.member.id).toBe(memberId);
    expect(result.household.id).toBe(host.householdId);
    expect(resolveDeviceToken(host.store.db, clock, result.device_token)).toMatchObject({ memberId, deviceId: result.device_id });
    const retry = await fetch(https + "/v2/pair", {
      method: "POST", tls: { ca }, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, device_name: "重复" }),
    });
    expect(retry.status).toBe(401);
    expect(await retry.json()).toEqual({ error: { code: "pairing_code_invalid" } });
  }
  const listed = await fetch(http + "/host/devices", { headers: adminHeaders });
  expect(await listed.json()).toMatchObject({ devices: members.map((member_id) => ({ member_id })) });
  const events = new ChatEvents(host);
  events.append({ streamId: "turn", kind: "done", data: {}, terminal: true });
  const stream = await fetch(https + "/v2/streams/turn/events", {
    tls: { ca }, headers: { Authorization: `Bearer ${tokens[0]!.device_token}` },
  });
  expect(await stream.text()).toContain("event: done");
  const unpaired = await fetch(https + "/v2/device/unpair", {
    method: "POST", tls: { ca }, headers: { Authorization: `Bearer ${tokens[0]!.device_token}` },
  });
  expect(await unpaired.json()).toEqual({ ok: true });
  const revoked = await fetch(http + `/host/devices/${tokens[1]!.device_id}`, { method: "DELETE", headers: adminHeaders });
  expect(await revoked.json()).toEqual({ ok: true });
  for (const token of tokens) {
    const response = await fetch(https + "/v2/me", { tls: { ca }, headers: { Authorization: `Bearer ${token.device_token}` } });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
  expect(await (await fetch(http + "/host/devices", { headers: adminHeaders })).json()).toEqual({ devices: [] });
  const failures = host.store.db.select().from(pairingCodes).all().map((row) => row.failures);
  const malformed = await fetch(https + "/v2/pair", {
    method: "POST", tls: { ca }, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "IIIIIIII", device_name: "坏格式" }),
  });
  expect(malformed.status).toBe(400);
  await malformed.body?.cancel();
  expect(host.store.db.select().from(pairingCodes).all().map((row) => row.failures)).toEqual(failures);
  await expect(fetch(https + "/v2/healthz", { tls: { ca: (await setup()).ca } })).rejects.toThrow();
});

function peerCertificate(port: number, ca: string): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => {
      const cert = new X509Certificate(socket.getPeerCertificate().raw);
      socket.destroy();
      resolve(cert);
    });
    socket.setTimeout(2000, () => socket.destroy(new Error("TLS 握手超时")));
    socket.on("error", reject);
  });
}

test("定时检查 IP 变化后重绑定 HTTPS，新 SAN 生效、原 SSE 持续接收且 CA 不变", async () => {
  let ips = ["192.0.2.1"];
  const { gateway, ca, https, host, clock, directory } = await setup({
    tlsRefreshIntervalMs: 10, tls: { ips: () => ips, hostname: "test" },
  });
  const port = gateway.lanPort!;
  const first = await peerCertificate(port, ca);
  expect(first.checkIP("192.0.2.1")).toBe("192.0.2.1");
  const memberId = createMember(host.store.db, clock, {
    householdId: host.householdId, homeHostId: host.hostId, displayName: "甲",
  });
  const { token } = createDevice(host.store.db, clock, { memberId, hostId: host.hostId, name: "手机" });
  const events = new ChatEvents(host);
  events.append({ streamId: "live", kind: "delta", data: "before" });
  const stream = await fetch(https + "/v2/streams/live/events", {
    tls: { ca }, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  expect(text).toContain(": connected");
  ips = ["192.0.2.2"];
  let changed = false;
  for (let i = 0; i < 100; i += 1) {
    const current = await peerCertificate(port, ca).catch(() => undefined);
    if (!current) {
      await Bun.sleep(5);
      continue;
    }
    if (current.fingerprint256 !== first.fingerprint256) {
      expect(current.checkIP("192.0.2.2")).toBe("192.0.2.2");
      changed = true;
      break;
    }
    await Bun.sleep(5);
  }
  expect(changed).toBe(true);
  expect(gateway.lanPort).toBe(port);
  expect(readFileSync(join(directory, "tls/ca.crt"), "utf8")).toBe(ca);
  events.append({ streamId: "live", kind: "delta", data: "after" });
  events.append({ streamId: "live", kind: "done", data: {}, terminal: true });
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value);
  }
  expect(text).toContain('data: "after"');
  expect(text).toContain("event: done");
  const health = await fetch(https + "/v2/healthz", { tls: { ca } });
  expect(await health.json()).toMatchObject({ ok: true });
});

test("重绑定失败短重试并上报，回环继续服务，后续检查恢复同一端口", async () => {
  let ips = ["192.0.2.1"];
  const errors: string[] = [];
  const { gateway, ca, http, https } = await setup({
    tlsRefreshIntervalMs: 10, tls: { ips: () => ips, hostname: "test" },
  }, (_error, source) => { errors.push(source); });
  const port = gateway.lanPort!;
  let fail = true;
  const original = Bun.serve;
  const mock = spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
    if (options.tls && fail) {
      throw new Error("模拟端口暂不可用");
    }
    return original(options);
  }) as typeof Bun.serve);
  try {
    ips = ["192.0.2.2"];
    for (let i = 0; i < 100 && errors.length < 4; i += 1) {
      await Bun.sleep(5);
    }
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.every((source) => source === "gateway:tls")).toBe(true);
    expect(gateway.lanPort).toBeUndefined();
    expect(await (await fetch(http + "/v2/healthz")).json()).toMatchObject({ ok: true });
    fail = false;
    for (let i = 0; i < 100 && gateway.lanPort === undefined; i += 1) {
      await Bun.sleep(5);
    }
    expect(gateway.lanPort).toBe(port);
    expect((await peerCertificate(port, ca)).checkIP("192.0.2.2")).toBe("192.0.2.2");
    expect(await (await fetch(https + "/v2/healthz", { tls: { ca } })).json()).toMatchObject({ ok: true });
  } finally {
    mock.mockRestore();
  }
});

test("关闭 LAN 仍可回环管理，HTTP 监听不得改为非回环地址", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-no-lan-"));
  directories.push(directory);
  const gateway = new Gateway();
  const host = await startHost({ dataDir: directory, port: 0, lanHttpsPort: 0 }, [gateway]);
  hosts.push(host);
  expect(gateway.lanPort).toBeUndefined();
  const admin = readFileSync(join(directory, "host-admin.token"), "utf8");
  const response = await fetch(`http://127.0.0.1:${gateway.port}/host/status`, { headers: { Authorization: `Bearer ${admin}` } });
  expect(await response.json()).toMatchObject({ lan: { enabled: false, port: 0 } });
  await expect(startHost({ dataDir: directory, hostname: "0.0.0.0", port: 0 }, [new Gateway()]))
    .rejects.toThrow("回环地址");
});
