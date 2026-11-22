import "reflect-metadata";
import { afterEach, expect, test } from "bun:test";
import { request } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway/index.ts";
import { requestPeerHttps } from "../src/peer/https.ts";
import { initializePeerIdentity } from "../src/identity/peer-tls.ts";
import type { PeerDescriptor, PeerHello, PeerProtocol } from "../src/peer/protocol.ts";
import { startHost } from "../src/runtime/index.ts";
import { getHostMeta } from "../src/store/host-meta.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function host(name: string, peerProtocol?: PeerProtocol) {
  const dir = mkdtempSync(join(tmpdir(), "cattt-peer-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return launch(dir, name, peerProtocol);
}

async function launch(dir: string, name: string, peerProtocol?: PeerProtocol) {
  const gateway = new Gateway({
    lanPort: 0,
    tls: { ips: () => [], hostname: name },
    peerPort: 0,
    peerHostname: "127.0.0.1",
    peerProtocol,
    peerHandlers: {
      changes: (request, actor) => Response.json({ ...actor, range: request.headers.get("range") }),
      inbox: async (request, actor) => Response.json({ ...actor, payload: await request.json() }),
    },
  });
  const ctx = await startHost({ dataDir: dir, port: 0, householdName: name }, [gateway]);
  cleanups.push(ctx.stop);
  const token = readFileSync(join(dir, "host-admin.token"), "utf8");
  const admin = (path: string, method = "GET", body?: unknown, bearer = token) =>
    fetch(`http://127.0.0.1:${gateway.port}/host${path}`, {
      method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const descriptor = async (): Promise<PeerDescriptor> => {
    const response = await admin("/peer-identity");
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ctx, gateway, admin, descriptor, dir, token };
}

type TestHost = Awaited<ReturnType<typeof host>>;

function approved(identity: PeerDescriptor) {
  return { identity, confirmed_fingerprint: identity.fingerprint };
}

async function pair(authority: TestHost, joining: TestHost) {
  const a = await authority.descriptor();
  const b = await joining.descriptor();
  expect(a.host_id).not.toBe(b.host_id);
  expect(a.household_id).not.toBe(b.household_id);
  expect(a.fingerprint).not.toBe(b.fingerprint);
  const permit = await authority.admin(`/peers/${b.host_id}`, "PUT", { ...approved(b), allow_join: true });
  expect(permit.status, await permit.text()).toBe(200);
  const claimed = { host_id: b.host_id, household_id: a.household_id, protocol_version: b.protocol_version, fingerprint: b.fingerprint };
  expect((await rawPeer(a, "/peer/hello", {
    ...credential(joining), method: "POST", body: claimed,
  })).status).toBe(403);
  expect((await rawPeer(a, "/peer/changes", {
    ...credential(joining), headers: { "x-cattt-peer-version": String(b.protocol_version) },
  })).status).toBe(403);
  const connect = await joining.admin("/peers/connect", "POST", { ...approved(a), join_household: true });
  expect(connect.status, await connect.text()).toBe(200);
  return { a, b };
}

function rawPeer(
  endpoint: PeerDescriptor,
  path: string,
  options: { method?: string; body?: PeerHello; headers?: Record<string, string>; key?: string; cert?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: endpoint.address.host, port: endpoint.address.port, path, method: options.method ?? "GET",
      ca: endpoint.ca_certificate, servername: `${endpoint.host_id}.peer.cattt`,
      key: options.key, cert: options.cert, rejectUnauthorized: true, agent: false,
      signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", ...options.headers },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (part: string) => { body += part; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

function credential(host: TestHost) {
  return JSON.parse(readFileSync(join(host.dir, "peer-tls", "identity.json"), "utf8")) as { key: string; cert: string };
}

test("两个独立宿主由两端管理员确认，mTLS 固定叶证书，存储和撤销跨重启", async () => {
  const aHost = await host("甲");
  const bHost = await host("乙");
  const phone = issueTestDevice(aHost.ctx);
  const { a, b } = await pair(aHost, bHost);
  expect(bHost.ctx.householdId).toBe(a.household_id);
  expect((await bHost.descriptor()).household_id).toBe(a.household_id);
  expect(getHostMeta(bHost.ctx.store.db, "host_id")).toBe(b.host_id);
  expect((await bHost.admin("/members", "POST", { display_name: "伪造首成员" })).status).toBe(409);
  const read = await bHost.gateway.peerTransport!.request(a.host_id, "changes", { headers: { range: "bytes=0-99" } });
  expect(await read.json()).toEqual({
    hostId: b.host_id, householdId: a.household_id, fingerprint: b.fingerprint,
    protocolVersion: a.protocol_version, access: "read_write", range: "bytes=0-99",
  });
  const write = await aHost.gateway.peerTransport!.request(b.host_id, "inbox", { body: '{"id":1}' });
  expect(await write.json()).toMatchObject({ hostId: a.host_id, payload: { id: 1 } });
  const local = await initializePeerIdentity(bHost.dir, bHost.ctx.clock, b.host_id);
  await expect(requestPeerHttps(local.current(), {
    hostId: a.host_id, addressHost: a.address.host, addressPort: a.address.port,
    caCertificate: a.ca_certificate, fingerprint: b.fingerprint,
  }, "GET", "/peer/changes")).rejects.toThrow("指纹");
  const phoneResponse = await fetch(`https://127.0.0.1:${aHost.gateway.lanPort}/peer/changes`, {
    headers: { authorization: `Bearer ${phone.token}` },
    tls: { ca: readFileSync(join(aHost.dir, "tls/ca.crt"), "utf8") },
  });
  expect(phoneResponse.status).toBe(404);
  await expect(rawPeer(a, "/peer/changes", {
    headers: { authorization: `Bearer ${phone.token}`, "x-cattt-peer-fingerprint": b.fingerprint },
  })).rejects.toThrow();
  expect((await rawPeer(a, "/v2/me", { ...credential(bHost) })).status).toBe(404);
  expect((await rawPeer(a, "/host/peers", { ...credential(bHost), headers: { authorization: `Bearer ${aHost.token}` } })).status).toBe(404);
  const wrongClaims = {
    host_id: a.host_id, household_id: a.household_id, protocol_version: 1, fingerprint: b.fingerprint,
  };
  expect((await rawPeer(a, "/peer/hello", { ...credential(bHost), body: wrongClaims, method: "POST" })).status).toBe(403);
  expect((await rawPeer(a, "/peer/hello", {
    ...credential(bHost), method: "POST", body: { ...wrongClaims, host_id: b.host_id, household_id: b.household_id },
  })).status).toBe(403);
  expect((await rawPeer(a, "/peer/hello", {
    ...credential(bHost), method: "POST", body: { ...wrongClaims, host_id: b.host_id, fingerprint: a.fingerprint },
  })).status).toBe(403);
  expect((await aHost.admin(`/peers/${b.host_id}`, "DELETE")).status).toBe(200);
  await expect(rawPeer(a, "/peer/changes", { ...credential(bHost) })).rejects.toThrow();
  await expect(aHost.gateway.peerTransport!.request(b.host_id, "changes")).rejects.toThrow();
  await aHost.ctx.stop();
  const rerun = await launch(aHost.dir, "甲");
  const next = await rerun.descriptor();
  expect(next.fingerprint).toBe(a.fingerprint);
  expect((await (await rerun.admin("/peers")).json()).peers).toEqual([
    expect.objectContaining({ host_id: b.host_id, status: "revoked" }),
  ]);
  await expect(rawPeer(next, "/peer/changes", { ...credential(bHost) })).rejects.toThrow();
});

test("陌生宿主、未经确认的指纹与非空家庭无法加入", async () => {
  const aHost = await host("甲");
  const bHost = await host("乙");
  const a = await aHost.descriptor();
  const b = await bHost.descriptor();
  const path = `/peers/${b.host_id}`;
  expect((await aHost.admin(path, "PUT", approved(b), "bogus")).status).toBe(401);
  expect((await aHost.admin(path, "PUT", { ...approved(b), allow_join: true, confirmed_fingerprint: a.fingerprint })).status).toBe(400);
  expect((await aHost.admin(path, "PUT", { ...approved(b), allow_join: true, identity: { ...b, ca_certificate: b.certificate } })).status).toBe(400);
  expect((await aHost.admin(path, "PUT", approved(b))).status).toBe(409);
  const connect = { ...approved(a), join_household: true };
  expect((await bHost.admin("/peers/connect", "POST", connect)).status).toBe(502);
  expect(bHost.ctx.householdId).toBe(b.household_id);
  expect((await aHost.admin(path, "PUT", { ...approved(b), allow_join: true })).status).toBe(200);
  issueTestDevice(bHost.ctx);
  expect((await bHost.admin("/peers/connect", "POST", connect)).status).toBe(409);
  expect(bHost.ctx.householdId).toBe(b.household_id);
});

test("未知版本拒绝，明确兼容的不同版本只能读同步资源", async () => {
  const aHost = await host("甲", { version: 1, readOnlyVersions: [2] });
  const bHost = await host("乙", { version: 1, readOnlyVersions: [2] });
  const { a, b } = await pair(aHost, bHost);
  await bHost.ctx.stop();
  const upgraded = await launch(bHost.dir, "乙", { version: 2, readOnlyVersions: [1] });
  const nextB = await upgraded.descriptor();
  // Update the address without yet confirming the new version.
  expect((await aHost.admin(`/peers/${b.host_id}`, "PUT", approved(nextB))).status).toBe(200);
  await expect(aHost.gateway.peerTransport!.request(b.host_id, "changes")).rejects.toThrow("Peer");
  expect((await aHost.admin(`/peers/${b.host_id}`, "PUT", approved(nextB))).status).toBe(200);
  expect((await upgraded.admin("/peers/connect", "POST", approved(a))).status).toBe(200);
  const read = await upgraded.gateway.peerTransport!.request(a.host_id, "changes");
  expect(await read.json()).toMatchObject({ protocolVersion: 2, access: "read_only" });
  const typed = await upgraded.gateway.peerTransport!.request(a.host_id, "typedChanges", {
    query: { op: "snapshot", protocol_version: "1" },
  });
  expect(typed.status).toBe(200);
  expect(await typed.json()).toMatchObject({
    protocol_version: 1, source: { sourceHostId: a.host_id, householdId: a.household_id },
  });
  await expect(upgraded.gateway.peerTransport!.request(a.host_id, "inbox")).rejects.toThrow();
  await expect(upgraded.gateway.peerTransport!.request(a.host_id, "lease")).rejects.toThrow();
  expect((await rawPeer(a, "/peer/inbox", {
    ...credential(upgraded), method: "POST", headers: { "x-cattt-peer-version": "2" },
  })).status).toBe(403);
  expect((await rawPeer(a, "/peer/changes", {
    ...credential(upgraded), headers: { "x-cattt-peer-version": "99" },
  })).status).toBe(409);
  const hello = { host_id: b.host_id, household_id: a.household_id, protocol_version: 99, fingerprint: b.fingerprint };
  expect((await rawPeer(a, "/peer/hello", { ...credential(upgraded), method: "POST", body: hello })).status).toBe(409);
});


test("本机证书轮换后双方须重新确认，旧指纹无法继续访问", async () => {
  const aHost = await host("甲");
  const bHost = await host("乙");
  const { a, b } = await pair(aHost, bHost);
  const oldB = credential(bHost);
  const rotate = await bHost.admin("/peer-identity/rotate", "POST");
  expect(rotate.status).toBe(200);
  const nextB: PeerDescriptor = await rotate.json();
  expect(nextB.fingerprint).not.toBe(b.fingerprint);
  expect(nextB.host_id).toBe(b.host_id);
  expect(nextB.household_id).toBe(a.household_id);
  expect((await (await bHost.admin("/peers")).json()).peers[0]).toMatchObject({ status: "approved", access: null });
  await expect(bHost.gateway.peerTransport!.request(a.host_id, "changes")).rejects.toThrow();
  await expect(aHost.gateway.peerTransport!.request(b.host_id, "changes")).rejects.toThrow();
  expect((await aHost.admin(`/peers/${b.host_id}`, "PUT", approved(nextB))).status).toBe(200);
  expect((await bHost.admin("/peers/connect", "POST", approved(a))).status).toBe(200);
  await expect(rawPeer(a, "/peer/changes", oldB)).rejects.toThrow();
  expect((await bHost.gateway.peerTransport!.request(a.host_id, "changes")).ok).toBe(true);
});
