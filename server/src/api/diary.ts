import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { diaryEntries } from '../db/schema.ts';
import { config } from '../config.ts';
import type { Env } from './auth.ts';
import { bad } from './responses.ts';
import { DiaryConflict, diaryJSON, saveDiary } from '../diary/service.ts';
import { MemoryControlError } from '../memory/control.ts';

export const diaryRoutes = new Hono<Env>();
diaryRoutes.onError((error, c) => {
  if (error instanceof DiaryConflict) return c.json({ error: { code: 'diary_changed', message: '记录已在其他设备更新' }, entry: diaryJSON(error.current) }, 409);
  if (error instanceof MemoryControlError) return c.json({ error: { code: 'not_found', message: error.message } }, error.status);
  throw error;
});
const body = z.object({
  client_id: z.string().min(1).max(100), kind: z.enum(['text', 'cat']), text: z.string().trim().min(1).max(10000),
  recorded_at: z.iso.datetime({ offset: true }), time_zone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  day: z.iso.date(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), cat_allowed: z.boolean(),
  revision: z.number().int().min(0), mutation_id: z.uuid(),
}).strict().refine(r => {
  try {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: r.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(r.recorded_at));
  const value = (type: string) => parts.find(p => p.type === type)?.value;
  return r.day === `${value('year')}-${value('month')}-${value('day')}`;
  } catch { return false; }
}, { message: '日期与记录时间不一致' });
diaryRoutes.put('/diary', async c => {
  const epoch = c.req.header('x-cattt-diary-epoch');
  if (epoch !== undefined && config.CATTT_DIARY_SYNC_EPOCH !== undefined && epoch !== config.CATTT_DIARY_SYNC_EPOCH) {
    return c.json({ error: { code: 'diary_sync_reset' } }, 409);
  }
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(bad('日记格式不正确'), 400);
  const entry = await saveDiary(c.get('owner').catId, parsed.data);
  // 待办在同一PG事务中已保存，由常驻恢复扫描器投递，HTTP不等待PG。
  return c.json({ entry: diaryJSON(entry) });
});
diaryRoutes.get('/diary/changes', async c => {
  const query = z.object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    epoch: z.string().min(1).max(64).optional(),
  }).safeParse(c.req.query());
  if (!query.success) return c.json(bad('分页位置不正确'), 400);
  const { after, limit, epoch } = query.data;
  const currentEpoch = config.CATTT_DIARY_SYNC_EPOCH;
  if (epoch !== undefined && currentEpoch !== undefined && epoch !== currentEpoch) {
    return c.json({ entries: [], cursor: 0, has_more: false, epoch: currentEpoch, reset: true });
  }
  const rows = await db.select().from(diaryEntries)
    .where(and(eq(diaryEntries.catId, c.get('owner').catId), gt(diaryEntries.changeSeq, after)))
    .orderBy(asc(diaryEntries.changeSeq)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return c.json({ entries: page.map(diaryJSON), cursor: page.at(-1)?.changeSeq ?? after, has_more: rows.length > limit, epoch: currentEpoch });
});

diaryRoutes.get('/diary', async c => {
  const after = z.coerce.number().int().min(0).safeParse(c.req.query('after_seq') ?? 0);
  if (!after.success) return c.json(bad('分页位置不正确'), 400);
  const rows = await db.select().from(diaryEntries).where(and(eq(diaryEntries.catId, c.get('owner').catId), gt(diaryEntries.seq, after.data))).orderBy(asc(diaryEntries.seq)).limit(100);
  return c.json({ entries: rows.map(diaryJSON), next_seq: rows.length === 100 ? rows.at(-1)!.seq : null });
});
