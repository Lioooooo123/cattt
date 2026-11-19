import { processDailyDiary, deliverReports } from './report-pipeline.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users,cats,conversations,messages,tickets,triggers,asyncJobs,diaryEntries,outbox,mailboxLetters,boundaries,diaryFacts,diaryCalendars,decisions } from '../src/db/schema.ts';
import { scanDailyDiaries, dailyDiaryInput, reviewDailyDraft, reflectionText } from '../src/agent/daily-diary.ts';
import { registerSession, putState } from '../src/world/service.ts';
import { snapshotSchema } from '../src/world/protocol.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { closeQueues } from '../src/queue.ts';
import { executeJob } from '../src/jobs/store.ts';
import { cancelTicket } from '../src/agent/tickets.ts';
let catId:string,convId:string,userId:string,token:string;
const accounts:string[]=[];
const at=new Date('2026-11-13T00:05:00Z');
beforeEach(async()=>{
 token=randomUUID();const [u]=await db.insert(users).values({timeZone:'UTC',devTokenHash:hashToken(token)}).returning();userId=u!.id;accounts.push(userId);
 const [c]=await db.insert(cats).values({userId,name:'团子',appearance:'orange',temperament:'slow',traits:{energy:1,initiative:1,directness:1,closeness:1},createdAt:new Date('2026-11-10T04:00Z')}).returning();catId=c!.id;
 const [v]=await db.insert(conversations).values({catId}).returning();convId=v!.id;
});
afterAll(async()=>{
 for(const id of accounts){await sql`delete from async_jobs where source_id in (select t.id from triggers t join cats c on c.id=t.cat_id where c.user_id=${id})`;await db.delete(users).where(eq(users.id,id));}
 await closeQueues();await sql.end();
});
it('日历保存扫描进度，空闲时跳过；积压超过32天后可继续补齐', async () => {
  const later = new Date('2026-12-22T01:00:00Z');
  await scan(later);
  expect(await events()).toHaveLength(32);
  await scan(later);
  expect(await events()).toHaveLength(42);
  const [calendar] = await sql`select next_day, next_scan_at from diary_calendars where cat_id = ${catId}`;
  expect(calendar!.next_day).toBe('2026-12-22');
  expect(new Date(calendar!.next_scan_at).toISOString()).toBe('2026-12-23T00:05:00.000Z');
});
const entries=()=>db.select().from(diaryEntries).where(eq(diaryEntries.catId,catId));
const events=()=>db.select().from(triggers).where(and(eq(triggers.catId,catId),eq(triggers.source,'clock')));
const scan=(date=at)=>scanDailyDiaries(date,catId);
const run=async(options:Parameters<typeof processDailyDiary>[1]={})=>{for(const e of await events())await processDailyDiary(e.id,options);};
const request=(method='GET',body?:unknown,auth=token)=>app.request('/v1/diary',{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
const message=async(text='面试说起过',extra:Record<string,unknown>={})=>(await db.insert(messages).values({conversationId:convId,role:'user',text,createdAt:new Date('2026-11-12T12:00Z'),...extra}).returning())[0]!;
it('不开App跨三天各一篇，00:05前不提前写，重复扫描/并发投递不重且无聊天/普通来信/推送',async()=>{
 await scan(new Date('2026-11-11T00:04:59Z'));expect(await events()).toHaveLength(0);
 await scan();await scan();expect(await events()).toHaveLength(3);
 await Promise.all([run(),run()]);await run();expect((await entries()).map(d=>d.day).sort()).toEqual(['2026-11-10','2026-11-11','2026-11-12']);
 expect(await db.select().from(messages).where(eq(messages.conversationId,convId))).toHaveLength(0);
 expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,catId))).toHaveLength(0);
 const receipts=await db.select().from(outbox).where(eq(outbox.catId,catId));expect(receipts).toHaveLength(3);expect(receipts.every(r=>r.kind==='mailbox_letter'&&r.status==='sent')).toBe(true);
});
it('发布后进程退出重启重放，不改写已有正文或重复收据',async()=>{
 await scan();const id=(await events())[0]!.id;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {processDailyDiary} from './src/agent/daily-diary.ts';await processDailyDiary('${id}');process.exit(0);`],{env:{...process.env,MODEL_PROVIDER:'mock'},stdio:'pipe'});
 expect((await once(child,'exit'))[0]).toBe(0);await deliverReports(id);const before=await entries();expect(before).toHaveLength(1);await processDailyDiary(id,{write:async()=>{throw new Error('must not rewrite');}});expect(await entries()).toEqual(before);
});
it('生成中进程被杀，PG待办租约恢复后仅一次发布',async()=>{
 await scan();const id=(await events())[0]!.id;
 const code=`import {processDailyDiary} from './src/agent/daily-diary.ts';await processDailyDiary('${id}',{beforePublish:async()=>{process.stdout.write('DRAFT\\n');await new Promise(()=>{});}});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,MODEL_PROVIDER:'mock'},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('no draft'));},15000);child.stdout.on('data',d=>{if(String(d).includes('DRAFT')){clearTimeout(timer);resolve();}});});child.kill('SIGKILL');await once(child,'exit');
 expect(await entries()).toHaveLength(0);await processDailyDiary(id);await processDailyDiary(id);expect(await entries()).toHaveLength(1);
},25000);
it('时区西行同日期不重，东行跳过的完整日期补齐，不复制当前snapshot',async()=>{
 await scan();await run();await db.update(users).set({timeZone:'Pacific/Honolulu'}).where(eq(users.id,userId));await scan();await run();expect(await entries()).toHaveLength(3);
 await db.update(users).set({timeZone:'Pacific/Kiritimati'}).where(eq(users.id,userId));await scan(new Date('2026-11-14T11:00Z'));await run();expect((await entries()).map(e=>e.day).sort()).toEqual(['2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14']);
});
it('历史真实观察经鉴权世界上报保存，重复上报与换session不丢不增；忽略不可信天气与累计轨迹',async()=>{
 const session=await registerSession(catId);const snap=snapshotSchema.parse({stateVersion:1,sceneVersion:4,destinationIds:['house'],currentDestinationId:'house',targetDestinationId:'house',phase:'idle',action:'rest',activity:'rest',paused:false,runnable:true,weather:'rain',placesToday:['假的历史']});
 await putState(catId,session.sessionId,session.generation,snap);await putState(catId,session.sessionId,session.generation,snap);await registerSession(catId);
 const facts=await db.select().from(diaryFacts).where(eq(diaryFacts.catId,catId));expect(facts).toHaveLength(1);expect(JSON.stringify(facts)).not.toMatch(/假的历史|rain/);
});
it('只取目标日许可原话，不取别日/撤回/边界/记忆关闭消息；来源id与文本供出口复核',async()=>{
 const good=await message('今天读书');await message('撤回的秘密',{contextAllowed:false});await message('别日的消息',{createdAt:new Date('2026-11-14T12:00Z')});
 await scan();const t=(await db.select().from(tickets).where(and(eq(tickets.catId,catId),eq(tickets.localDay,'2026-11-12'))))[0]!;
 let input=await dailyDiaryInput(t.id);expect(JSON.stringify(input)).toContain('今天读书');expect(JSON.stringify(input)).not.toMatch(/撤回的秘密|别日的消息/);expect(input!.facts.some(f=>f.sourceId===good.id)).toBe(true);
 await db.insert(boundaries).values({catId,sourceMessageId:good.id,description:'读书'});input=await dailyDiaryInput(t.id);expect(input!.facts).toHaveLength(0);
 await db.update(cats).set({useMemories:false}).where(eq(cats.id,catId));input=await dailyDiaryInput(t.id);expect(input!.facts).toHaveLength(0);
});
it.each(['source','permission','revision','version','boundary'] as const)('发布前%s变化，旧候选不能出版；重取后仍能完成当日日记',async(kind)=>{
 const m=await message('面试很顺利');await scan();const e=(await events()).find(e=>e.payload.local_day==='2026-11-12')!;let once=false;
 await processDailyDiary(e.id,{write:async input=>({reflection:reflectionText.quiet,fact_ids:input.facts.map(f=>f.id)}),beforePublish:async()=>{
 if(once)return;once=true;
 if(kind==='source')await db.update(messages).set({contextAllowed:false}).where(eq(messages.id,m.id));
 if(kind==='permission')await db.update(cats).set({useMemories:false}).where(eq(cats.id,catId));
 if(kind==='revision')await db.update(cats).set({memoryRevision:1}).where(eq(cats.id,catId));
 if(kind==='version')await db.update(conversations).set({version:1}).where(eq(conversations.id,convId));
 if(kind==='boundary')await db.insert(boundaries).values({catId,sourceMessageId:m.id,description:'面试'});
 }});
 await processDailyDiary(e.id);expect(await entries()).toHaveLength(1);if(['source','permission','boundary'].includes(kind))expect((await entries())[0]!.text).not.toContain('面试');
});
it('用户无记录/模型和Router故障也完成，fallback不编造外部事实或共同经历',async()=>{
 await scan();await run({route:async()=>{throw new Error('offline');},write:async()=>{throw new Error('offline');}});expect(await entries()).toHaveLength(3);
 for(const d of await entries()){expect(d.text.length).toBeGreaterThan(10);expect(d.text).not.toMatch(/你|一起|倒水|聊|下雨|晴|来过|去过|今天在/);expect(d.text.length).toBeLessThanOrEqual(600);}
});
it('固定反例：任意正文/杜撰共同经历/天气/外猫来源/未知事实id均不能穿过结构与渲染',async()=>{
 await scan();const t=(await db.select().from(tickets).where(eq(tickets.catId,catId)))[0]!;const input=(await dailyDiaryInput(t.id))!;
 for(const text of ['你今天来过','我们一起倒水','今天聊得很开心','雨下了一天','你没有来看我','刚在池塘玩过'])expect(()=>reviewDailyDraft({text,reflection:'quiet',fact_ids:[]},input)).toThrow();
 expect(()=>reviewDailyDraft({reflection:'quiet',fact_ids:[randomUUID()]},input)).toThrow();expect(()=>reviewDailyDraft({reflection:'quiet',fact_ids:[],text:'外猫秘密'},input)).toThrow();
});
it('模型可写新的内心短记，不能把无来源的共同经历或具体外部事实写进感受段',async()=>{
 await scan();const t=(await db.select().from(tickets).where(eq(tickets.catId,catId)))[0]!;const input=(await dailyDiaryInput(t.id))!;
 const reflection='有些小念头，不必急着弄明白。我想把心里的柔软留在这一页，慢慢想。';
 expect(reviewDailyDraft({reflection,fact_ids:[]},input)).toBe(reflection);
 for(const text of ['你今天来过','我们一起倒水','今天聊得很开心','雨下了一天','你没有来看我','刚在池塘玩过','我刚喝完水','我在树边睡了一觉','Alice陪我玩','周五见面'])expect(()=>reviewDailyDraft({reflection:text,fact_ids:[]},input),text).toThrow();
});
it('真实HTTP同步保护服务端猫日记；旧客户端cat导入保留只读，同日重开返回当前条；文本小记隔离',async()=>{
 await scan();await run();const d=(await entries())[0]!;
 const body={client_id:d.clientId,kind:'cat',text:'任意改写',recorded_at:d.recordedAt.toISOString(),time_zone:d.timeZone,day:d.day,time:d.time,cat_allowed:false,revision:d.revision,mutation_id:randomUUID()};
 expect((await request('PUT',body)).status).toBe(409);expect((await request('PUT',{...body,client_id:'another',revision:0})).status).toBe(409);
 expect((await request('PUT',{...body,kind:'text'})).status).toBe(409);
 expect((await request('PUT',{...body,client_id:'note',kind:'text',revision:0})).status).toBe(200);
 const legacy={...body,client_id:'legacy-cat',day:'2026-11-01',recorded_at:'2026-11-01T12:00:00Z',time:'12:00',revision:0};expect((await request('PUT',legacy)).status).toBe(200);expect((await request('PUT',{...legacy,text:'改旧记录',revision:1,mutation_id:randomUUID()})).status).toBe(409);
 const page=await(await request()).json();expect(page.entries.filter((e:any)=>e.kind==='cat')).toHaveLength(4);expect((await request('GET',undefined,randomUUID())).status).toBe(401);
});

