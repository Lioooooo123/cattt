import { enqueuePush } from '../push/service.ts';
import { followupText } from './router.ts';
import { availableAt, localISO } from './tickets.ts';
import { refreshConversationLock } from '../turns/events.ts';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.ts';
import { cats, proactiveRules, type RunJournal, boundaries, diaryEntries, messages, tickets, conversations, outbox, mailboxLetters, decisions, users } from '../db/schema.ts';
import { lockMemory } from '../memory/control.ts';
import { diaryCommentAllowed, overlapsBoundaries, followupDenial } from './gate.ts';

const revisionFields = sql`c.persona_version, c.updated_at, c.memory_revision,
      (select max(version) from soul_versions where cat_id = c.id) soul,
      (select count(*) from soul_blocked_sources where cat_id = c.id) blocked,
      (select max(created_at) from memory_blocks where cat_id = c.id) memory_deleted`;

export async function turnGuardSnapshot(catId: string, turnId: string, reader: Tx | typeof db = db) {
  const rows = await reader.execute(sql`select t.status, v.version,
    (select string_agg(id::text, ',' order by id::text collate "C") from boundaries where cat_id = c.id) boundaries,
    ${revisionFields} from turns t join conversations v on v.id = t.conversation_id
    join cats c on c.id = ${catId} where t.id = ${turnId}`);
  const row = rows[0];
  if (!row) return undefined;
  const { status, version, boundaries: stamp, ...revision } = row;
  return { status, version: Number(version), boundaryStamp: stamp ?? '', revision: JSON.stringify([revision]) };
}

/** 保留聊天首字前可重读、发布后终止旧快照的原有检查顺序。 */
export function turnPublicationChecks(catId: string, reader: Tx | typeof db = db) {
  const boundaryStamp = async () => (await reader.select({ id: boundaries.id }).from(boundaries).where(eq(boundaries.catId, catId)))
      .map((b) => b.id).sort().join(',');
  const revision = async () => JSON.stringify(await reader.execute(sql`select ${revisionFields}
      from cats c where c.id = ${catId}`));
  const protection = async () => JSON.stringify(await reader.execute(sql`select c.persona_version, c.updated_at,
      c.learn_memories, c.use_memories, c.learn_after_seq,
      (select count(*) from messages m join conversations v on v.id = m.conversation_id
        where v.cat_id = c.id and m.context_allowed = false) withdrawn,
      (select count(*) from soul_blocked_sources where cat_id = c.id) blocked,
      (select max(created_at) from memory_blocks where cat_id = c.id) memory_deleted,
      (select jsonb_agg(jsonb_build_array(id, revision) order by id) from memories
        where cat_id = c.id and extractor_version = 'user-edit-v1') edited
      from cats c where c.id = ${catId}`));
  return {
    boundaryStamp, revision, protection,
    contextUnchanged: async (expectedRevision: string | undefined, expectedBoundaries: string) =>
      !(expectedRevision !== undefined && await revision() !== expectedRevision) && await boundaryStamp() === expectedBoundaries,
    protectionUnchanged: async (expected: string) => await protection() === expected,
    revisionUnchanged: async (expected: string) => await revision() === expected,
  };
}

export async function diaryPublicationInput(tx: Tx, entryId: string, version: string) {
  const [initial] = await tx.select().from(diaryEntries).where(eq(diaryEntries.id, entryId));
  if (!initial) return null;
  const cat = await lockMemory(tx, initial.catId);
  const [entry] = await tx.select().from(diaryEntries).where(eq(diaryEntries.id, entryId));
  if (!diaryCommentAllowed(entry, version)) return null;
  const topics = await tx.select({ topic: boundaries.description, text: messages.text }).from(boundaries)
    .innerJoin(messages, eq(messages.id, boundaries.sourceMessageId))
    .where(and(eq(boundaries.catId, cat.id), eq(messages.contextAllowed, true)));
  const item = { id: entry.id, subject: '', predicate: '', value: entry.text, fingerprint: '', explicit: true, sensitivity: 'low', lastConfirmedAt: entry.updatedAt, revision: entry.revision };
  if (overlapsBoundaries(item, topics.map(t => t.topic ?? t.text))) return null;
  return { entry, revision: cat.memoryRevision, name: cat.name };
}

