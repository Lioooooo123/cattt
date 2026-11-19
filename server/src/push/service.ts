import { readFileSync } from 'node:fs';
import { and,eq,isNull,lte,desc,sql } from 'drizzle-orm';
import { db,type Tx } from '../db/client.ts';
import { devices,pushNotifications,pushDeliveries,pushBudgetReservations,proactiveRules,asyncJobs,outbox,cats,users,tickets,messages,diaryEntries,runs,type PushProof } from '../db/schema.ts';
import { config } from '../config.ts';
import { lockMemory } from '../memory/control.ts';
import { recallPermissions } from '../memory/recall.ts';
import { overlapsBoundaries } from '../agent/gate.ts';
import { localISO,availableAt } from '../agent/tickets.ts';
import { createApnsTransport,type PushTransport } from './apns.ts';
export async function registerDevice(userId:string,input:{token:string;environment:'sandbox'|'production';topic:string},topic=config.APNS_TOPIC){
 if(!topic||input.topic!==topic||!/^[a-fA-F0-9]{32,512}$/.test(input.token))throw new Error('device_invalid');
 const [device]=await db.insert(devices).values({userId,...input,token:input.token.toLowerCase()}).onConflictDoUpdate({target:[devices.token,devices.environment,devices.topic],set:{userId,invalidAt:null,updatedAt:sql`now()`}}).returning();return device!;
}
/** 仅publisher事务调用，PG收据、推送意图与待办一起提交。合并批次只有一份。 */
export async function enqueuePush(tx:Tx,input:{catId:string;ticketIds:string[];reason:'followup_due'|'errand_ready'|'errand_waiting';payload:Record<string,unknown>;proof:PushProof;now:Date;purpose:string}){
 const [cat]=await tx.select().from(cats).where(eq(cats.id,input.catId));if(!cat)return;
 const [device]=await tx.select().from(devices).where(and(eq(devices.userId,cat.userId),isNull(devices.invalidAt))).limit(1);if(!device)return;
 const [receipt]=await tx.insert(outbox).values({catId:cat.id,ticketId:input.ticketIds[0],kind:'push',purpose:input.purpose,status:'pending'}).onConflictDoNothing().returning();if(!receipt)return;
 const [p]=await tx.insert(pushNotifications).values({catId:cat.id,outboxId:receipt.id,ticketIds:input.ticketIds,reason:input.reason,payload:{...input.payload,account_id:cat.userId,aps:{alert:{title:cat.name,body:input.reason==='errand_ready'?'信箱里留了一封信，想看时再拆。':'我留了一句话，想聊时再来。'}}},proof:input.proof,createdAt:input.now}).returning();
 await tx.update(pushNotifications).set({payload:{...p!.payload,notification_id:p!.id}}).where(eq(pushNotifications.id,p!.id));
 await tx.insert(asyncJobs).values({kind:'push',sourceId:p!.id,objectId:p!.id,version:'v1'}).onConflictDoNothing();
}
async function pushAllowed(tx:Tx,p:typeof pushNotifications.$inferSelect,cat:typeof cats.$inferSelect,now:Date){
 if(!['followup_due','errand_ready','errand_waiting'].includes(p.reason))return false;
 const topics=await recallPermissions(cat.id,tx);const text=[p.proof.content];
 for(const id of p.ticketIds){const[t]=await tx.select().from(tickets).where(eq(tickets.id,id));if(!t||t.catId!==cat.id||t.stage==='cancelled'||t.stage==='dropped')return false;
 if(t.mandate.kind==='explicit'){
  if(t.mandate.source_message_id!==t.sourceMessageId||!t.sourceMessageId||!p.proof.messageIds.includes(t.sourceMessageId))return false;
 }else{
  if(!cat.allowProactive)return false;
  const [rule]=await tx.select().from(proactiveRules).where(eq(proactiveRules.ruleId,t.mandate.rule_id)).orderBy(desc(proactiveRules.version)).limit(1);
  if(!rule||rule.version!==t.mandate.version||rule.mode!=='auto')return false;
 }
 if(p.reason==='followup_due'&&(t.kind!=='followup'||!t.dueAt||+now-+t.dueAt>86400000))return false;
 if(p.reason.startsWith('errand')&&t.kind!=='errand')return false;
 if(p.reason==='errand_waiting'){
  const[r]=await tx.select().from(runs).where(eq(runs.ticketId,t.id)).orderBy(desc(runs.generation)).limit(1);
  if(t.stage!=='waiting'||!r?.report.active||r.report.active.callId!==p.proof.callId||+now-Date.parse(r.report.active.createdAt)>86400000)return false;
  if(p.proof.runId?p.proof.runId!==r.id:r.generation!==0)return false;
 }
 text.push(t.goal);}
 for(const id of p.proof.messageIds){const[m]=await tx.select({m:messages,catId:sql<string>`(select cat_id from conversations where id=${messages.conversationId})`}).from(messages).where(eq(messages.id,id));if(!m?.m.contextAllowed||m.catId!==cat.id||topics.suppressedSources.has(id))return false;text.push(m.m.text);}
 for(const ref of p.proof.diaries){const[d]=await tx.select().from(diaryEntries).where(eq(diaryEntries.id,ref.id));if(!d?.catAllowed||d.catId!==cat.id||d.revision!==ref.revision)return false;text.push(d.text);}
 if(p.proof.usedMemories&&(!cat.useMemories||cat.memoryRevision!==p.proof.memoryRevision))return false;
 return !overlapsBoundaries({id:p.id,subject:'',predicate:'',value:text.join(' '),fingerprint:'',explicit:true,sensitivity:'low',lastConfirmedAt:now,revision:0},topics.boundaryTopics);
}
let configured:PushTransport|undefined;
function transport(){
 if(configured)return configured;
 if(!config.APNS_TEAM_ID||!config.APNS_KEY_ID||!config.APNS_PRIVATE_KEY_FILE||!config.APNS_TOPIC)return undefined;
 configured=createApnsTransport({teamId:config.APNS_TEAM_ID,keyId:config.APNS_KEY_ID,privateKey:readFileSync(config.APNS_PRIVATE_KEY_FILE,'utf8')});return configured;
}
/** 外部调用不持PG长事务；每台设备发出前重新复核。PG与APNs之间不声称原子恰好一次。 */
async function reservePushDay(tx:Tx,p:typeof pushNotifications.$inferSelect,catId:string,day:string){
 const [reserved]=await tx.select().from(pushBudgetReservations).where(and(eq(pushBudgetReservations.notificationId,p.id),eq(pushBudgetReservations.day,day)));
 if(reserved)return true;
 const [count]=await tx.select({n:sql<number>`count(*)::int`}).from(pushBudgetReservations).where(and(eq(pushBudgetReservations.catId,catId),eq(pushBudgetReservations.day,day)));
 if(count!.n>=2)return false;
 await tx.insert(pushBudgetReservations).values({catId,notificationId:p.id,day});
 await tx.update(pushNotifications).set({budgetDay:day}).where(eq(pushNotifications.id,p.id));return true;
}
export async function processPush(id:string,options:{now?:Date;clock?:()=>Date;transport?:PushTransport}={}):Promise<void|{retryAt:Date}>{
 if(config.REMOTE_PUSH_ENABLED!=='true')return{retryAt:new Date(Date.now()+60000)};
 const send=options.transport??transport();if(!send)return{retryAt:new Date(Date.now()+60000)};
 const now=options.clock?.()??options.now??new Date((await db.execute<{instant:string}>(sql`select now() as instant`))[0]!.instant);
 const ready=await db.transaction(async tx=>{
  const[initial]=await tx.select().from(pushNotifications).where(eq(pushNotifications.id,id));if(!initial)return false;
  const cat=await lockMemory(tx,initial.catId);const[p]=await tx.select().from(pushNotifications).where(eq(pushNotifications.id,id)).for('update');if(!p||['sent','dropped'].includes(p.status))return false;
  const drop=async(reason:string)=>{await tx.update(pushNotifications).set({status:'dropped'}).where(eq(pushNotifications.id,id));await tx.update(outbox).set({status:'dropped',droppedReason:reason}).where(eq(outbox.id,p.outboxId));return false;};
  if(!await pushAllowed(tx,p,cat,now))return drop('来源或授权已变化');
  const[u]=await tx.select().from(users).where(eq(users.id,cat.userId)).for('update');
  const due=availableAt(now,u!.timeZone);if(+due>+now)return due;
  if(!await reservePushDay(tx,p,cat.id,localISO(now,u!.timeZone).slice(0,10)))return drop('当日推送已满');
  for(const d of await tx.select().from(devices).where(and(eq(devices.userId,cat.userId),isNull(devices.invalidAt))))await tx.insert(pushDeliveries).values({notificationId:id,deviceId:d.id}).onConflictDoNothing();
  return true;
 });
 if(ready instanceof Date)return{retryAt:ready};if(!ready)return;
 const all=await db.select().from(pushDeliveries).where(eq(pushDeliveries.notificationId,id));let retry=false;let quietRetry:Date|undefined;
 for(const delivery of all){
  const sendNow=options.clock?.()??options.now??new Date((await db.execute<{instant:string}>(sql`select now() as instant`))[0]!.instant);
  const request=await db.transaction(async tx=>{
   const[p]=await tx.select().from(pushNotifications).where(eq(pushNotifications.id,id));if(!p)return null;const cat=await lockMemory(tx,p.catId);
   const[d]=await tx.select().from(devices).where(eq(devices.id,delivery.deviceId));const[current]=await tx.select().from(pushDeliveries).where(eq(pushDeliveries.id,delivery.id)).for('update');
   if(!current||['sent','invalid','dropped','uncertain'].includes(current.status))return null;
   // 崩溃留下sending时已无法判断APNs是否接受，保留uncertain，避免自动重发冒充恰好一次。
   if(current.status==='sending'){await tx.update(pushDeliveries).set({status:'uncertain',reason:'进程中断，供应商结果未知'}).where(eq(pushDeliveries.id,current.id));return null;}
   if(!d||d.userId!==cat.userId||d.invalidAt||!await pushAllowed(tx,p,cat,sendNow)){await tx.update(pushDeliveries).set({status:'dropped'}).where(eq(pushDeliveries.id,current.id));return null;}
   const [user]=await tx.select().from(users).where(eq(users.id,cat.userId)).for('update');
   const available=availableAt(sendNow,user!.timeZone);if(+available>+sendNow)return available;
   if(!await reservePushDay(tx,p,cat.id,localISO(sendNow,user!.timeZone).slice(0,10))){await tx.update(pushDeliveries).set({status:'dropped',reason:'当日推送已满'}).where(eq(pushDeliveries.id,current.id));return null;}
   await tx.update(pushDeliveries).set({status:'sending',attempts:sql`${pushDeliveries.attempts}+1`,updatedAt:now}).where(eq(pushDeliveries.id,current.id));
   return{token:d.token,environment:d.environment as 'sandbox'|'production',topic:d.topic,apnsId:current.apnsId,payload:p.payload};
  });
  if(request instanceof Date){quietRetry=request;continue;}
  if(!request)continue;
  try{
   const response=await send(request);let state='dropped';
   if(response.status===200)state='sent';else if(response.status===410||response.reason==='BadDeviceToken'||response.reason==='DeviceTokenNotForTopic')state='invalid';else if(response.status===429||response.status>=500){state='pending';retry=true;}
   await db.transaction(async tx=>{
    await tx.update(pushDeliveries).set({status:state,reason:response.reason??String(response.status),updatedAt:now}).where(eq(pushDeliveries.id,delivery.id));
    if(state==='invalid')await tx.update(devices).set({invalidAt:now}).where(and(eq(devices.id,delivery.deviceId),lte(devices.updatedAt,new Date(response.timestamp??+now))));
   });
  }catch{await db.update(pushDeliveries).set({status:'uncertain',reason:'连接中断，无法确定APNs是否已接受',updatedAt:now}).where(eq(pushDeliveries.id,delivery.id));}
 }
 const final=await db.select().from(pushDeliveries).where(eq(pushDeliveries.notificationId,id));
 if(quietRetry)return{retryAt:quietRetry};
 if(retry)return{retryAt:new Date(+now+60000)};
 const status=final.some(d=>d.status==='uncertain')?'uncertain':final.some(d=>d.status==='sent')?'sent':'dropped';
 await db.transaction(async tx=>{await tx.update(pushNotifications).set({status}).where(eq(pushNotifications.id,id));await tx.update(outbox).set({status:status==='uncertain'?'pending':status,droppedReason:status==='uncertain'?'供应商结果未知':null}).where(eq(outbox.id,(await tx.select().from(pushNotifications).where(eq(pushNotifications.id,id)))[0]!.outboxId));});
}
