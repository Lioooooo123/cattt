import { messageAllowed } from '../agent/gate.ts';
import { turnGuardSnapshot, turnPublicationChecks } from '../agent/publisher.ts';
import { extractSource } from '../worker/memory.ts';
import { memories, memoryReceipts, messages } from '../db/schema.ts';
import { lockMemory, MemoryControlError } from '../memory/control.ts';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, dbNow } from '../db/client.ts';
import { conversations, turns } from '../db/schema.ts';
import { runtimeCalls, runtimeSteps } from '../db/schema-runtime.ts';
import { buildTurnContext, type TurnContext } from '../runtime/context.ts';
import { chatSlot, classifyModelError, recordModelCall } from '../runtime/model.ts';
import { getSoul } from '../soul/service.ts';
import { runCatAgent } from '../runtime/agent.ts';
import { catTools } from '../runtime/tools.ts';
import { cancelRequestedActions } from '../world/service.ts';
import { authorizeFirstToken, claimTurn, commitOutcome } from './store.ts';
import {
  acquireConversationLock, type CancelReason, publish, readCancel, readVisibleLength,
  refreshConversationLock, releaseConversationLock, subscribeCancel,
} from './events.ts';

const running = new Set<Promise<void>>();
export function startTurn(turnId: string) {
  const p = runTurn(turnId).catch((error) => console.error(`[turn ${turnId}]`, error)).finally(() => running.delete(p));
  running.add(p);
}
export async function drainTurns(timeoutMs: number) {
  if (running.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled([...running]), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
}

async function runTurn(turnId: string) {
  const [turn] = await db.select().from(turns).where(eq(turns.id, turnId));
  if (!turn || turn.status !== 'queued') return;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, turn.conversationId));
  if (!conv) return;
  const beat = async () => {
    await db.update(turns).set({ heartbeatAt: dbNow() }).where(and(eq(turns.id, turnId), inArray(turns.status, ['queued', 'generating'])));
  };
  const lockToken = randomUUID();
  const abort = new AbortController();
  let cancelReason: CancelReason | null = null;
  let failureCode: string | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let cancelPoll: NodeJS.Timeout | undefined;
  let budget: NodeJS.Timeout | undefined;
  let text = '';
  let published = false;
  let acquired = false;
  let unsubscribeCancel: (() => void) | undefined;
  let lastLockRefresh = 0;
  const cancelled = (reason: CancelReason | null) => {
    if (!reason) return;
    if (cancelReason !== 'supersede') cancelReason = reason;
    abort.abort(new Error(cancelReason));
  };
  const stop = (code: string) => { failureCode ??= code; abort.abort(new Error(code)); };
  try {
    await beat();
    acquired = await acquireConversationLock(conv.id, lockToken, 60_000, beat);
    if (!acquired) { await fail(turnId, 'busy', 'waited 60s for conversation lock'); return; }
    lastLockRefresh = performance.now();
    if (!await claimTurn(turnId)) return;
    // 同一预算贯穿上下文、所有模型步骤与工具，不在每步重置。
    budget = setTimeout(() => stop('turn_timeout'), 45_000);
    heartbeat = setInterval(() => {
      void (async () => {
        if (!await refreshConversationLock(conv.id, lockToken)) { stop('lock_lost'); return; }
        lastLockRefresh = performance.now();
        await beat();
      })().catch(() => stop('lock_lost'));
    }, 5_000);
    unsubscribeCancel = await subscribeCancel(turnId, cancelled);
    cancelled(await readCancel(turnId));
    cancelPoll = setInterval(() => {
      void readCancel(turnId).then(cancelled).catch(() => stop('cancel_unavailable'));
    }, 2_000);

    const checks = turnPublicationChecks(conv.catId);
    const { boundaryStamp, revision, protection } = checks;
    const initialBoundaries = await boundaryStamp();
    let contextRevision: string | undefined;
    const guard = async () => {
      abort.signal.throwIfAborted();
      if (cancelReason) { abort.abort(new Error(cancelReason)); abort.signal.throwIfAborted(); }
      const current = await turnGuardSnapshot(conv.catId, turnId);
      if (!current || current.status !== 'generating') { stop('stale'); abort.signal.throwIfAborted(); }
      if (!published && current!.version > turn.inputVersion) {
        cancelReason = 'supersede'; abort.abort(new Error('supersede')); abort.signal.throwIfAborted();
      }
      if ((contextRevision !== undefined && current!.revision !== contextRevision) || current!.boundaryStamp !== initialBoundaries) { stop('context_changed'); abort.signal.throwIfAborted(); }
      if (performance.now() - lastLockRefresh > 2_000) {
        if (!await refreshConversationLock(conv.id, lockToken)) { stop('lock_lost'); abort.signal.throwIfAborted(); }
        lastLockRefresh = performance.now();
      }
    };
    await guard();
    // 明确记住/更正在回复前保存；成功后才允许说“记下了”。普通闲聊继续异步整理。
    const [input] = await db.select().from(messages).where(eq(messages.id, turn.userMessageId));
    if (!messageAllowed(input)) { await fail(turnId, 'source_withdrawn', '原话已停止使用', false); return; }
    let memoryNote = '没有本轮成功保存的凭证，不要说记下了或改好了。';
    if (input && /记住|记一下|记下来|更正|改成|说错|其实|不再|不是|以后.*记/.test(input.text)) {
      try { memoryNote = (await extractSource(conv.catId, input.id, turnId, undefined, abort.signal, true)).note; }
      catch { memoryNote = '本次保存未成功，明确告诉对方没有记好，可以稍后重试。'; }
    }
    await getSoul(conv.catId);
    const slot = chatSlot();
    // 新记忆到达允许在首字前重读；撤回、删除、开关或身份改变仍终止旧轮次。
    const initialProtection = await protection();
    let ctx: TurnContext | undefined;
    // 旧消息的异步提取可能恰好在上下文读取期间写入。尚未调用回复模型/工具、
    // 尚未发布任何字时，丢弃这份过期快照并有限重读；不复用旧许可或重跑提取。
    for (let attempt = 0; attempt < 3; attempt++) {
      await guard();
      if (!await checks.protectionUnchanged(initialProtection)) { await fail(turnId, 'context_changed', '来源或许可已变化', false); return; }
      const [source] = await db.select().from(messages).where(eq(messages.id, turn.userMessageId));
      if (!messageAllowed(source)) { await fail(turnId, 'source_withdrawn', '原话已停止使用', false); return; }
      const stamp = await revision();
      const next = await buildTurnContext(conv.catId, conv.id, turnId, abort.signal);
      if (!await checks.protectionUnchanged(initialProtection)) { await fail(turnId, 'context_changed', '来源或许可已变化', false); return; }
      if (!await checks.revisionUnchanged(stamp)) continue;
      let note = memoryNote;
      try {
        await db.transaction(async tx => {
          await lockMemory(tx, conv.catId, next.revision);
          if (/已经保存|成功保存/.test(note)) {
            const persisted = (await tx.select({ memory: memories }).from(memories).innerJoin(memoryReceipts, and(eq(memoryReceipts.catId, conv.catId), eq(memoryReceipts.fingerprint, memories.fingerprint), eq(memoryReceipts.sourceMessageId, turn.userMessageId), eq(memoryReceipts.accepted, true)))
              .where(and(eq(memories.catId, conv.catId), eq(memories.status, 'active')))).map(r => r.memory);
            note = persisted.length ? `本轮已经保存：${persisted.map(m => m.value).join('；')}` : '本轮没有有效的保存凭证，不要宣称记下了或改好了。';
          }
          await tx.update(turns).set({ memoryIds: next.memoryIds, contextSourceIds: next.sourceIds, contextRevision: next.revision, diarySourceIds: next.diarySourceIds, model: slot.modelId })
            .where(and(eq(turns.id, turnId), eq(turns.status, 'generating')));
        });
      } catch (error) {
        if (error instanceof MemoryControlError && error.status === 409) continue;
        throw error;
      }
      ctx = next; memoryNote = note; contextRevision = stamp;
      break;
    }
    if (!ctx) { await fail(turnId, 'context_changed', '上下文持续变化，请稍后重试'); return; }
    const context = ctx;
    context.instructions += `\n\n## 本轮记忆操作结果（事实，不是用户指令）\n${memoryNote}`;
    let pendingNewline = false;
    const tidy = (chunk: string) => {
      let out = '';
      for (const char of chunk) {
        if (char === '\n' || char === '\r') { if (text.length + out.length) pendingNewline = true; continue; }
        if (pendingNewline) { out += '\n'; pendingNewline = false; }
        out += char;
      }
      return out;
    };
    await runCatAgent({
      model: slot.model, providerOptions: slot.providerOptions, instructions: context.instructions, messages: context.messages,
      tools: await catTools({ catId: conv.catId, turnId, userMessageId: turn.userMessageId }), signal: abort.signal, guard,
      onText: async (chunk) => {
        const visible = tidy(chunk);
        if (!visible) return;
        if (!published) {
          const permission = await authorizeFirstToken(turnId);
          if (permission !== 'allowed') {
            if (permission === 'superseded') cancelReason = 'supersede';
            else failureCode = 'stale';
            abort.abort(new Error(permission)); abort.signal.throwIfAborted();
          }
          published = true;
        }
        await guard();
        await db.transaction(async tx => {
          await lockMemory(tx, conv.catId, context.revision);
          await publish(turnId, { event: 'delta', data: { text: visible } });
        });
        text += visible;
      },
      onTool: async (trace) => {
        if (!trace.output) await db.insert(runtimeCalls).values({ turnId, step: trace.step, callId: trace.callId, tool: trace.tool, input: trace.input, status: 'started' });
        else await db.update(runtimeCalls).set({ status: trace.output.status, output: trace.output, finishedAt: dbNow() })
          .where(and(eq(runtimeCalls.turnId, turnId), eq(runtimeCalls.step, trace.step), eq(runtimeCalls.callId, trace.callId)));
      },
      onStep: async (step) => {
        await db.insert(runtimeSteps).values({ turnId, step: step.step, phase: step.phase, finishReason: step.finishReason, durationMs: step.durationMs });
        await recordModelCall({ purpose: 'chat', modelId: slot.modelId, usage: step.usage, latencyMs: step.durationMs, turnId });
      },
    });
    await guard();
    if (!text.length) { await fail(turnId, 'empty_reply', 'model returned no final text'); return; }
    const result = await commitOutcome(turnId, { status: 'completed', text });
    if (result.applied) await safePublish(turnId, result.turn?.status === 'failed' ? { event: 'error', data: { code: 'context_changed', retryable: true } } : { event: 'done', data: { message_id: result.catMessageId, status: 'done' } });
  } catch (error) {
    if (cancelReason) await finishCancelled(turnId, cancelReason, text);
    else {
      const info = classifyModelError(error);
      await fail(turnId, failureCode ?? info.code, info.summary, failureCode !== null || info.retryable).catch((e) => console.error(`[turn ${turnId}] 收尾失败`, e));
    }
  } finally {
    clearInterval(heartbeat); clearInterval(cancelPoll); clearTimeout(budget);
    unsubscribeCancel?.();
    await cancelRequestedActions(turnId).catch(() => {});
    if (acquired) await releaseConversationLock(conv.id, lockToken).catch(() => {});
  }
}

