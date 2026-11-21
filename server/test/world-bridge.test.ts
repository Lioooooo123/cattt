import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, messages, turns, users } from '../src/db/schema.ts';
import { worldActions, worldSessions } from '../src/db/schema-world.ts';
import { acknowledge, cancelRequestedActions, getActionStatus, getWorldState, moveCat, pollCommands, putState, registerSession } from '../src/world/service.ts';
import { snapshotSchema, type WorldSnapshot } from '../src/world/protocol.ts';
import { DEFAULT_TRAITS } from '../src/runtime/persona.ts';
import { catTools } from '../src/runtime/tools.ts';
const ids: string[] = [];
async function fixture() {
  const [user] = await db.insert(users).values({ name: 'world-test' }).returning(); ids.push(user!.id);
  const [cat] = await db.insert(cats).values({ userId: user!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: DEFAULT_TRAITS }).returning();
  const [conv] = await db.insert(conversations).values({ catId: cat!.id }).returning();
  const [message] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: '去池塘', clientMessageId: randomUUID() }).returning();
  const [turn] = await db.insert(turns).values({ conversationId: conv!.id, userMessageId: message!.id, inputVersion: 0, status: 'generating' }).returning();
  const session = await registerSession(cat!.id);
  // 院子里的事实用默认值补齐（老版本 App 也是这样上报的）。
  const snapshot: WorldSnapshot = snapshotSchema.parse({ stateVersion: 1, sceneVersion: 4, destinationIds: ['tree', 'pond'], currentDestinationId: 'tree', targetDestinationId: 'tree', phase: 'idle', action: 'nestLook', paused: false, runnable: true });
  await putState(cat!.id, session.sessionId, session.generation, snapshot);
  await pollCommands(cat!.id, session.sessionId, session.generation);
  const input = { catId: cat!.id, turnId: turn!.id, userMessageId: message!.id, destinationId: 'pond', stateVersion: 1, sessionId: session.sessionId, generation: session.generation };
  return { input, snapshot };
}
afterAll(async () => { for (const id of ids) await db.delete(users).where(eq(users.id, id)); await sql.end(); });
describe('世界动作真实 PG 状态机', () => {
  it.each(['sit_together', 'move_cat'])('%s 未获接收确认时明确说明目的地不是当前位置', async name => {
    const { input, snapshot } = await fixture();
    await putState(input.catId, input.sessionId, input.generation, { ...snapshot, stateVersion: 2, companionSeat: 'pond' });
    const tools = await catTools({ catId: input.catId, turnId: input.turnId, userMessageId: input.userMessageId });
    const result = await tools[name]!.execute(name === 'sit_together' ? {} : { ...input, stateVersion: 2 }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'accept_unknown', retryable: false }, data: {
      status: 'requested', destinationId: 'pond', fact: '院子尚未确认接收这次动作，是否开始移动未知，没有到达或坐稳凭证。目的地只是请求目标，不是当前位置。',
    } });
    expect(await getWorldState(input.catId)).toMatchObject({ currentDestinationId: 'tree' });
  });
  it('动作被拒绝时明确说明未完成，到达成功不带失败事实', async () => {
    const { input } = await fixture();
    const action = await moveCat(input);
    const tools = await catTools(input);
    await db.update(worldActions).set({ status: 'rejected' }).where(eq(worldActions.id, action.id));
    const failed = await tools.move_cat!.execute(input, new AbortController().signal);
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'action_rejected' }, data: {
      status: 'rejected', fact: '这次动作未成功完成，没有到达或坐稳凭证。目的地只是请求目标，不是当前位置。',
    } });
    const other = await fixture();
    const arrived = await moveCat(other.input);
    await acknowledge(other.input.catId, arrived.id, other.input.sessionId, other.input.generation, 'accepted', other.snapshot);
    await acknowledge(other.input.catId, arrived.id, other.input.sessionId, other.input.generation, 'arrived', { ...other.snapshot, stateVersion: 2, currentDestinationId: 'pond', targetDestinationId: 'pond' });
    const success = await (await catTools(other.input)).move_cat!.execute(other.input, new AbortController().signal);
    expect(success).toMatchObject({ status: 'succeeded', data: { status: 'arrived' } });
    expect(success.data).not.toHaveProperty('fact');
  });
  it('陪坐只采用设备给出的座位，并要真实坐稳才记到达', async () => {
    const { input, snapshot } = await fixture();
    const command = { ...input, activity: 'sit' as const };
    await expect(moveCat(command)).rejects.toMatchObject({ code: 'seat_unavailable' });
    const ready = snapshotSchema.parse({ ...snapshot, stateVersion: 2, companionSeat: 'tree' });
    await putState(input.catId, input.sessionId, input.generation, ready);
    await expect(moveCat({ ...command, stateVersion: 2 })).rejects.toMatchObject({ code: 'seat_unavailable' });
    const action = await moveCat({ ...command, destinationId: 'tree', stateVersion: 2 });
    expect(action.activity).toBe('sit');
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'accepted', ready);
    const seated = { ...ready, stateVersion: 3, activity: 'sit' as const, activityFallback: false };
    await expect(acknowledge(input.catId, action.id, input.sessionId, input.generation, 'arrived', { ...seated, action: 'sit_down' })).rejects.toMatchObject({ code: 'arrival_not_observed' });
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'arrived', { ...seated, action: 'sit_idle' });
  });
  it('协议地点与 App 实际加载的 scene.json 一致', () => {
    const scene = JSON.parse(readFileSync(new URL('../../ios/Maomao/Assets.xcassets/world-scene-v4.dataset/data.json', import.meta.url), 'utf8'));
    expect(snapshotSchema.safeParse({stateVersion: 0, sceneVersion: scene.version, destinationIds: scene.destinations.map((d: {id: string}) => d.id), currentDestinationId: 'house', targetDestinationId: 'house', phase: 'idle', action: 'idle', paused: false, runnable: true}).success).toBe(true);
  });
  it('发送重复与重新回复只有一个动作，到达之前不能算 arrived', async () => {
    const { input, snapshot } = await fixture();
    const [a,b] = await Promise.all([moveCat(input), moveCat(input)]); expect(a.id).toBe(b.id);
    await acknowledge(input.catId, a.id, input.sessionId, input.generation, 'accepted', snapshot);
    expect((await getActionStatus(input.catId, a.id)).status).toBe('accepted');
    await expect(acknowledge(input.catId, a.id, input.sessionId, input.generation, 'arrived', snapshot)).rejects.toMatchObject({ code: 'arrival_not_observed' });
    const arrived = { ...snapshot, stateVersion: 2, currentDestinationId: 'pond' as const, targetDestinationId: 'pond' as const };
    await acknowledge(input.catId, a.id, input.sessionId, input.generation, 'arrived', arrived);
    await expect(acknowledge(input.catId, a.id, input.sessionId, input.generation, 'running', arrived)).rejects.toMatchObject({ code: 'invalid_transition' });
    const [original] = await db.select().from(turns).where(eq(turns.id, input.turnId));
    const [retry] = await db.insert(turns).values({ conversationId: original!.conversationId, userMessageId: input.userMessageId, inputVersion: 0, status: 'generating' }).returning();
    expect((await moveCat({ ...input, turnId: retry!.id })).id).toBe(a.id);
    expect((await db.select().from(worldActions).where(eq(worldActions.catId, input.catId)))).toHaveLength(1);
  });
  it('断线后历史 running 和 arrived 回执保留事实，但不回退较新的世界观察', async () => {
    const { input, snapshot } = await fixture(); const action = await moveCat(input);
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'accepted', snapshot);
    const running = { ...snapshot, stateVersion: 2, targetDestinationId: 'pond' as const, phase: 'moving' as const };
    const arrived = { ...snapshot, stateVersion: 3, currentDestinationId: 'pond' as const, targetDestinationId: 'pond' as const };
    const latest = { ...snapshot, stateVersion: 4 };
    await putState(input.catId, input.sessionId, input.generation, latest);
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'running', running);
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'arrived', arrived);
    expect((await getActionStatus(input.catId, action.id)).status).toBe('arrived');
    const [session] = await db.select().from(worldSessions).where(eq(worldSessions.catId, input.catId));
    expect(session!.snapshot).toEqual(latest);
  });
  it('accepted 响应丢失后原请求重试恢复已接收事实，世界变化后可以正确中断', async () => {
    const { input, snapshot } = await fixture(); const action = await moveCat(input);
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'accepted', snapshot);
    const latest = { ...snapshot, stateVersion: 2, action: 'idle' };
    await putState(input.catId, input.sessionId, input.generation, latest);
    expect((await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'accepted', snapshot)).status).toBe('accepted');
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'interrupted', latest, 'world_changed');
    expect((await getActionStatus(input.catId, action.id)).status).toBe('interrupted');
  });
  it('执行超时后可补到期前到达证据，到期后的事件不能伪装及时到达', async () => {
    const { input, snapshot } = await fixture(); const action = await moveCat(input);
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'accepted', snapshot);
    const occurredAt = new Date(action.requestedAt.getTime() + 1);
    await db.update(worldActions).set({ requestedAt: new Date(action.requestedAt.getTime() - 10_000), finishBefore: new Date(action.requestedAt.getTime() - 1) }).where(eq(worldActions.id, action.id));
    const arrived = { ...snapshot, stateVersion: 2, currentDestinationId: 'pond' as const, targetDestinationId: 'pond' as const };
    expect((await getActionStatus(input.catId, action.id)).status).toBe('expired');
    await expect(acknowledge(input.catId, action.id, input.sessionId, input.generation, 'arrived', arrived, undefined, occurredAt)).rejects.toMatchObject({ code: 'invalid_transition' });
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'arrived', arrived, undefined, new Date(action.requestedAt.getTime() - 2));
    expect((await getActionStatus(input.catId, action.id)).status).toBe('arrived');
  });
  it('暂停中断动作，新session不能让旧回执覆盖观察', async () => {
    const { input, snapshot } = await fixture(); const action = await moveCat(input);
    await acknowledge(input.catId, action.id, input.sessionId, input.generation, 'accepted', snapshot);
    await putState(input.catId, input.sessionId, input.generation, { ...snapshot, stateVersion: 2, paused: true, runnable: false });
    expect((await getActionStatus(input.catId, action.id)).status).toBe('interrupted');
    await registerSession(input.catId);
    await expect(putState(input.catId, input.sessionId, input.generation, snapshot)).rejects.toMatchObject({ code: 'session_replaced' });
  });
  it('取消未接收动作；已接收的动作不伪装回滚', async () => {
    const a = await fixture(); const pending = await moveCat(a.input); await cancelRequestedActions(a.input.turnId);
    expect((await getActionStatus(a.input.catId, pending.id)).status).toBe('interrupted');
    const b = await fixture(); const accepted = await moveCat(b.input);
    await acknowledge(b.input.catId, accepted.id, b.input.sessionId, b.input.generation, 'accepted', b.snapshot);
    await cancelRequestedActions(b.input.turnId);
    expect((await getActionStatus(b.input.catId, accepted.id)).status).toBe('accepted');
  });
  it('过期/旧观察/未知地点都不能发动作，缺失世界保持未知', async () => {
    const { input, snapshot } = await fixture();
    await expect(moveCat({ ...input, stateVersion: 0 })).rejects.toMatchObject({ code: 'stale_state' });
    await expect(moveCat({ ...input, destinationId: 'moon' })).rejects.toMatchObject({ code: 'unsupported_destination' });
    await db.update(worldSessions).set({ observedAt: new Date(0) }).where(eq(worldSessions.catId, input.catId));
    expect((await getWorldState(input.catId)).available).toBe(false);
    await expect(moveCat(input)).rejects.toMatchObject({ code: 'world_stale' });
    expect((await getWorldState(randomUUID())).available).toBe(false);
    expect(snapshotSchema.safeParse({ ...snapshot, sceneVersion: 3 }).success).toBe(false);
  });
});