/** 调用方持有同一个事务，复核后才写入用户可见的留言。 */
export async function reviewDiaryPublication(tx: Tx, input: NonNullable<Awaited<ReturnType<typeof diaryPublicationInput>>>) {
  const cat = await lockMemory(tx, input.entry.catId);
  const [current] = await tx.select().from(diaryEntries).where(eq(diaryEntries.id, input.entry.id));
  if (!current?.catAllowed || current.revision !== input.entry.revision || current.visit > 0) return false;
  if (cat.memoryRevision !== input.revision) throw new Error('diary_context_changed');
  return true;
}

async function writeFollowupDelivery(tx:Tx,input:{catId:string;conversationId:string;ticketId:string;text:string;sendChat:boolean}){
 const [chatMessage]=input.sendChat?await tx.insert(messages).values({conversationId:input.conversationId,role:'cat',text:input.text,ticketId:input.ticketId,memoryEligible:false}).returning():[];
 const [letter]=await tx.insert(mailboxLetters).values({catId:input.catId,ticketId:input.ticketId,text:input.text}).returning();
 return{chatMessage,letter};
}

/** 主动产出与普通回复共用对话锁；只由用户输入递增 version。 */
export async function publishFollowups(candidate: {
  catId:string; userId:string; conversationId:string; version:number; triggerId:string;
  batch:(typeof tickets.$inferSelect)[]; text:string; overdue:boolean; now?:Date; reason:string; lockToken:string; timeZone:string;
}):Promise<'sent'|'stale'> {
  return db.transaction(async tx=>{
    const cat=await lockMemory(tx,candidate.catId);
    const [conv]=await tx.select().from(conversations).where(eq(conversations.id,candidate.conversationId)).for('update');
    if(!conv || conv.catId!==cat.id || cat.userId!==candidate.userId) throw new Error('followup_owner');
    const [user]=await tx.select().from(users).where(eq(users.id,cat.userId)).for('update');
    if(conv.version!==candidate.version || user?.timeZone!==candidate.timeZone) return 'stale';
    if(!await refreshConversationLock(conv.id,candidate.lockToken)) throw new Error('followup_lock_lost');
    const topics=await tx.select({topic:boundaries.description,text:messages.text}).from(boundaries).innerJoin(messages,eq(messages.id,boundaries.sourceMessageId)).where(and(eq(boundaries.catId,cat.id),eq(messages.contextAllowed,true)));
    const valid: (typeof tickets.$inferSelect)[]=[];
    for(const expected of candidate.batch) {
      const [t]=await tx.select().from(tickets).where(eq(tickets.id,expected.id)).for('update');
      if(!t || t.catId!==cat.id || t.status!=='open') continue;
      if(t.dueAt?.toISOString()!==expected.dueAt?.toISOString() || +t.updatedAt!==+expected.updatedAt) return 'stale';
      const [source]=t.sourceMessageId ? await tx.select().from(messages).where(eq(messages.id,t.sourceMessageId)) : [];
      const denied=followupDenial(t,source,conv.id,topics.map(t=>t.topic??t.text));
      // 本段候选只依赖用户亲口约定，不依赖记忆，use_memories=false 不撤回 explicit 授权。
      const [receipt]=await tx.select().from(outbox).where(and(eq(outbox.ticketId,t.id),eq(outbox.purpose,'followup:letter')));
      if(receipt) continue;
      if(denied) {
        await tx.insert(outbox).values({catId:cat.id,ticketId:t.id,purpose:'followup:letter',kind:'mailbox_letter',status:'dropped',droppedReason:denied}).onConflictDoNothing();
        await tx.update(tickets).set({status:'ended',stage:'dropped',endedReason:denied,updatedAt:sql`now()`}).where(eq(tickets.id,t.id));
      } else valid.push(t);
    }
    if(!valid.length) return 'sent';
    const [clock]=await tx.execute<{instant:string}>(sql`select clock_timestamp() as instant`);
    const now=candidate.now ?? new Date(clock!.instant);
    const hour=Number(localISO(now,user!.timeZone).slice(11,13));
    if(valid.some(t=>(+now-+t.dueAt!>86400000)!==candidate.overdue)) return 'stale';
    if(!candidate.overdue && (hour<9 || hour>=22 || valid.some(t=>+availableAt(t.dueAt!,user!.timeZone)>+now))) return 'stale';
    const text=valid.length===candidate.batch.length ? candidate.text : followupText(valid,candidate.overdue);
    const {chatMessage}=await writeFollowupDelivery(tx,{catId:cat.id,conversationId:conv.id,ticketId:valid[0]!.id,text,sendChat:!candidate.overdue});
    for(const t of valid) {
      if(!candidate.overdue) await tx.insert(outbox).values({catId:cat.id,ticketId:t.id,purpose:'followup:chat',kind:'chat_message',status:'sent'}).onConflictDoNothing();
      await tx.insert(outbox).values({catId:cat.id,ticketId:t.id,purpose:'followup:letter',kind:'mailbox_letter',status:'sent'}).onConflictDoNothing();
      await tx.update(tickets).set({status:'ended',stage:candidate.overdue?'letter':'asked',endedReason:'delivered',updatedAt:sql`now()`}).where(eq(tickets.id,t.id));
      await tx.insert(decisions).values({triggerId:candidate.triggerId,ticketId:t.id,outcome:'attach',reasons:[candidate.reason,candidate.overdue?'超过24小时只留信':'亲口约定到期']});
    }
    if(chatMessage)await enqueuePush(tx,{catId:cat.id,ticketIds:valid.map(t=>t.id),reason:'followup_due',payload:{route:'chat',message_id:chatMessage.id},proof:{messageIds:valid.flatMap(t=>t.sourceMessageId?[t.sourceMessageId]:[]),diaries:[],usedMemories:false,content:text},now,purpose:'push:followup'});
    // PG收据即前台可重放的提示来源；本段没有外部副作用，无需额外投递。
    return 'sent';
  });
}

