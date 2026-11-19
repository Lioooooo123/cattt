/** 模拟器→真实Hono→PG完整恢复联调。只替换模型为可控mock，HTTP层仅注入断流/回执丢失。 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { eq, asc } from 'drizzle-orm';
import { app } from '../src/api/app.ts';
import { db, sql } from '../src/db/client.ts';
import { createDevUser } from '../src/dev-user.ts';
import { cats, conversations, messages, turns } from '../src/db/schema.ts';
import { closeQueues } from '../src/queue.ts';
import { drainTurns } from '../src/turns/run.ts';
import { config } from '../src/config.ts';
assert.equal(config.MODEL_PROVIDER, 'mock');
assert.ok(config.DATABASE_URL.includes('maomao_continuity_e2e_'), '必须使用独立验收库');
const port = 18789;
let mode = ''; let broken = false; let turnId = ''; let hide = false;
let routes: string[] = []; let wire = ''; let conversationId = '';
const sim = (...args: string[]) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const stop = () => { try { sim('terminate','booted','com.maomao.app'); } catch {} };
async function until<T>(fn: () => Promise<T | undefined>, label: string, ms=30000): Promise<T> {
  const end=Date.now()+ms;
  while(Date.now()<end) { const result=await fn(); if(result!==undefined) return result; await sleep(150); }
  throw Error('等待超时：'+label);
}
async function terminal() {
  return until(async()=> { const [t]=await db.select().from(turns).where(eq(turns.id,turnId)); return t && ['completed','failed','stopped','superseded'].includes(t.status)?t:undefined; },'服务端终态');
}
const server=serve({hostname:'127.0.0.1',port,fetch:async(req)=>{
  const path=new URL(req.url).pathname; routes.push(req.method+' '+path);
  if(mode==='expired' && broken && path.endsWith('/stream')) {
    await terminal();
    await sql`delete from turn_events where turn_id=${turnId}`;
    assert.equal((await sql`select 1 from turn_events where turn_id=${turnId}`).length,0);
  }
  const response=await app.fetch(req);
  if(!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) return response;
  const reader=response.body.getReader(); const decoder=new TextDecoder();
  const body=new ReadableStream<Uint8Array>({async start(controller){
    try {
      while(true) {
        const {value,done}=await reader.read(); if(done)break;
        const text=decoder.decode(value,{stream:true}); wire+=text;
        const match=wire.match(/"turn_id":"([^"]+)"/); if(match)turnId=match[1]!;
        if(hide) continue;
        controller.enqueue(value);
        if(['disconnect','expired'].includes(mode) && !broken && text.includes('event: delta')) {
          broken=true; controller.close(); await reader.cancel(); return;
        }
      }
      controller.close();
    } catch(error) { try { controller.error(error); } catch {} }
  },cancel(){void reader.cancel();}});
  return new Response(body,{status:response.status,headers:response.headers});
}});
const docs=sim('get_app_container','booted','com.maomao.app','data')+'/Documents';
type Snapshot={ids:string[];texts:string[];states:string[];sequences:number[];waiting:boolean;streaming:boolean;hasEarlier:boolean};
async function snapshot(label:string,since:number) {
  return until(async()=>{try{const p=`${docs}/history-${label}.json`; if(statSync(p).mtimeMs>=since)return JSON.parse(readFileSync(p,'utf8')) as Snapshot;}catch{}return undefined;},label);
}
function launch(token:string,script:string){
  sim('launch','booted','com.maomao.app','-backendMode','local','-backendURL',`http://127.0.0.1:${port}`,'-backendToken',token,'-script',script);
}
const results:object[]=[];
const scenarios = process.env.E2E_SCENARIOS?.split(',') ?? ['normal','disconnect','restart','completed','expired','unaccepted','reply','stopped','failed','superseded','history'];
try {
  for(const name of scenarios) {
    stop(); mode=name;broken=false;turnId='';wire='';routes=[];hide=name==='unaccepted';
    const user=await createDevUser('continuity-e2e-'+name);
    const [cat]=await db.select().from(cats).where(eq(cats.userId,user.userId));
    const [conv]=await db.select().from(conversations).where(eq(conversations.catId,cat!.id));conversationId=conv!.id;
    let command='send:联调'+name+'[slow]';
    if(name==='failed') command='send:联调失败[fail]';
    if(name==='reply') {
      const [msg]=await db.insert(messages).values({conversationId,role:'user',text:'重答联调[slow]'}).returning();
      command='recoveryReply:'+msg!.id;hide=true;
    }
    if(name==='superseded') {
      const started=Date.now();
      launch(user.token,'500:screen:chat;1100:send:第一句[slow];1200:send:补充一句[slow];13000:historySnapshot:e2e-superseded');
      const actual=await snapshot('e2e-superseded',started);
      const stored=await db.select().from(messages).where(eq(messages.conversationId,conversationId)).orderBy(asc(messages.seq));
      const rounds=await db.select().from(turns).where(eq(turns.conversationId,conversationId));
      assert.deepEqual(rounds.map(t=>t.status).sort(),['completed','superseded']);
      assert.deepEqual(actual.ids,stored.map(x=>x.id));assert.deepEqual(actual.texts,stored.map(x=>x.text));
      assert.equal(actual.waiting,false);assert.equal(actual.streaming,false);
      results.push({scenario:name,turns:2,messages:stored.length,passed:true});console.log('PASS '+name);continue;
    }
    if(name==='history') {
      await db.insert(messages).values(Array.from({length:125},(_,i)=>({conversationId,role:i%2?'cat' as const:'user' as const,text:'联调历史'+(i+1)})));
      const started=Date.now();launch(user.token,'500:screen:chat;1500:historyEarlier;2500:historyEarlier;3500:historySnapshot:e2e-history');
      const actual=await snapshot('e2e-history',started);
      const stored=await db.select().from(messages).where(eq(messages.conversationId,conversationId)).orderBy(asc(messages.seq));
      assert.deepEqual(actual.ids,stored.map(x=>x.id));assert.equal(actual.hasEarlier,false);
      results.push({scenario:name,messages:actual.ids.length,passed:true});console.log('PASS '+name);continue;
    }
    let started=Date.now();
    launch(user.token,`500:screen:chat;1100:${command};2300:historySnapshot:e2e-before;${name==='stopped'?'2800:stop;':''}13000:historySnapshot:e2e-final`);
    const before=await snapshot('e2e-before',started);
    await until(async()=>turnId || undefined,'accepted');
    if(['restart','completed','unaccepted','reply'].includes(name)) {
      if(name==='restart') assert.equal(before.streaming,true);
      stop();
      if(['completed','unaccepted','reply'].includes(name))await terminal();
      hide=false;started=Date.now();
      launch(user.token,'500:screen:chat;11000:historySnapshot:e2e-final');
    }
    const actual=await snapshot('e2e-final',started);
    const turn=await terminal();
    const stored=await db.select().from(messages).where(eq(messages.conversationId,conversationId)).orderBy(asc(messages.seq));
    const rounds=await db.select().from(turns).where(eq(turns.conversationId,conversationId));
    assert.equal(rounds.length,1,name+'不能多建轮次');
    assert.equal(actual.waiting,false);assert.equal(actual.streaming,false);
    if(name==='failed') { assert.equal(turn.status,'failed');assert.equal(actual.states.at(-1),'timeout'); }
    else { assert.deepEqual(actual.ids,stored.map(x=>x.id),name+'消息ID');assert.deepEqual(actual.texts,stored.map(x=>x.text),name+'正文'); }
    if(name==='stopped')assert.equal(actual.states.at(-1),'stopped');
    if(['disconnect','expired'].includes(name))assert.ok(routes.some(x=>x.endsWith('/stream')));
    if(name==='expired')assert.ok(wire.includes('event: snapshot'));
    if(name==='completed')assert.equal(routes.filter(x=>x.endsWith('/stream')).length,0);
    if(['unaccepted','reply'].includes(name))assert.equal(routes.filter(x=>x.startsWith('POST /v1/messages')).length,2);
    results.push({scenario:name,turns:rounds.length,messages:stored.length,status:turn.status,snapshot:wire.includes('event: snapshot'),passed:true});
    console.log('PASS '+name);
  }
  writeFileSync(process.env.E2E_REPORT ?? '../outputs/chat-continuity-review/e2e-checks.json',JSON.stringify({date:new Date().toISOString(),model:'mock',transport:'真实Hono HTTP/SSE',database:'独立PostgreSQL',device:'iPhone 17 Pro simulator',results},null,2)+'\n');
} finally {
  stop();server.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
  await drainTurns(20000);await closeQueues();await sql.end();
}
