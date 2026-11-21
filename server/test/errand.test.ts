import { withdrawSources } from '../src/memory/control.ts';
import { scriptedClient } from '../src/llm/testing.ts';
import { emptyUsage, SUMMARY_INSTRUCTIONS } from '../src/llm/index.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users,cats,conversations,messages,tickets,ticketInputs,runs,runSteps,outbox,mailboxLetters,asyncJobs,diaryEntries,boundaries,modelCalls } from '../src/db/schema.ts';
import { startErrand, appendTicketInput, scanErrands } from '../src/agent/errands.ts';
import { errandRetryable } from '../src/agent/executor.ts';
import { processErrand, deliverReports } from './report-pipeline.ts';
import { cancelTicket } from '../src/agent/tickets.ts';
import { mockWorkerModel } from '../src/runtime/mock.ts';
import { catTools } from '../src/runtime/tools.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { closeQueues } from '../src/queue.ts';
const now=new Date('2026-11-12T04:00:00Z');
let catId:string,convId:string,sourceId:string,userId:string,token:string;
const ids:string[]=[];
beforeEach(async()=>{
 token=randomUUID(); const [u]=await db.insert(users).values({devTokenHash:hashToken(token)}).returning();userId=u!.id;ids.push(userId);
 const [c]=await db.insert(cats).values({userId,name:'团子',appearance:'orange',temperament:'slow',traits:{energy:1,initiative:1,directness:1,closeness:1}}).returning();catId=c!.id;
 const [v]=await db.insert(conversations).values({catId}).returning();convId=v!.id;
 const [m]=await db.insert(messages).values({conversationId:convId,role:'user',text:'帮我想想周末怎么过，想好了告诉我'}).returning();sourceId=m!.id;
});
afterAll(async()=>{
 for(const id of ids){await sql`delete from async_jobs where object_id in(select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id})`;await db.delete(users).where(eq(users.id,id));}
 await closeQueues();await sql.end();
});
const create=(goal='想想周末怎么过',at=now)=>startErrand(catId,sourceId,goal,at);
const runFor=async(id:string)=>(await db.select().from(runs).where(eq(runs.ticketId,id)))[0]!;
const ticket=async(id:string)=>(await db.select().from(tickets).where(eq(tickets.id,id)))[0]!;
const said=()=>db.select().from(messages).where(and(eq(messages.conversationId,convId),eq(messages.role,'cat')));
const letters=()=>db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,catId));
const execute=async(id:string,options:Parameters<typeof processErrand>[1]={})=>processErrand((await runFor(id)).id,{now:()=>now,...options});
const request=(path:string,method='GET',body?:unknown)=>app.request('/v1'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
it('保存凭证、同次工具重放幂等、queued预算；聊天白名单与托付更新',async()=>{
 const t=await create();expect(t.queued).toBe(false);expect((await create()).ticket_id).toBe(t.ticket_id);
 const tools=await catTools({catId,turnId:randomUUID(),userMessageId:sourceId});expect(tools.start_errand).toBeDefined();
 await create('另一件');const third=await create('第三件');expect(third.queued).toBe(true);expect((await ticket(third.ticket_id)).stage).toBe('queued');
 expect((await db.select().from(asyncJobs).where(eq(asyncJobs.objectId,(await runFor(t.ticket_id)).id))).length).toBe(1);
});
it('每日最多五件按用户自然日；排队次日和空位才能开工',async()=>{
 await db.update(users).set({timeZone:'America/Los_Angeles'}).where(eq(users.id,userId));
 const at=new Date('2026-11-12T07:55:00Z');const all=[];
 for(let i=0;i<6;i++){const r=await create('托付'+i,at);all.push(r);if(i<5)await db.update(tickets).set({status:'ended',stage:'ready'}).where(eq(tickets.id,r.ticket_id));}
 expect(all[5]!.queued).toBe(true);await scanErrands(at,catId);expect((await ticket(all[5]!.ticket_id)).stage).toBe('queued');
 await scanErrands(new Date('2026-11-12T08:05:00Z'),catId);expect((await ticket(all[5]!.ticket_id)).stage).toBe('thinking');
});
it('ready只经出口写信与一句话、去重且不污染轮次/version',async()=>{
 const t=await create();await execute(t.ticket_id);await execute(t.ticket_id);
 expect(await letters()).toHaveLength(1);expect(await said()).toHaveLength(1);expect((await said())[0]).toMatchObject({ticketId:t.ticket_id,turnId:null});
 expect((await said())[0]!.text).not.toBe((await letters())[0]!.text);
 expect((await db.select().from(conversations).where(eq(conversations.id,convId)))[0]!.version).toBe(0);
 expect((await ticket(t.ticket_id)).stage).toBe('ready');
 expect(await db.select().from(modelCalls).where(and(eq(modelCalls.purpose,'errand'),eq(modelCalls.jobId,(await runFor(t.ticket_id)).id)))).toHaveLength(2);
 expect((await db.select().from(runSteps).where(eq(runSteps.runId,(await runFor(t.ticket_id)).id))).length).toBeGreaterThan(0);
});
it('第N完整步杀进程，租约过期新进程从检查点恢复且不重复report',async()=>{
 const t=await create();const r=await runFor(t.ticket_id);
 const code=`import {processErrand} from './src/agent/executor.ts';await processErrand(${JSON.stringify(r.id)},{now:()=>new Date(${JSON.stringify(now.toISOString())}),afterStep:async()=>{process.stdout.write('CHECKPOINT\\n');await new Promise(()=>{});}});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,MODEL_PROVIDER:'mock'},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('no checkpoint'));},15000);child.stdout.on('data',d=>{if(String(d).includes('CHECKPOINT')){clearTimeout(timer);resolve();}});child.on('error',reject);});
 child.kill('SIGKILL');await once(child,'exit');expect((await db.select().from(runSteps).where(eq(runSteps.runId,r.id)))).toHaveLength(1);
 await db.update(runs).set({leaseUntil:new Date(0)}).where(eq(runs.id,r.id));
 const code2=`import {processErrand} from './src/agent/executor.ts';await processErrand(${JSON.stringify(r.id)},{now:()=>new Date(${JSON.stringify(now.toISOString())})});process.exit(0);`;
 const second=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code2],{env:{...process.env,MODEL_PROVIDER:'mock'},stdio:'pipe'});expect((await once(second,'exit'))[0]).toBe(0);
 await deliverReports(r.id,now);const final=await runFor(t.ticket_id);expect(final.attempt).toBe(2);expect(Object.keys(final.report.calls)).toHaveLength(2);expect(await letters()).toHaveLength(1);
},25000);
it('同一事项只允许一个执行者running',async()=>{
 const t=await create();let release!:()=>void;const barrier=new Promise<void>(r=>release=r);let entered!:()=>void;const enteredP=new Promise<void>(r=>entered=r);
 const pending=execute(t.ticket_id,{afterStep:async()=>{entered();await barrier;}});await enteredP;
 await execute(t.ticket_id);release();await pending;expect((await runFor(t.ticket_id)).attempt).toBe(1);expect(await letters()).toHaveLength(1);
});
it('执行中取消，结果不发布',async()=>{
 const t=await create();await execute(t.ticket_id,{afterStep:async()=>{await cancelTicket(catId,t.ticket_id);}});expect(await letters()).toHaveLength(0);expect(await said()).toHaveLength(0);expect((await ticket(t.ticket_id)).stage).toBe('cancelled');
});
it('执行中补一句话下一步读到，消费标记与检查点一起保存',async()=>{
 const t=await create();let once=false;
 await execute(t.ticket_id,{afterStep:async()=>{if(!once){once=true;await appendTicketInput(catId,t.ticket_id,'不要太累，我想休息');}}});
 expect((await letters())[0]!.text).toContain('不要太累');expect((await db.select().from(ticketInputs).where(eq(ticketInputs.ticketId,t.ticket_id)))[0]!.readAt).not.toBeNull();
});
it('执行中关记忆，依赖记忆结果不发布；复用许可过滤并记录依赖',async()=>{
 const t=await create('[memory] 周末建议');
 await execute(t.ticket_id,{afterStep:async()=>{await db.update(cats).set({useMemories:false}).where(eq(cats.id,catId));}});
 expect(await letters()).toHaveLength(0);expect(await said()).toHaveLength(0);expect((await ticket(t.ticket_id)).stage).toBe('dropped');
});
it('日记只读cat_allowed，撤回来源或改revision不发布',async()=>{
 const base={catId,kind:'text',recordedAt:now,timeZone:'Asia/Shanghai',day:'2026-11-12',time:'12:00',mutationId:randomUUID()};
 await db.insert(diaryEntries).values({...base,clientId:randomUUID(),text:'私密内容',catAllowed:false});
 const [d]=await db.insert(diaryEntries).values({...base,clientId:randomUUID(),text:'可以给团子看的内容',catAllowed:true}).returning();
 const t=await create('[diary] 周末建议');await execute(t.ticket_id,{afterStep:async()=>{await db.update(diaryEntries).set({catAllowed:false}).where(eq(diaryEntries.id,d!.id));}});
 expect(await letters()).toHaveLength(0);const steps=await db.select().from(runSteps).where(eq(runSteps.runId,(await runFor(t.ticket_id)).id));expect(JSON.stringify(steps)).not.toContain('私密内容');
});
it('waiting问一次，24小时后安静等；补充后唤醒同一run',async()=>{
 const t=await create('[waiting] 周末建议');await execute(t.ticket_id);expect((await ticket(t.ticket_id)).stage).toBe('waiting');expect(await said()).toHaveLength(1);
 await scanErrands(new Date(+now+86400001),catId);expect((await ticket(t.ticket_id)).stage).toBe('quiet_waiting');await execute(t.ticket_id);expect(await said()).toHaveLength(1);
 const id=(await runFor(t.ticket_id)).id;await appendTicketInput(catId,t.ticket_id,'想待在家里');await execute(t.ticket_id);expect((await runFor(t.ticket_id)).id).toBe(id);expect(await letters()).toHaveLength(1);expect((await letters())[0]!.text).toContain('想待在家里');
});
it('安静时段ready和waiting均延至09点；已过24小时的waiting不再问',async()=>{
 const t=await create();await execute(t.ticket_id,{now:()=>new Date('2026-11-12T15:00:00Z')});expect(await said()).toHaveLength(0);expect(await letters()).toHaveLength(0);
 await execute(t.ticket_id,{now:()=>new Date('2026-11-13T01:00:00Z')});expect(await letters()).toHaveLength(1);
 const w=await create('[waiting] 晚上建议');await execute(w.ticket_id,{now:()=>new Date('2026-11-12T15:00:00Z')});expect(await said()).toHaveLength(1);
 await execute(w.ticket_id,{now:()=>new Date('2026-11-13T15:00:01Z')});expect(await said()).toHaveLength(1);expect((await ticket(w.ticket_id)).stage).toBe('quiet_waiting');
});
it.each(['blocked','failed','dropped'] as const)('%s状态如实说明或安静结束',async(status)=>{
 const t=await create(`[${status}] 帮我想想`);await execute(t.ticket_id);expect((await ticket(t.ticket_id)).stage).toBe(status);expect(await said()).toHaveLength(status==='dropped'?0:1);expect(await letters()).toHaveLength(0);
});
it('归属鉴权、列表阶段、PATCH补一句、工具写入、取消托付',async()=>{
 const t=await create();expect((await request('/tickets')).status).toBe(200);expect((await request('/tickets/'+t.ticket_id,'PATCH',{text:'想轻松点'})).status).toBe(200);
 expect((await request('/tickets/'+randomUUID(),'PATCH',{text:'补一句'})).status).toBe(404);
 const other=(await db.select().from(cats).where(eq(cats.userId,ids[0]!)))[0]!;
 await expect(appendTicketInput(other.id,t.ticket_id,'不属于我')).rejects.toThrow();
 const tools=await catTools({catId,turnId:randomUUID(),userMessageId:sourceId});expect((await tools.update_ticket!.execute({ticket_id:t.ticket_id,text:'在家'},new AbortController().signal)).status).toBe('succeeded');
 expect((await request('/tickets/'+t.ticket_id+'/cancel','POST')).status).toBe(200);expect((await request('/tickets')).status).toBe(200);expect((await app.request('/v1/tickets')).status).toBe(401);
});
it('出口检查原话、边界、记忆修订，新鲜度变化重新判断',async()=>{
 const t=await create();let changed=false;await execute(t.ticket_id,{afterStep:async()=>{if(!changed){changed=true;await db.update(conversations).set({version:1}).where(eq(conversations.id,convId));}}});
 await execute(t.ticket_id);expect(await letters()).toHaveLength(1);
 const revoked=await create('另一个周末');await execute(revoked.ticket_id,{afterStep:async()=>{await db.update(messages).set({contextAllowed:false}).where(eq(messages.id,sourceId));}});expect(await letters()).toHaveLength(1);
 await db.update(messages).set({contextAllowed:true}).where(eq(messages.id,sourceId));const b=await create('面试怎么样');await db.insert(boundaries).values({catId,sourceMessageId:sourceId,description:'面试'});await execute(b.ticket_id);expect(await letters()).toHaveLength(1);
});
it('执行者白名单、20步、8000累计输出硬预算；超限如实failed',async()=>{
 const t=await create('[loop] 一直想');await execute(t.ticket_id);const steps=await db.select().from(runSteps).where(eq(runSteps.runId,(await runFor(t.ticket_id)).id));expect(steps.length).toBeLessThanOrEqual(20);expect((await ticket(t.ticket_id)).stage).toBe('failed');
 const big=await create('[output-budget] 很长思考');await execute(big.ticket_id);expect((await ticket(big.ticket_id)).stage).toBe('failed');expect((await runFor(big.ticket_id)).outputTokens).toBeLessThanOrEqual(8000);
 const long=await create('想久一点');let clock=now;await execute(long.ticket_id,{now:()=>clock,afterStep:async()=>{clock=new Date(+now+600001);}});expect((await ticket(long.ticket_id)).stage).toBe('failed');
 const white=await create('[whitelist] 检查工具');await execute(white.ticket_id);expect((await letters())[0]!.text).not.toContain('move_cat');
});
it('供应商仅408/429/5xx和网络错误可重试，重试3次后failed',async()=>{
 expect(errandRetryable({statusCode:408})).toBe(true);expect(errandRetryable({statusCode:429})).toBe(true);expect(errandRetryable({statusCode:503})).toBe(true);
 for(const statusCode of [400,401,402,403,404,422])expect(errandRetryable({statusCode})).toBe(false);expect(errandRetryable(new TypeError('fetch failed'))).toBe(true);expect(errandRetryable(new Error('invalid response'))).toBe(false);
 const t=await create('[retry] 建议');let requests=0;const model=mockWorkerModel({onRequest:()=>{requests++;if(requests<4)throw Object.assign(new Error('rate limited'),{statusCode:429});}});await execute(t.ticket_id,{model,retryDelay:async()=>{}});expect(requests).toBe(5);expect(await letters()).toHaveLength(1);
 const f=await create('失败建议');let failures=0;await execute(f.ticket_id,{model:mockWorkerModel({onRequest:()=>{failures++;throw Object.assign(new Error('bad'),{statusCode:400});}}),retryDelay:async()=>{}});expect(failures).toBe(1);expect((await ticket(f.ticket_id)).stage).toBe('failed');
});

it.each([false,true])('worker搜索展开旧原话与撤回=%s，模型请求有界、来源先登记',async(withdraw)=>{
 await db.update(messages).set({text:'桂花100%_茶'}).where(eq(messages.id,sourceId));
 const old=sourceId;
 await db.insert(messages).values(Array.from({length:32},()=>({conversationId:convId,role:'user' as const,text:'填充'})));
 const [anchor]=await db.insert(messages).values({conversationId:convId,role:'user',text:'请找那杯茶'}).returning();sourceId=anchor!.id;
 const t=await create('找那杯茶');let count=0,summaryCount=0;
 const r=await runFor(t.ticket_id);
 const pair=(id:string,value:string):any[]=>[{role:'assistant',content:[{type:'tool-call',toolCallId:id,toolName:'get_time',input:{}}]},{role:'tool',content:[{type:'tool-result',toolCallId:id,toolName:'get_time',output:{type:'text',value}}]}];
 const checkpoint:any[]=[{role:'user',content:'用户托付：找那杯茶'},...pair('old','历史观察🙂'.repeat(30000)),...pair('new','当前观察')];
 await db.insert(runSteps).values({runId:r.id,step:0,messages:checkpoint,usage:{outputTokens:0}});
 const model=scriptedClient(async request=>{
 if(request.system===SUMMARY_INSTRUCTIONS){summaryCount++;expect(request.stream).toBe(false);return [{type:'text-delta',delta:'早先工具观察已完成。'},{type:'finish',finishReason:'stop',usage:{...emptyUsage(),inputTokens:10,outputTokens:3}}];}
 count++;expect(Buffer.byteLength(JSON.stringify({prompt:request.messages,tools:request.tools}))).toBeLessThan(56*1024);
 expect(JSON.stringify(request.messages)).toContain('找那杯茶');
 if(count>1){expect((await runFor(t.ticket_id)).report.dependencies.messages).toContain(old);expect(JSON.stringify(request.messages)).toContain('桂花100%_茶');}
 const input=count===1?{query:'桂花100%_'}:count===2?{messageIds:[old]}:{status:'ready',result:'桂花100%_茶'};
 return [{type:'tool-call',toolCallId:'history-'+count,toolName:count===1?'search_chat_history':count===2?'read_chat_history':'report',input,rawInput:JSON.stringify(input)},{type:'finish',finishReason:'tool-calls',usage:{...emptyUsage(),inputTokens:10,outputTokens:3}}];
 });
 await execute(t.ticket_id,{model,afterStep:async step=>{if(withdraw&&step===2)await db.transaction(tx=>withdrawSources(tx,catId,[old]));}});
 expect(summaryCount).toBe(1);
 expect((await db.select().from(runSteps).where(and(eq(runSteps.runId,r.id),eq(runSteps.step,0))))[0]!.messages).toEqual(checkpoint);
 if(withdraw){expect(count).toBe(1);expect(await letters()).toHaveLength(0);return;}
 expect(count).toBe(3);expect((await letters())[0]!.text).toBe('桂花100%_茶');
 await execute(t.ticket_id,{model});expect(count).toBe(3);
});

it('思考模式使用auto，模型普通文字不会绕过report直接发布',async()=>{
 const {config}=await import('../src/config.ts');
 const before=config.WORKER_THINKING;config.WORKER_THINKING='enabled';
 try {
 const t=await create('整理一条短建议');const choices:string[]=[];
 const model=scriptedClient(async request=>{
  choices.push(request.toolChoice??'unset');
  if(request.toolChoice!=='auto')throw Object.assign(new Error('Thinking mode does not support this tool_choice'),{statusCode:400});
  const first=choices.length===1;
  return [...(first?[{type:'text-delta' as const,delta:'没有汇报凭证的模型文字不能发给用户'}]:[{type:'tool-call' as const,toolCallId:'thinking-report',toolName:'report',input:{status:'ready',result:'可以在窗边安静待一会儿。'},rawInput:'{}'}]),{type:'finish',finishReason:first?'stop':'tool-calls',usage:{...emptyUsage(),inputTokens:10,outputTokens:3}}];
 });
 await execute(t.ticket_id,{model,afterStep:async()=>{expect(await letters()).toHaveLength(0);expect(await said()).toHaveLength(0);}});
 expect(choices).toEqual(['auto','auto']);
 expect((await ticket(t.ticket_id)).stage).toBe('ready');
 expect((await letters())[0]!.text).toBe('可以在窗边安静待一会儿。');
 expect((await said()).every(m=>!m.text.includes('没有汇报凭证'))).toBe(true);
 } finally {config.WORKER_THINKING=before;}
});
