import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db, dbNow } from './db/client.ts';
import { cats, conversations, pairedDevices, pairingCodes, users } from './db/schema.ts';
import { hashToken } from './auth-token.ts';
import { config } from './config.ts';
import { lanHosts, type LanIdentity } from './lan-tls.ts';
import { DEFAULT_TRAITS } from './runtime/persona.ts';
import { accountJSON } from './identity/service.ts';
import type { Env } from './api/auth.ts';

const active = () => and(isNull(pairingCodes.usedAt), isNull(pairingCodes.burnedAt), gt(pairingCodes.expiresAt, dbNow()));
const normalize = (code: string) => code.replace(/-/g, '').toUpperCase();
export async function issuePairingCode(identity: LanIdentity) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const code = [...randomBytes(8)].map(n => alphabet[n & 31]).join('');
  const expiresAt = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(8788001)`);
    let [owner] = await tx.select().from(users).where(eq(users.hostOwner, true));
    if (!owner) {
      [owner] = await tx.insert(users).values({ name: '主人', hostOwner: true }).returning();
      const [cat] = await tx.insert(cats).values({ userId: owner!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: DEFAULT_TRAITS }).returning();
      await tx.insert(conversations).values({ catId: cat!.id });
    }
    const [row] = await tx.insert(pairingCodes).values({ codeHash: hashToken(code), expiresAt: sql`now() + interval '10 minutes'` }).returning();
    return row!.expiresAt;
  });
  const hosts = lanHosts();
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expiresAt, hosts, port: config.LAN_HTTPS_PORT,
    ca_fingerprint: identity.fingerprint, ca_fingerprint_short: identity.fingerprintShort,
    pair_url: `maomao://pair?v=1&h=${hosts.join(',')}&p=${config.LAN_HTTPS_PORT}&c=${code}&fp=${identity.fingerprint}` };
}
export const pairingRoutes = new Hono();
pairingRoutes.post('/pair', async c => {
  const body = z.object({ code: z.string().min(1).max(64), device_name: z.string().trim().min(1).max(100) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: { code: 'bad_request' } }, 400);
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(8788001)`);
    const [code] = await tx.update(pairingCodes).set({ usedAt: dbNow() }).where(and(active(), eq(pairingCodes.codeHash, hashToken(normalize(body.data.code))))).returning();
    if (!code) {
      await tx.update(pairingCodes).set({ failedAttempts: sql`${pairingCodes.failedAttempts} + 1`, burnedAt: sql`case when ${pairingCodes.failedAttempts} >= 4 then now() else null end` }).where(active());
      return null;
    }
    const [owner] = await tx.select().from(users).where(eq(users.hostOwner, true));
    if (!owner) throw new Error('缺少宿主主人账号');
    const token = `mm_dvc_${randomBytes(32).toString('base64url')}`;
    const [device] = await tx.insert(pairedDevices).values({ userId: owner.id, name: body.data.device_name, tokenHash: hashToken(token) }).returning();
    const [cat] = await tx.select().from(cats).where(eq(cats.userId, owner.id));
    return { device_id: device!.id, device_token: token, account_id: owner.id, cat: accountJSON(cat!) };
  });
  return result ? c.json(result) : c.json({ error: { code: 'pairing_code_invalid' } }, 401);
});
export function hostRoutes(identity: LanIdentity) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const given = Buffer.from(hashToken(token));
    const expected = Buffer.from(hashToken(identity.adminToken));
    if (!timingSafeEqual(given, expected)) return c.json({ error: { code: 'unauthorized' } }, 401);
    await next();
  });
  const devices = () => db.select({ id: pairedDevices.id, name: pairedDevices.name, created_at: pairedDevices.createdAt, last_seen_at: pairedDevices.lastSeenAt }).from(pairedDevices).where(isNull(pairedDevices.revokedAt));
  app.post('/pairing-codes', async c => c.json(await issuePairingCode(identity)));
  app.get('/devices', async c => c.json({ devices: await devices() }));
  app.delete('/devices/:id', async c => {
    if (!z.uuid().safeParse(c.req.param('id')).success) return c.json({ error: { code: 'bad_request' } }, 400);
    await db.update(pairedDevices).set({ revokedAt: dbNow() }).where(eq(pairedDevices.id, c.req.param('id')));
    return c.json({ ok: true });
  });
  app.get('/status', async c => c.json({ lan: { enabled: config.LAN_HTTPS_PORT !== 0, hosts: lanHosts(), port: config.LAN_HTTPS_PORT }, ca_fingerprint: identity.fingerprint, ca_fingerprint_short: identity.fingerprintShort, devices: await devices() }));
  return app;
}
export const unpairRoutes = new Hono<Env>();
unpairRoutes.post('/device/unpair', async c => {
  const token = c.req.header('authorization')!.slice(7).trim();
  if (!token.startsWith('mm_dvc_')) return c.json({ error: { code: 'unauthorized' } }, 401);
  await db.update(pairedDevices).set({ revokedAt: dbNow() }).where(and(eq(pairedDevices.tokenHash, hashToken(token)), eq(pairedDevices.userId, c.get('owner').userId)));
  return c.json({ ok: true });
});