/** 模型前和发布事务复用同一来源/许可检查。 */
export async function errandDenial(reader:Tx|typeof db,cat:typeof cats.$inferSelect,conv:typeof conversations.$inferSelect,t:typeof tickets.$inferSelect,journal:RunJournal,wording?:string) {
 const a=journal.active;
 let denied:string|undefined;
 const sourceTexts:string[]=[];

 if(t.status!=='open')denied='授权已撤回';
 if(t.mandate.kind==='inferred'){
 if(!cat.allowProactive)denied='主动许可已关闭';
 const [rule]=await reader.select().from(proactiveRules).where(and(eq(proactiveRules.ruleId,t.mandate.rule_id),eq(proactiveRules.version,t.mandate.version)));
 if(rule?.mode!=='auto')denied='规则已关闭';
 }else if(t.mandate.source_message_id!==t.sourceMessageId)denied='授权不可用';
 const topics=await reader.select({topic:boundaries.description,text:messages.text}).from(boundaries).innerJoin(messages,eq(messages.id,boundaries.sourceMessageId)).where(and(eq(boundaries.catId,cat.id),eq(messages.contextAllowed,true)));
 for(const id of new Set([t.sourceMessageId,...journal.dependencies.messages])){
 const [m]=id?await reader.select().from(messages).where(eq(messages.id,id)):[];
 if(!m?.contextAllowed||m.conversationId!==conv.id)denied='原话已停止使用';
 else sourceTexts.push(m.text);
 }
 for(const ref of journal.dependencies.diaries){
 const [d]=await reader.select().from(diaryEntries).where(eq(diaryEntries.id,ref.id));
 if(!d?.catAllowed||d.catId!==cat.id||d.revision!==ref.revision)denied='日记已停止使用或修改';
 else sourceTexts.push(d.text);
 }
 if(journal.dependencies.usedMemories&&(!cat.useMemories||cat.memoryRevision!==journal.dependencies.memoryRevision))denied='记忆许可或内容已变化';
 if(overlapsBoundaries({id:t.id,subject:'',predicate:'',value:[t.goal,a?.result,a?.question,a?.reason,wording,...sourceTexts].filter(Boolean).join(' '),fingerprint:'',explicit:true,sensitivity:'low',lastConfirmedAt:t.createdAt,revision:0},topics.map(t=>t.topic??t.text)))denied='不要再提';
 return denied;
}

