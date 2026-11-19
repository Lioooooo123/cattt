import { createIdentityRoutes, revokeSession, accountJSON } from '../identity/service.ts';
import { deviceRoutes } from '../push/routes.ts';
import { db } from '../db/client.ts';
import { cats } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { ticketRoutes } from './tickets.ts';
import { Hono } from 'hono';
import { sql } from '../db/client.ts';
import { auth, type Env } from './auth.ts';
import { catRoutes } from './cat.ts';
import { chatRoutes } from './chat.ts';
import { memoriesRoutes } from './memories.ts';
import { boundariesRoutes } from './boundaries.ts';
import { soulRoutes } from './soul.ts';
import { worldRoutes } from '../world/routes.ts';
import { diaryRoutes } from './diary.ts';
import { meRoutes } from './me.ts';
import { hostRoutes, pairingRoutes, unpairRoutes } from '../pairing.ts';
import type { LanIdentity } from '../lan-tls.ts';

export function createApp(identityOptions?:Parameters<typeof createIdentityRoutes>[0], hostIdentity?: LanIdentity) {
const app = new Hono();
if (hostIdentity) app.route('/host', hostRoutes(hostIdentity));
app.route('/', pairingRoutes);
app.get('/healthz', async (c) => {
  const dbOk = await sql`select 1`.then(() => true).catch(() => false);
  return c.json({ release: 'phase5', ok: dbOk, db: dbOk }, dbOk ? 200 : 503);
});
app.route('/auth',createIdentityRoutes(identityOptions));
const v1 = new Hono<Env>();
v1.use('*', auth);
v1.route('/', unpairRoutes);
v1.route('/',deviceRoutes);
v1.post('/session/logout',async c=>{await revokeSession(c.req.header('authorization')!.slice(7));return c.json({ok:true});});
v1.get('/me',async c=>{const [cat]=await db.select().from(cats).where(eq(cats.id,c.get('owner').catId));return c.json({account_id:c.get('owner').userId,cat:accountJSON(cat!)});});
v1.route('/', catRoutes);
v1.route('/', meRoutes);
v1.route('/', ticketRoutes);
v1.route('/', diaryRoutes);
v1.route('/', chatRoutes);
v1.route('/', memoriesRoutes);
v1.route('/', boundariesRoutes);
v1.route('/cat', soulRoutes);
v1.route('/world', worldRoutes);
app.route('/v1', v1);
app.onError((error, c) => {
  console.error('[api]', error);
  return c.json({ error: { code: 'internal_error', message: '服务端出错了' } }, 500);
});

return app;
}
export const app=createApp();
