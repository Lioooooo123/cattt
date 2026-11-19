import { recordInferenceSource } from '../agent/inference.ts';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, dbNow, type Tx } from '../db/client.ts';
import { cats, conversations, messages, turns } from '../db/schema.ts';
import { publish, requestCancel } from './events.ts';
import { startTurn } from './run.ts';
import { readableDiary } from '../diary/service.ts';
import { MemoryControlError } from '../memory/control.ts';

export type Owner = { userId: string; catId: string; conversationId: string };

export async function loadOwner(userId: string): Promise<Owner | null> {
  const [row] = await db
    .select({ catId: cats.id, conversationId: conversations.id })
    .from(cats)
    .innerJoin(conversations, eq(conversations.catId, cats.id))
    .where(eq(cats.userId, userId));
  return row ? { userId, ...row } : null;
}

/**
 * 用户发一条消息：同一个事务里存消息、version +1、建一轮回复。
 * client_message_id 重复（发送失败重试）时不新建，返回已有的那一轮。
 */
export async function createSendTurn(
  owner: Owner,
  clientMessageId: string,
  text: string,
  diaryEntryId?: string,
): Promise<{ turnId: string; userMessageId: string; created: boolean }> {
  const result = await db.transaction(async (tx) => {
    const [cat] = await tx.select().from(cats).where(eq(cats.id, owner.catId)).for('update');
    await tx.select().from(conversations).where(eq(conversations.id, owner.conversationId)).for('update');
    if (diaryEntryId && !await readableDiary(owner.catId, diaryEntryId, tx)) throw new MemoryControlError(404, '这条日记未开放给团子');
    const [inserted] = await tx
      .insert(messages)
      .values({ conversationId: owner.conversationId, role: 'user', text, clientMessageId, diaryEntryId, memoryEligible: cat!.learnMemories })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    if (!inserted) {
      const [existing] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, owner.conversationId), eq(messages.clientMessageId, clientMessageId)));
      const [turn] = await tx
        .select({ id: turns.id })
        .from(turns)
        .where(eq(turns.userMessageId, existing!.id))
        .orderBy(desc(turns.createdAt))
        .limit(1);
      return { turnId: turn!.id, userMessageId: existing!.id, created: false, cancelled: [] as string[] };
    }

    await recordInferenceSource(owner.catId,inserted.id,{},tx);
    const [conv] = await tx
      .update(conversations)
      .set({ version: sql`${conversations.version} + 1` })
      .where(eq(conversations.id, owner.conversationId))
      .returning({ version: conversations.version });
    const [turn] = await tx
      .insert(turns)
      .values({ conversationId: owner.conversationId, userMessageId: inserted.id, inputVersion: conv!.version })
      .returning({ id: turns.id });
    return { turnId: turn!.id, userMessageId: inserted.id, created: true, cancelled: await cancelPending(tx, owner.conversationId, turn!.id) };
  });

  if (result.created) await launch(result.turnId, result.userMessageId, result.cancelled);
  return result;
}

/** 对已有的用户消息重新回复（超时后「再试一次」）。不新增用户消息，所以 version 不变。 */
export async function createReplyTurn(owner: Owner, userMessageId: string, requestId?: string): Promise<{ turnId: string } | null> {
  const result = await db.transaction(async (tx) => {
    await tx.select().from(conversations).where(eq(conversations.id, owner.conversationId)).for('update');
    const [msg] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, userMessageId),
          eq(messages.conversationId, owner.conversationId),
          eq(messages.role, 'user'),
          eq(messages.contextAllowed, true),
        ),
      );
    if (!msg) return null;
    // 客户端在发送前保存 UUID；回执丢失后的同一次重试仍返回原 turn。
    if (requestId) {
      const [existing] = await tx.select().from(turns).where(eq(turns.id, requestId));
      if (existing) {
        if (existing.conversationId !== owner.conversationId || existing.userMessageId !== userMessageId) return null;
        return { turnId: existing.id, created: false, cancelled: [] as string[] };
      }
    }
    const [conv] = await tx
      .select({ version: conversations.version })
      .from(conversations)
      .where(eq(conversations.id, owner.conversationId));
    const [turn] = await tx
      .insert(turns)
      .values({ id: requestId, conversationId: owner.conversationId, userMessageId, inputVersion: conv!.version })
      .onConflictDoNothing()
      .returning({ id: turns.id });
    if (!turn) return null;
    return { turnId: turn.id, created: true, cancelled: await cancelPending(tx, owner.conversationId, turn.id) };
  });
  if (!result) return null;
  if (result.created) await launch(result.turnId, userMessageId, result.cancelled);
  return { turnId: result.turnId };
}

async function cancelPending(tx: Tx, conversationId: string, except: string): Promise<string[]> {
  const rows = await tx.update(turns).set({ status: 'superseded', finishedAt: dbNow() }).where(and(
    eq(turns.conversationId, conversationId), inArray(turns.status, ['queued', 'generating']),
    isNull(turns.firstTokenAt), ne(turns.id, except),
  )).returning({ id: turns.id });
  return rows.map(row => row.id);
}

async function launch(turnId: string, userMessageId: string, cancelled: string[]) {
  // 输入已落库，即使 PG 发布失败也启动执行/失败收尾，不留无人认领的 queued。
  try {
    await publish(turnId, { event: 'accepted', data: { turn_id: turnId, user_message_id: userMessageId } });
    for (const id of cancelled) {
      await requestCancel(id, 'supersede').catch(() => {});
      await publish(id, { event: 'superseded', data: { turn_id: id } }).catch(() => {});
    }
  } catch (error) { console.error(`[turn ${turnId}] accepted 投递失败`, error); }
  finally { startTurn(turnId); }
}
