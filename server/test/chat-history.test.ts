import { scriptedClient } from '../src/llm/testing.ts';
import { emptyUsage } from '../src/llm/index.ts';
import { runCatAgent } from '../src/runtime/agent.ts';
import { catTools } from '../src/runtime/tools.ts';
import { withdrawSources } from '../src/memory/control.ts';
import { randomUUID } from 'node:crypto';
import { afterAll,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db,sql } from '../src/db/client.ts';
import { cats,conversations,messages,users,turns,boundaries } from '../src/db/schema.ts';
import { historyTools } from '../src/runtime/chat-history.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
it('历史消息参数只接受整数，非法值回退默认值',async()=>{
 const token=randomUUID();
 const [u]=await db.insert(users).values({name:'history-params-test',devTokenHash:hashToken(token)}).returning();
 try{
  const [c]=await db.insert(cats).values({userId:u!.id,name:'团子',appearance:'orange',temperament:'slow',traits:{energy:1,initiative:1,directness:1,closeness:1}}).returning();
  const [conv]=await db.insert(conversations).values({catId:c!.id}).returning();
  const request=(query:string)=>app.request('/v1/messages'+query,{headers:{authorization:'Bearer '+token}});
  expect(await (await request('?limit=abc&after=abc&before=abc')).json()).toEqual({messages:[]});
  const rows=await db.insert(messages).values(Array.from({length:55},(_,i)=>({conversationId:conv!.id,role:'user' as const,text:String(i)}))).returning();
  const expected=rows.slice(-50).map(m=>m.id);
  for(const query of ['', '?limit=abc&after=abc&before=abc','?limit=1.5&after=1.5&before=1.5','?limit=Infinity&after=Infinity&before=Infinity']){
   const response=await request(query);expect(response.status).toBe(200);
   expect((await response.json()).messages.map((m:any)=>m.id)).toEqual(expected);
  }
  const response=await request('?limit=2&after='+rows[0]!.seq+'&before='+rows[3]!.seq);
  expect((await response.json()).messages.map((m:any)=>m.id)).toEqual(rows.slice(1,3).map(m=>m.id));
 }finally{await db.delete(users).where(eq(users.id,u!.id));}
});
it('中文旧原话按字面搜索、展开，隔离未来和跨猫，来源先登记',async()=>{
 const [u]=await db.insert(users).values({name:'history-test'}).returning();
 const [otherUser]=await db.insert(users).values({name:'foreign-history-test'}).returning();
 try{
 const [c]=await db.insert(cats).values({userId:u!.id,name:'团子',appearance:'orange',temperament:'slow',traits:{energy:1,initiative:1,directness:1,closeness:1}}).returning();
 const [conv]=await db.insert(conversations).values({catId:c!.id}).returning();
 const [old]=await db.insert(messages).values({conversationId:conv!.id,role:'user',text:'旧事：桂花100%_茶'}).returning();
 const longRows=await db.insert(messages).values(Array.from({length:7},()=>({conversationId:conv!.id,role:'user' as const,text:'长原话🙂'.repeat(1500)}))).returning();
 await db.insert(messages).values({conversationId:conv!.id,role:'user',text:'别的100AB茶'});
 await db.insert(messages).values(Array.from({length:31},()=>({conversationId:conv!.id,role:'user' as const,text:'填充'})));
 await db.insert(messages).values([{conversationId:conv!.id,role:'cat',text:'桂花 猫自己编的'}, {conversationId:conv!.id,role:'user',text:'桂花 日记隐私',diaryEntryId:randomUUID()}]);
 const [anchor]=await db.insert(messages).values({conversationId:conv!.id,role:'user',text:'找旧事'}).returning();
 const [future]=await db.insert(messages).values({conversationId:conv!.id,role:'user',text:'桂花100%_未来'}).returning();
 const [recentSource]=await db.insert(messages).values({conversationId:conv!.id,role:'user',text:'预算裁剪的近期原话'}).returning();
 const [newAnchor]=await db.insert(messages).values({conversationId:conv!.id,role:'user',text:'查回近期'}).returning();
 const ids:string[]=[]; const tools=await historyTools({catId:c!.id,anchorId:anchor!.id,register:async sources=>{ids.push(...sources);}});
 const signal=new AbortController().signal;
 const result:any=await tools.search_chat_history!.execute({query:'桂花100%_'},signal);
 expect(result.data.messages.map((m:any)=>m.id)).toEqual([old!.id]); expect(ids).toContain(old!.id);
 const recentTools=await historyTools({catId:c!.id,anchorId:newAnchor!.id,register:async()=>{}});
 const bounded:any=await tools.search_chat_history!.execute({query:'长原话'},signal);
 expect(bounded.data.messages).toHaveLength(5);
 expect(bounded.data.messages.every((m:any)=>m.truncated&&Buffer.byteLength(m.text)<=800&&m.timeZone&&m.date&&m.role==='user')).toBe(true);
 const expanded:any=await tools.read_chat_history!.execute({messageIds:longRows.slice(0,6).map(m=>m.id)},signal);
 expect(expanded.data.messages.length).toBeLessThanOrEqual(6);
 expect(expanded.data.messages.reduce((n:number,m:any)=>n+Buffer.byteLength(m.text),0)).toBeLessThanOrEqual(12000);
 const tail='开头🙂'.repeat(300)+'尾部独特关键词与答案';
 await db.update(messages).set({text:tail}).where(eq(messages.id,longRows[0]!.id));
 const tailHit:any=await tools.search_chat_history!.execute({query:'尾部独特关键词'},signal);
 expect(tailHit.data.messages[0].text).toContain('尾部独特关键词与答案');
 expect(tailHit.data.messages[0].offset).toBeGreaterThan(0);
 let offset=0,reconstructed='';
 while(true){
  const page:any=await tools.read_chat_history!.execute({messageIds:[longRows[0]!.id],offset},signal);
  const chunk=page.data.messages[0];expect(chunk.offset).toBe(offset);
  reconstructed+=chunk.text;
  if(chunk.nextOffset===null)break;
  expect(chunk.nextOffset).toBeGreaterThan(offset);offset=chunk.nextOffset;
 }
 expect(reconstructed).toBe(tail);
 expect((await recentTools.search_chat_history!.execute({query:'预算裁剪的近期'},signal)).data).toMatchObject({messages:[{id:recentSource!.id}]});

 expect(expanded.data.messages.every((m:any)=>Buffer.byteLength(m.text)<=2400&&!m.text.includes('�'))).toBe(true);
 expect((await tools.search_chat_history!.execute({query:'100%_'},signal)).data).toMatchObject({messages:[{id:old!.id}]});
 const invalid=await historyTools({catId:c!.id,anchorId:randomUUID(),register:async()=>{throw new Error('不可登记');}});
 await expect(invalid.search_chat_history!.execute({query:'桂花'},signal)).rejects.toThrow('history_anchor_unavailable');
 const aborted=new AbortController();aborted.abort(new Error('取消历史读取'));
 await expect(tools.search_chat_history!.execute({query:'桂花'},aborted.signal)).rejects.toThrow('取消历史读取');
 const read:any=await tools.read_chat_history!.execute({messageIds:[old!.id,future!.id]},signal);
 expect(read.data.messages.map((m:any)=>m.id)).toEqual([old!.id]);

 await db.update(cats).set({learnMemories:false}).where(eq(cats.id,c!.id));
 expect((await tools.search_chat_history!.execute({query:'桂花'},signal)).data).toMatchObject({messages:[{id:old!.id}]});
 expect((await tools.search_chat_history!.execute({query:'不存在'},signal)).data).toMatchObject({messages:[]});
 await expect(tools.search_chat_history!.execute({query:'长'.repeat(121)},signal)).rejects.toThrow();
 const [otherCat]=await db.insert(cats).values({userId:otherUser!.id,name:'另一猫',appearance:'orange',temperament:'slow',traits:{energy:1,initiative:1,directness:1,closeness:1}}).returning();
 const [otherConv]=await db.insert(conversations).values({catId:otherCat!.id}).returning();
 const [foreign]=await db.insert(messages).values({conversationId:otherConv!.id,role:'user',text:'桂花跨猫秘密'}).returning();
 const otherId=foreign!.id;
 expect((await tools.read_chat_history!.execute({messageIds:[otherId]},signal)).data).toMatchObject({messages:[]});
 const [turn]=await db.insert(turns).values({conversationId:conv!.id,userMessageId:anchor!.id,inputVersion:0,status:'generating',contextRevision:0,contextSourceIds:[anchor!.id]}).returning();
 const frontend=await catTools({catId:c!.id,turnId:turn!.id,userMessageId:anchor!.id});
 let requests=0;let answer='';
 const model=scriptedClient(async request=>{
 requests++;
 if(requests>1){expect(JSON.stringify(request.messages)).toContain(old!.id);expect((await db.select().from(turns).where(eq(turns.id,turn!.id)))[0]!.contextSourceIds).toContain(old!.id);}
 const calls=requests<3;
 const input=requests===1?{query:'桂花100%_'}:{messageIds:[old!.id]};
 return [
 ...(calls?[{type:'tool-call' as const,toolCallId:'history-'+requests,toolName:requests===1?'search_chat_history':'read_chat_history',input,rawInput:JSON.stringify(input)}]:[{type:'text-delta' as const,delta:'桂花100%_茶'}]),
 {type:'finish' as const,finishReason:calls?'tool-calls':'stop',usage:{...emptyUsage(),inputTokens:10,outputTokens:3}}
 ];
 });
 await runCatAgent({client:model,instructions:'只根据原话回答',messages:[{role:'user',content:'请找那杯茶'}],tools:frontend,signal,guard:async()=>{},onText:async t=>{answer+=t;},onTool:async()=>{},onStep:async()=>{}});
 expect(requests).toBe(3);expect(answer).toBe('桂花100%_茶');
 expect((await db.select().from(turns).where(eq(turns.id,turn!.id)))[0]!.contextSourceIds).toContain(old!.id);
 const [reply]=await db.insert(messages).values({conversationId:conv!.id,role:'cat',text:'派生猫回复',turnId:turn!.id}).returning();
 await db.update(turns).set({catMessageId:reply!.id,status:'completed'}).where(eq(turns.id,turn!.id));
 await db.transaction(tx=>withdrawSources(tx,c!.id,[old!.id]));
 expect((await db.select().from(messages).where(eq(messages.id,reply!.id)))[0]!.contextAllowed).toBe(false);
 expect((await tools.search_chat_history!.execute({query:'桂花'},signal)).data).toMatchObject({messages:[]});
 await db.update(messages).set({contextAllowed:true}).where(eq(messages.id,old!.id));
 await db.insert(boundaries).values({catId:c!.id,sourceMessageId:old!.id,description:'桂花'});
 expect((await tools.read_chat_history!.execute({messageIds:[old!.id]},signal)).data).toMatchObject({messages:[]});
 await db.update(cats).set({useMemories:false}).where(eq(cats.id,c!.id));
 expect((await tools.search_chat_history!.execute({query:'桂花'},signal)).data).toMatchObject({messages:[],available:false,reason:'memory_use_disabled'});
 }finally{await db.delete(users).where(eq(users.id,u!.id));await db.delete(users).where(eq(users.id,otherUser!.id));}
});
afterAll(()=>sql.end());