/** 托付出口：持有对话锁，并在同一事务里复核、写正文和收据。 */
export async function publishErrand(candidate:{runId:string;attempt:number;callId:string;lockToken:string;now:Date;text?:string;protection?:string}):Promise<'sent'|'stale'|{retryAt:Date}> {
 const {runs,ticketInputs,proactiveRules}=await import('../db/schema.ts');
 return db.transaction(async tx=>{
 const [initial]=await tx.select({r:runs,t:tickets}).from(runs).innerJoin(tickets,eq(tickets.id,runs.ticketId)).where(eq(runs.id,candidate.runId));if(!initial)return 'sent';
 const cat=await lockMemory(tx,initial.t.catId);
 const [conv]=await tx.select().from(conversations).where(eq(conversations.catId,cat.id)).for('update');
 const [user]=await tx.select().from(users).where(eq(users.id,cat.userId)).for('update');
 const [t]=await tx.select().from(tickets).where(eq(tickets.id,initial.t.id)).for('update');
 const [r]=await tx.select().from(runs).where(eq(runs.id,initial.r.id)).for('update');
 if(!r||!t||!conv||!user||r.attempt!==candidate.attempt||r.status==='ended')return 'sent';
 if(!await refreshConversationLock(conv.id,candidate.lockToken))throw new Error('errand_lock_lost');
 const journal=r.report,a=journal.active;if(!a||a.callId!==candidate.callId)return 'sent';
 if(t.catId!==cat.id||conv.catId!==cat.id||t.kind!=='errand')throw new Error('errand_owner');
 const denied=await errandDenial(tx,cat,conv,t,journal,candidate.text);
 // 第一代保持历史收据键；续办的失败/提问按执行隔离，旧失败不吞掉新汇报。
 const runScope=r.generation>0?`:run:${r.id}`:'';
 const purpose=`errand:${a.status==='waiting'?'waiting:'+a.callId:a.status}${runScope}`;
 const [receipt]=await tx.select().from(outbox).where(and(eq(outbox.ticketId,t.id),eq(outbox.purpose,purpose+':chat')));
 if(receipt)return 'sent';
 const finish=async(stage:string,reason:string)=>{
 await tx.update(runs).set({status:'ended',leaseUntil:null,stepStartedAt:null}).where(eq(runs.id,r.id));
 if(t.status==='open')await tx.update(tickets).set({status:'ended',stage,endedReason:reason,updatedAt:candidate.now}).where(eq(tickets.id,t.id));
 };
 if(denied||a.status==='dropped'){
 await tx.insert(outbox).values({catId:cat.id,ticketId:t.id,purpose:purpose+':chat',kind:'chat_message',status:'dropped',droppedReason:denied??'不需要继续'}).onConflictDoNothing();
 await finish('dropped',denied??'dropped');return 'sent';
 }
 const [unread]=await tx.select().from(ticketInputs).where(and(eq(ticketInputs.ticketId,t.id),sql`${ticketInputs.readAt} is null`)).limit(1);
 // 宿主的预算/运行错误没有依赖旧对话的计算结果，补充不能恢复已耗尽的预算。
 // 仍经过上方许可检查和下方出版保护、安静时段；兼容旧版固定标识的失败凭证。
 const runtimeFailure=a.status==='failed'&&(a.runtimeFailure===true||a.callId==='runtime-budget-or-error');
 if(!runtimeFailure&&(conv.version!==journal.version||user.timeZone!==journal.timeZone||unread))return 'stale';
 if(candidate.protection&&!await turnPublicationChecks(cat.id,tx).protectionUnchanged(candidate.protection))return 'stale';
 if(a.status==='waiting'&&+candidate.now-Date.parse(a.createdAt)>=86400000){
 await tx.update(tickets).set({stage:'quiet_waiting',updatedAt:candidate.now}).where(eq(tickets.id,t.id));
 await tx.update(runs).set({status:'pending',leaseUntil:null,stepStartedAt:null}).where(eq(runs.id,r.id));return 'sent';
 }
 const available=availableAt(candidate.now,user.timeZone);if(+available>+candidate.now)return {retryAt:available};
 const text=candidate.text ?? (a.status==='ready'?'我想好了一些，放在信箱里了，想看时再拆。':a.status==='waiting'?a.question!:`这件事没能办好。${a.reason??'这次没有想出可靠的办法。'}`);
 if(a.status==='progress')return 'sent';
 const [chatMessage]=await tx.insert(messages).values({conversationId:conv.id,role:'cat',text,ticketId:t.id,memoryEligible:false}).returning();
 await tx.insert(outbox).values({catId:cat.id,ticketId:t.id,purpose:purpose+':chat',kind:'chat_message',status:'sent'});
 if(a.status==='ready'){
 const [letter]=await tx.insert(mailboxLetters).values({catId:cat.id,ticketId:t.id,text:a.result!}).returning();
 await enqueuePush(tx,{catId:cat.id,ticketIds:[t.id],reason:'errand_ready',payload:{route:'mailbox',letter_id:letter!.id},proof:{messageIds:[...new Set([t.sourceMessageId!,...journal.dependencies.messages])],diaries:journal.dependencies.diaries,usedMemories:journal.dependencies.usedMemories,memoryRevision:journal.dependencies.memoryRevision,content:a.result!},now:candidate.now,purpose:'push:errand:ready'});
 await tx.insert(outbox).values({catId:cat.id,ticketId:t.id,purpose:'errand:ready:letter',kind:'mailbox_letter',status:'sent'});
 }
 if(a.status==='waiting'){
 await enqueuePush(tx,{catId:cat.id,ticketIds:[t.id],reason:'errand_waiting',payload:{route:'chat',message_id:chatMessage!.id},proof:{messageIds:[...new Set([t.sourceMessageId!,...journal.dependencies.messages])],diaries:journal.dependencies.diaries,usedMemories:journal.dependencies.usedMemories,memoryRevision:journal.dependencies.memoryRevision,content:a.question!,callId:a.callId,runId:r.id},now:candidate.now,purpose:'push:errand:waiting:'+a.callId+runScope});
 await tx.update(tickets).set({stage:'waiting',updatedAt:candidate.now}).where(eq(tickets.id,t.id));
 await tx.update(runs).set({status:'pending',leaseUntil:null,stepStartedAt:null}).where(eq(runs.id,r.id));
 }else await finish(a.status,'delivered');
 return 'sent';
 });
}