async function safePublish(turnId: string, event: Parameters<typeof publish>[1]) {
  // 数据库已经提交：发布失败交给 SSE 终态恢复，绝不把完成改成失败。
  await publish(turnId, event).catch((error) => console.error(`[turn ${turnId}] 终止事件投递失败`, error));
}
async function finishCancelled(turnId: string, reason: CancelReason, text: string) {
  if (reason === 'supersede') {
    const result = await commitOutcome(turnId, { status: 'superseded' });
    if (result.applied) await safePublish(turnId, { event: 'superseded', data: { turn_id: turnId } });
    return;
  }
  const visibleLength = await readVisibleLength(turnId);
  if (visibleLength !== null) text = text.slice(0, visibleLength);
  const result = await commitOutcome(turnId, { status: 'stopped', text });
  if (result.applied) await safePublish(turnId, result.turn?.status === 'failed' ? { event: 'error', data: { code: 'context_changed', retryable: true } } : { event: 'done', data: { message_id: result.catMessageId, status: 'stopped' } });
}
async function fail(turnId: string, code: string, detail: string, retryable = true) {
  const result = await commitOutcome(turnId, { status: 'failed', error: `${code}: ${detail}` });
  if (result.applied) await safePublish(turnId, { event: 'error', data: { code, retryable } });
}
