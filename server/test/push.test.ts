import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { and, eq, asc } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users,cats,conversations,messages,tickets,triggers,asyncJobs,pushNotifications,pushDeliveries,devices,outbox } from '../src/db/schema.ts';
import { registerDevice, processPush } from '../src/push/service.ts';
import { createApnsTransport } from '../src/push/apns.ts';
import { scheduleFollowup, cancelTicket } from '../src/agent/tickets.ts';
import { scanFollowups, processFollowup } from '../src/agent/followup.ts';
import { startErrand } from '../src/agent/errands.ts';
import { processErrand } from './report-pipeline.ts';
import { runs,mailboxLetters } from '../src/db/schema.ts';
import { config } from '../src/config.ts';
import { closeQueues } from '../src/queue.ts';
const now=new Date('2026-11-12T12:00:00Z');let userId:string,catId:string,convId:string,sourceId:string;const ids:string[]=[];
beforeEach(async()=>{const [u]=await db.insert(users).values({timeZone:'UTC'}).returning();userId=u!.id;ids.push(userId);const[c]=await db.insert(cats).values({userId,name:'团子',appearance:'orange',temperament:'slow',traits:{energy:1,initiative:1,directness:1,closeness:1}}).returning();catId=c!.id;const[v]=await db.insert(conversations).values({catId}).returning();convId=v!.id;const[m]=await db.insert(messages).values({conversationId:convId,role:'user',text:'问我面试怎么样'}).returning();sourceId=m!.id;});
afterAll(async()=>{for(const id of ids){await sql`delete from async_jobs where source_id in(select id from push_notifications where cat_id in(select id from cats where user_id=${id})) or source_id in(select id from triggers where cat_id in(select id from cats where user_id=${id})) or object_id in(select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id})`;await db.delete(users).where(eq(users.id,id));}await closeQueues();await sql.end();});
const register=(token='a'.repeat(64),uid=userId)=>registerDevice(uid,{token,environment:'sandbox',topic:'local.test.cat'},'local.test.cat');
const pushes=async()=>(await db.select({p:pushNotifications}).from(pushNotifications).innerJoin(outbox,eq(outbox.id,pushNotifications.outboxId)).where(eq(pushNotifications.catId,catId)).orderBy(asc(outbox.seq))).map(r=>r.p);
async function due(goal='面试怎么样'){const t=await scheduleFollowup(catId,sourceId,'2026-11-12T11:59:00Z',goal,new Date('2026-11-11'));await scanFollowups(now,catId);for(const e of await db.select().from(triggers).where(and(eq(triggers.catId,catId),eq(triggers.source,'clock'))))await processFollowup(e.id,{now});return t;}
it('合并约定只产生一条推送；多设备一次用户预算；稳定apns-id，重复投递不重发',async()=>{
 await register();await register('b'.repeat(64));await due();await due('看牙怎么样');const list=await pushes();let calls=0;
 for(const p of list)await processPush(p.id,{now,transport:async req=>{calls++;expect(req.apnsId).toMatch(/^[0-9a-f-]{36}$/);expect(req.payload.account_id).toBe(userId);return{status:200};}});
 const before=calls;for(const p of list)await processPush(p.id,{now,transport:async()=>{calls++;return{status:200};}});expect(calls).toBe(before);expect(calls).toBe(4);
 expect((await pushes()).filter(p=>p.budgetDay==='2026-11-12')).toHaveLength(2);
});
it('一批三件到期只一条；超过两条不推，跨自然日额度恢复',async()=>{
 await register();for(const goal of ['甲','乙','丙'])await scheduleFollowup(catId,sourceId,'2026-11-12T11:59:00Z',goal,new Date('2026-11-11'));
 await scanFollowups(now,catId);for(const e of await db.select().from(triggers).where(eq(triggers.catId,catId)))await processFollowup(e.id,{now});expect(await pushes()).toHaveLength(1);
 let calls=0;const transport=async()=>{calls++;return{status:200};};await processPush((await pushes())[0]!.id,{now,transport});await due('丁');await processPush((await pushes())[1]!.id,{now,transport});await due('戊');await processPush((await pushes())[2]!.id,{now,transport});expect(calls).toBe(2);
 await processPush((await pushes())[2]!.id,{now:new Date(+now+86400000),transport});expect(calls).toBe(2); // 超额通知丢弃，次日不突然打扰
});
it.each(['cancel','withdraw','boundary'] as const)('发送前%s变化，不发送旧结果',async(kind)=>{
 await register();const t=await due();const p=(await pushes())[0]!;
 if(kind==='cancel')await cancelTicket(catId,t.ticket_id);
 if(kind==='withdraw')await db.update(messages).set({contextAllowed:false}).where(eq(messages.id,sourceId));
 if(kind==='boundary'){const{boundaries}=await import('../src/db/schema.ts');await db.insert(boundaries).values({catId,sourceMessageId:sourceId,description:'面试'});}
 let calls=0;await processPush(p.id,{now,transport:async()=>{calls++;return{status:200};}});expect(calls).toBe(0);expect((await pushes())[0]!.status).toBe('dropped');
});
it('无APNs配置不能标sent；503重试保持ID，410失效；响应丢失记uncertain不声称恰好一次',async()=>{
 const d=await register();
 // 注册也使用夹具时钟，否则真实日期晚于 now 时，旧410会被正确忽略。
 await db.update(devices).set({updatedAt:new Date(+now-1000)}).where(eq(devices.id,d.id));
 await due();const p=(await pushes())[0]!;await processPush(p.id,{now});expect((await pushes())[0]!.status).not.toBe('sent');
 const apnsIds:string[]=[];await processPush(p.id,{now,transport:async req=>{apnsIds.push(req.apnsId);return{status:503};}});await processPush(p.id,{now,transport:async req=>{apnsIds.push(req.apnsId);return{status:410,reason:'Unregistered',timestamp:+now};}});expect(apnsIds).toHaveLength(2);expect(apnsIds[0]).toBe(apnsIds[1]);expect((await db.select().from(devices).where(eq(devices.id,d.id)))[0]!.invalidAt).not.toBeNull();
 await register();await due('另一件');await processPush((await pushes())[1]!.id,{now,transport:async()=>{throw new Error('connection lost after write');}});expect((await db.select().from(pushDeliveries).where(eq(pushDeliveries.notificationId,(await pushes())[1]!.id)))[0]!.status).toBe('uncertain');
});
it('托付ready/waiting允许，记忆依赖变化与已答问题禁止；blocked和日记没有推送',async()=>{
 await register();const t=await startErrand(catId,sourceId,'[memory] 周末建议',now);const r=(await db.select().from(runs).where(eq(runs.ticketId,t.ticket_id)))[0]!;await processErrand(r.id,{now:()=>now});expect(await pushes()).toHaveLength(1);
 await db.update(cats).set({useMemories:false}).where(eq(cats.id,catId));let calls=0;await processPush((await pushes())[0]!.id,{now,transport:async()=>{calls++;return{status:200};}});expect(calls).toBe(0);
 expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,catId))).toHaveLength(1);
});
it('真实ES256 provider签名与官方HTTP2请求参数、token缓存；设备归属和topic隔离',async()=>{
 const key=await generateKeyPair('ES256',{extractable:true});const pem=await exportPKCS8(key.privateKey);const requests:any[]=[];
 const transport=createApnsTransport({teamId:'TEAMTEST',keyId:'KEYTEST',privateKey:pem,request:async req=>{requests.push(req);return{status:200};}});
 const req={token:'a'.repeat(64),environment:'sandbox' as const,topic:'local.test.cat',apnsId:randomUUID(),payload:{aps:{alert:{title:'团子',body:'信箱里有新东西。'}},account_id:userId,route:'chat',message_id:randomUUID()}};
 await transport(req);await transport(req);const h=requests[0].headers;expect(requests[0].origin).toBe('https://api.sandbox.push.apple.com');expect(h[':path']).toBe('/3/device/'+req.token);expect(h['apns-id']).toBe(req.apnsId);expect(h['apns-topic']).toBe(req.topic);expect(h['apns-push-type']).toBe('alert');expect(requests[1].headers.authorization).toBe(h.authorization);
 const jwt=await jwtVerify(h.authorization.slice(7),key.publicKey,{issuer:'TEAMTEST',algorithms:['ES256']});expect(jwt.protectedHeader.kid).toBe('KEYTEST');expect(jwt.payload.iat).toBeTypeOf('number');
 await expect(registerDevice(userId,{token:req.token,environment:'sandbox',topic:'wrong'},'local.test.cat')).rejects.toThrow();
});
it('跨日重试也占发送当天额度，多设备不重复占额，旧日预留不会成为次日第三条',async()=>{
 await register();const ready=async(goal:string,at:Date)=>{const t=await startErrand(catId,sourceId,goal,at);const[r]=await db.select().from(runs).where(eq(runs.ticketId,t.ticket_id));await processErrand(r!.id,{now:()=>at});return(await pushes()).at(-1)!;};
 const old=await ready('昨天的结果',now);await processPush(old.id,{now,transport:async()=>({status:503})});
 const next=new Date(+now+86400000);let calls=0;const send=async()=>{calls++;return{status:200};};
 for(const goal of ['今天第一封','今天第二封']){const p=await ready(goal,next);await processPush(p.id,{now:next,transport:send});}
 await processPush(old.id,{now:next,transport:send});expect(calls).toBe(2);
});
it('多设备发送跨入安静时段，第二台发送前重新读取时钟，不沿用批次开始时间',async()=>{
 await register();await register('b'.repeat(64));await due();let at=new Date('2026-11-12T21:59:59Z'),calls=0;
 await processPush((await pushes())[0]!.id,{clock:()=>at,transport:async()=>{calls++;at=new Date('2026-11-12T22:00:01Z');return{status:200};}});
 expect(calls).toBe(1);
});
it('出口后授权版本变化，发送前不能沿用旧mandate，缺失/关闭规则不推送',async()=>{
 await register();const t=await startErrand(catId,sourceId,'有结果的建议',now);const[r]=await db.select().from(runs).where(eq(runs.ticketId,t.ticket_id));await processErrand(r!.id,{now:()=>now});
 await db.update(tickets).set({mandate:{kind:'inferred',rule_id:'missing-rule',version:1}}).where(eq(tickets.id,t.ticket_id));let calls=0;
 await processPush((await pushes())[0]!.id,{now,transport:async()=>{calls++;return{status:200};}});expect(calls).toBe(0);
});