/** 每日日记只写现有日记表和inbox收据，绝不写普通来信、聊天或推送。 */
export async function publishDailyDiary(candidate: {input:import('./daily-diary.ts').DailyInput;text:string;triggerId:string}):Promise<'sent'|'stale'> {
  const { dailyDiaryInput, dayStart, safeDailyText } = await import('./daily-diary.ts');
  const { randomUUID, createHash } = await import('node:crypto');
  return db.transaction(async tx=>{
    const cat=await lockMemory(tx,candidate.input.catId);
    const [conv]=await tx.select().from(conversations).where(eq(conversations.catId,cat.id)).for('update');
    await tx.select().from(users).where(eq(users.id,cat.userId)).for('update');
    const [ticket]=await tx.select().from(tickets).where(eq(tickets.id,candidate.input.ticketId)).for('update');
    if(!ticket||ticket.catId!==cat.id||!conv)throw new Error('daily_owner');
    if(ticket.status!=='open')return 'sent';
    const current=await dailyDiaryInput(ticket.id,tx);
    if(!current||current.stamp!==candidate.input.stamp)return 'stale';
    const [receipt]=await tx.select().from(outbox).where(and(eq(outbox.ticketId,ticket.id),eq(outbox.purpose,'daily_diary')));
    if(receipt)return 'sent';
    const [existing]=await tx.select().from(diaryEntries).where(and(eq(diaryEntries.catId,cat.id),eq(diaryEntries.kind,'cat'),eq(diaryEntries.day,current.day)));
    if(!existing)await tx.insert(diaryEntries).values({catId:cat.id,clientId:`daily-cat:${current.day}`,kind:'cat',text:safeDailyText(candidate.text,current.boundaryTopics),
      recordedAt:dayStart(current.day,current.timeZone),timeZone:current.timeZone,day:current.day,time:'00:00',catAllowed:false,mutationId:randomUUID()});
    await tx.insert(outbox).values({catId:cat.id,ticketId:ticket.id,purpose:'daily_diary',kind:'mailbox_letter',status:'sent'});
    await tx.update(tickets).set({status:'ended',stage:'written',endedReason:existing?'existing_diary':'delivered',updatedAt:sql`now()`}).where(eq(tickets.id,ticket.id));
    await tx.insert(decisions).values({triggerId:candidate.triggerId,ticketId:ticket.id,outcome:'attach',reasons:['日记已写入；仅信箱提示',{input_hash:createHash('sha256').update(current.stamp).digest('hex'), sources:current.facts.map(f=>({kind:f.kind,source_id:f.sourceId,content_hash:createHash('sha256').update(f.text).digest('hex')})), revision:cat.memoryRevision, version:conv.version, time_zone:current.timeZone}]});
    return 'sent';
  });
}