it('出口连日常兜底也避开不要再提，已发布依赖有hash可核对，事项不暴露取消',async()=>{
 const m=await message('不要再提安静');await db.insert(boundaries).values({catId,sourceMessageId:m.id,description:'安静'});await scan();await run();
 expect((await entries()).every(d=>!d.text.includes('安静'))).toBe(true);
 const t=(await db.select().from(tickets).where(eq(tickets.catId,catId)))[0]!;await expect(cancelTicket(catId,t.id)).rejects.toThrow();
 const proofs=await db.select().from(decisions).where(eq(decisions.ticketId,t.id));expect(JSON.stringify(proofs)).toContain('input_hash');
});
it('PG待办超过3次租约失效仍恢复；一天一个任务；跨DST日期边界正确',async()=>{
 await scan();const e=(await events())[0]!;const [job]=await db.select().from(asyncJobs).where(eq(asyncJobs.sourceId,e.id));
 await db.update(asyncJobs).set({state:'running',attempts:9,leaseUntil:new Date(0)}).where(eq(asyncJobs.id,job!.id));
 await executeJob(job!.id,j=>processDailyDiary(j.objectId));expect((await entries())).toHaveLength(1);
 expect((await db.select().from(asyncJobs).where(eq(asyncJobs.id,job!.id)))[0]!.state).toBe('done');
 const {dayStart}=await import('../src/agent/daily-diary.ts');expect(+dayStart('2026-03-09','America/Los_Angeles')-+dayStart('2026-03-08','America/Los_Angeles')).toBe(23*3600000);
 expect(+dayStart('2026-11-02','America/Los_Angeles')-+dayStart('2026-11-01','America/Los_Angeles')).toBe(25*3600000);
});
