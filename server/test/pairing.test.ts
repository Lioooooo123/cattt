import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { eq, sql as raw } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/api/app.ts';
import { db, sql } from '../src/db/client.ts';
import { pairedDevices, pairingCodes, users } from '../src/db/schema.ts';
import { hashToken } from '../src/auth-token.ts';
import { initializeLan, lanHosts, type LanIdentity } from '../src/lan-tls.ts';
import { redis } from '../src/redis.ts';

let dir: string;
let identity: LanIdentity;
let host: ReturnType<typeof createApp>;
const lan = createApp();
let originalOwner: string | undefined;
beforeAll(async () => {
  originalOwner = (await db.select().from(users).where(eq(users.hostOwner, true)))[0]?.id;
  dir = await mkdtemp(join(homedir(), '.cattt-pairing-test-'));
  identity = await initializeLan(dir);
  host = createApp(undefined, identity);
});
afterAll(async () => {
  await db.delete(pairingCodes);
  if (!originalOwner) await db.delete(users).where(eq(users.hostOwner, true));
  await rm(dir, { recursive: true });
  redis.disconnect();
  await sql.end();
});
const headers = () => ({ authorization: `Bearer ${identity.adminToken}` });
async function issue() {
  const response = await host.request('/host/pairing-codes', { method: 'POST', headers: headers() });
  expect(response.status).toBe(200);
  return await response.json() as { code: string; pair_url: string };
}
function pair(code: string, device_name = '测试手机') {
  return lan.request('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device_name }) });
}
function me(token: string) { return lan.request('/v1/me', { headers: { authorization: `Bearer ${token}` } }); }

it('宿主管理需要口令，局域网不挂载管理接口，空设备列表可读', async () => {
  expect((await host.request('/host/pairing-codes', { method: 'POST' })).status).toBe(401);
  expect((await host.request('/host/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  expect((await lan.request('/host/pairing-codes', { method: 'POST', headers: headers() })).status).toBe(404);
  expect((await host.request('/host/devices', { headers: headers() })).status).toBe(200);
});
it('配对成功、大小写与连字符归一，凭证可用，旧码不能重用', async () => {
  const issued = await issue();
  expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(issued.pair_url).toContain(`h=${lanHosts().join(',')}`);
  const response = await pair(issued.code.toLowerCase().replace('-', ''));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.device_token).toMatch(/^mm_dvc_/);
  expect((await me(result.device_token)).status).toBe(200);
  expect((await pair(issued.code)).status).toBe(401);
  const [device] = await db.select().from(pairedDevices).where(eq(pairedDevices.id, result.device_id));
  expect(device!.tokenHash).toBe(hashToken(result.device_token));
  expect(device!.lastSeenAt).not.toBeNull();
  expect(result.cat.name).toBe('团子');
});
it('新码不使旧码失效，并发兑换只成功一次', async () => {
  const first = await issue();
  await issue();
  const responses = await Promise.all([pair(first.code), pair(first.code)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
});
it('过期码拒绝，错误五次烧毁全部活跃码', async () => {
  const expired = await issue();
  await db.update(pairingCodes).set({ expiresAt: raw`now() - interval '1 second'` }).where(eq(pairingCodes.codeHash, hashToken(expired.code.replace('-', ''))));
  expect((await pair(expired.code)).status).toBe(401);
  const first = await issue();
  const second = await issue();
  for (let i = 0; i < 5; i++) expect((await pair('ZZZZZZZZ')).status).toBe(401);
  expect((await pair(first.code)).status).toBe(401);
  expect((await pair(second.code)).status).toBe(401);
});
it('格式错误返回 400，不消耗配对码', async () => {
  expect((await pair('', '')).status).toBe(400);
  expect((await lan.request('/pair', { method: 'POST', body: '{' })).status).toBe(400);
});
it('宿主撤销和手机解除配对都立即使 token 失效', async () => {
  const a = await (await pair((await issue()).code)).json();
  expect((await host.request(`/host/devices/${a.device_id}`, { method: 'DELETE', headers: headers() })).status).toBe(200);
  expect((await me(a.device_token)).status).toBe(401);
  const b = await (await pair((await issue()).code)).json();
  expect((await lan.request('/v1/device/unpair', { method: 'POST', headers: { authorization: `Bearer ${b.device_token}` } })).status).toBe(200);
  expect((await me(b.device_token)).status).toBe(401);
  const listed = await (await host.request('/host/devices', { headers: headers() })).json();
  expect(listed.devices.map((d: { id: string }) => d.id)).not.toContain(a.device_id);
  expect(listed.devices.map((d: { id: string }) => d.id)).not.toContain(b.device_id);
});
it('CA 指纹、SAN、EKU、期限、权限与重启稳定性符合约定', async () => {
  const ca = new X509Certificate(await readFile(join(dir, 'tls/ca.crt')));
  const leaf = new X509Certificate(await readFile(join(dir, 'tls/server.crt')));
  expect(ca.ca).toBe(true);
  expect(leaf.verify(ca.publicKey)).toBe(true);
  expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
  expect(leaf.checkHost('localhost')).toBe('localhost');
  expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
  for (const host of lanHosts()) expect(leaf.subjectAltName).toContain(host);
  expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBeLessThan(398 * 86400_000);
  expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  expect(identity.fingerprint).toBe(createHash('sha256').update(ca.raw).digest('hex'));
  expect(identity.fingerprintShort).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  for (const path of ['tls/ca.key', 'tls/server.key', 'host-admin.token']) expect((await stat(join(dir, path))).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await identity.refresh()).toBe(false);
  const again = await initializeLan(dir);
  expect(again.fingerprint).toBe(identity.fingerprint);
  expect(again.adminToken).toBe(identity.adminToken);
  expect(again.serverOptions()).toEqual(identity.serverOptions());
});