/** 推断共用同一信箱/聊天出口；独立准入，不继承explicit的必发或过期转信兜底。 */
export async function publishInferredFollowup(candidate:{snapshot:import('./inference.ts').InferenceSnapshot;ticketId:string;lockToken:string;now?:Date}):Promise<'sent'|'stale'|{retryAt:Date}>{
 const {readInferenceSnapshot,sourceHash}=await import('./inference.ts');
 const {inferredPublications,inferenceWatches}=await import('../db/schema.ts');
 const {config}=await import('../config.ts');
 return db.transaction(async tx=>{
  const expected=candidate.snapshot,cat=await lockMemory(tx,expected.cat.id);
  const [conv]=await tx.select().from(conversations).where(eq(conversations.id,expected.conversation.id)).for('update');
  const [user]=await tx.select().from(users).where(eq(users.id,cat.userId)).for('update');
  await tx.execute(sql`lock table proactive_rules in share mode`);
  const [t]=await tx.select().from(tickets).where(eq(tickets.id,candidate.ticketId)).for('update');
  if(!t||t.catId!==cat.id||!conv||!user||t.kind!=='followup'||t.mandate.kind!=='inferred')throw new Error('inferred_owner');
  if(t.status!=='open')return 'sent';
  if(!await refreshConversationLock(conv.id,candidate.lockToken))throw new Error('inferred_lock_lost');
  const current=await readInferenceSnapshot(expected.trigger.id,expected.rule.ruleId,tx);
  if(!current||current.stamp!==expected.stamp||current.denial||config.AGENT_ENABLED!=='true'||!cat.allowProactive||current.rule.mode!=='auto')return 'stale';
  if(t.mandate.rule_id!==current.rule.ruleId||t.mandate.version!==current.rule.version||t.sourceMessageId!==current.source.id||t.mandate.source_hash!==sourceHash(current.source.text)||t.mandate.permission_revision!==cat.proactiveRevision)return 'stale';
  const [clock]=await tx.execute<{instant:string}>(sql`select clock_timestamp() as instant`);const now=candidate.now??new Date(clock!.instant);
  const drop=async(reason:string)=>{await tx.update(tickets).set({status:'ended',stage:'dropped',endedReason:reason,updatedAt:now}).where(eq(tickets.id,t.id));return 'sent' as const;};
  if(!t.dueAt||+now<+t.dueAt)return{retryAt:t.dueAt??new Date(+now+30000)};
  if(+now-+t.dueAt>86400000)return drop('inferred_expired');
  const available=availableAt(now,user.timeZone);if(+available>+now)return{retryAt:available};
  const day=localISO(now,user.timeZone).slice(0,10);
  const [prior]=await tx.select().from(inferredPublications).where(sql`${inferredPublications.catId}=${cat.id} and (${inferredPublications.localDay}=${day} or ${inferredPublications.sourceMessageId}=${current.source.id})`);
  if(prior)return drop('inferred_daily_limit');
  await tx.insert(inferredPublications).values({catId:cat.id,ticketId:t.id,sourceMessageId:current.source.id,localDay:day});
  await writeFollowupDelivery(tx,{catId:cat.id,conversationId:conv.id,ticketId:t.id,text:t.goal+'？',sendChat:true});
  await tx.insert(outbox).values([{catId:cat.id,ticketId:t.id,purpose:'inferred:chat',kind:'chat_message',status:'sent'},{catId:cat.id,ticketId:t.id,purpose:'inferred:letter',kind:'mailbox_letter',status:'sent'}]);
  await tx.update(tickets).set({status:'ended',stage:'asked',endedReason:'delivered',updatedAt:now}).where(eq(tickets.id,t.id));
  await tx.update(inferenceWatches).set({state:'ended'}).where(and(eq(inferenceWatches.catId,cat.id),eq(inferenceWatches.sourceMessageId,current.source.id)));
  return 'sent';
 });
}


/** 前台接收阅读汇报，重新加载原文与许可，不使用持久化正文副本。 */
export async function publishDiaryRead(candidate:{entryId:string;version:string;revision:number;comment:string|null}):Promise<'sent'|'stale'> {
 return db.transaction(async tx=>{
  const input=await diaryPublicationInput(tx,candidate.entryId,candidate.version);
  if(!input)return 'sent';
  if(input.revision!==candidate.revision)return 'stale';
  await tx.update(diaryEntries).set({visit:candidate.comment?2:1,note:candidate.comment??''}).where(eq(diaryEntries.id,candidate.entryId));
  return 'sent';
 });
}
