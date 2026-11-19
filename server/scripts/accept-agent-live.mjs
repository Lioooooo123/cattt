/** 真实供应商验收：只在显式隔离的本机数据库里构造合成资料。 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost','127.0.0.1'].includes(target.hostname) && target.pathname.startsWith('/cattt_live_review_'), '需要本机 cattt_live_review_ 隔离库');
assert(process.env.MODEL_PROVIDER === 'deepseek', '必须使用真实模型，禁止 mock 回退');
const output = resolve(process.env.LIVE_REVIEW_OUTPUT ?? '../outputs/personal-agent-live-review');
mkdirSync(output, { recursive: true });
let activeCase = 'setup';
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('api.deepseek.com') && url.includes('/chat/completions')) {
    const body = typeof init?.body === 'string' ? init.body : '';
    const record = { case: activeCase, at: new Date().toISOString(), bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), body: JSON.parse(body) };
    requests.push(record);
    const response = await originalFetch(input, init);
    record.status = response.status;
    if (!response.ok) { const failure=await response.clone().json().catch(()=>({})); record.providerError=failure.error?.message; }
    return response;
  }
  return originalFetch(input, init);
};
const { db, sql } = await import('../src/db/client.ts');
const { users, cats, conversations, messages, turns, runs, tickets, workerReports, mailboxLetters, modelCalls } = await import('../src/db/schema.ts');
const { runtimeCalls } = await import('../src/db/schema-runtime.ts');
const { eq, asc } = await import('drizzle-orm');
const { config } = await import('../src/config.ts');
const { withModelAccount } = await import('../src/runtime/budget.ts');
const { createSendTurn } = await import('../src/turns/create.ts');
const { drainTurns } = await import('../src/turns/run.ts');
const { lockMemory, withdrawSources, changeSettings } = await import('../src/memory/control.ts');
const { startErrand } = await import('../src/agent/errands.ts');
const { processErrand } = await import('../src/agent/executor.ts');
const { processReport } = await import('../src/agent/reports.ts');
const { closeQueues } = await import('../src/queue.ts');
assert(config.MODEL_PROVIDER === 'deepseek' && config.MAOMAO_DEEPSEEK_API_KEY, '真实供应商配置缺失');

const results = [];
async function fixture(name) {
  const [u] = await db.insert(users).values({ name: '合成验收-' + name, timeZone: 'UTC' }).returning();
  const [c] = await db.insert(cats).values({ userId: u.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 }, learnMemories: false }).returning();
  const [v] = await db.insert(conversations).values({ catId: c.id }).returning();
  return { userId: u.id, catId: c.id, conversationId: v.id };
}
async function source(owner, text) {
  return (await db.insert(messages).values({ conversationId: owner.conversationId, role: 'user', text, createdAt: new Date('2026-11-01T12:00:00Z'), memoryEligible: false }).returning())[0];
}
async function pad(owner, count = 36, long = false) {
  await db.insert(messages).values(Array.from({ length: count }, (_, i) => ({ conversationId: owner.conversationId, role: i % 2 ? 'cat' : 'user', text: long ? ('这一段只是在描述窗外普通的云和风，没有新的事实。'.repeat(120) + '记录' + i) : i % 2 ? '嗯，我在这儿陪你。' : '今天只是想安静坐一会儿。', memoryEligible: false })));
}
function callsFor(name) { return requests.filter(r => r.case === name); }
function requestContains(calls, value) { return calls.some(r => JSON.stringify(r.body.messages).includes(value)); }
async function chat(owner, question) {
  const sent = await withModelAccount(owner.userId, () => createSendTurn(owner, randomUUID(), question));
  await drainTurns(60000);
  const [turn] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
  const [reply] = turn?.catMessageId ? await db.select().from(messages).where(eq(messages.id, turn.catMessageId)) : [];
  const tools = await db.select().from(runtimeCalls).where(eq(runtimeCalls.turnId, sent.turnId)).orderBy(asc(runtimeCalls.startedAt));
  return { turnId: sent.turnId, status: turn?.status, error: turn?.error, text: reply?.text ?? '', sourceIds: turn?.contextSourceIds, tools: tools.map(t => ({ tool: t.tool, input: t.input, status: t.status, output: t.output })) };
}
function save() {
  const audit = requests.map(({body,...r}) => ({ ...r, model: body.model, stream: body.stream ?? false, thinking: body.thinking, toolChoice: body.tool_choice, toolCalls: (body.messages ?? []).flatMap(m=>(m.tool_calls??[]).map(t=>({id:t.id,name:t.function?.name}))), messageCount: body.messages?.length, toolResults: (body.messages ?? []).filter(m => m.role === 'tool').map(m => ({callId:m.tool_call_id,content:m.content})) }));
  writeFileSync(resolve(output,'results.json'), JSON.stringify({ at:new Date().toISOString(), models:{chat:config.CHAT_MODEL,chatThinking:config.CHAT_THINKING,worker:config.WORKER_MODEL,workerThinking:config.WORKER_THINKING}, results, requests:audit },null,2)+'\n');
}
async function scenario(name, run) {
  if(process.env.LIVE_REVIEW_CASES && !process.env.LIVE_REVIEW_CASES.split(',').includes(name)) return;
  activeCase = name;
  const entry = { name, status:'running', evidence:{} };
  results.push(entry);
  const start=performance.now();
  try { await run(entry.evidence); entry.status='passed'; }
  catch(e) { entry.status='failed'; entry.error=e instanceof Error?e.message:'unknown'; }
  entry.durationMs=Math.round(performance.now()-start);save();
  console.log(JSON.stringify({name,status:entry.status,error:entry.error,durationMs:entry.durationMs,reply:entry.evidence.chat?.text}));
}
try {
  await scenario('ordinary_chat',async e=>{
    const owner=await fixture(activeCase);
    e.chat=await chat(owner,'今天想在这里安静待一下，你陪着就好。');
    assert.equal(e.chat.status,'completed');assert(e.chat.text.length>0);
    assert.equal(callsFor(activeCase).length,1);assert.equal(e.chat.tools.length,0);
  });
  let oldOwner,oldSource;
  await scenario('history_outside_window',async e=>{
    oldOwner=await fixture(activeCase);
    oldSource=await source(oldOwner,'那次去栀子茶馆，我选的是北窗旁第三桌，桌上的预约牌写着青橙桥6719。');
    await pad(oldOwner);
    e.chat=await chat(oldOwner,'之前聊到的栀子茶馆，我当时选的座位在哪里，预约牌上写了什么？请翻原话核对。');
    const calls=callsFor(activeCase);e.firstRequestExcludedAnswer=!requestContains(calls.slice(0,1),'青橙桥6719');
    assert.equal(e.chat.status,'completed');assert(e.firstRequestExcludedAnswer);
    assert(e.chat.tools.some(t=>t.tool==='search_chat_history'&&t.status==='succeeded'));
    assert(e.chat.text.includes('青橙桥6719'));assert(/北窗/.test(e.chat.text));assert(e.chat.sourceIds.includes(oldSource.id));
  });
  await scenario('withdrawn_history',async e=>{
    await db.transaction(async tx=>{await lockMemory(tx,oldOwner.catId);await withdrawSources(tx,oldOwner.catId,[oldSource.id]);});
    e.chat=await chat(oldOwner,'再帮我核对栀子茶馆的预约牌写了什么。查不到就直接告诉我，不要猜。');
    assert.equal(e.chat.status,'completed');
    e.absentFromEveryRequest=!requestContains(callsFor(activeCase),'青橙桥6719');
    assert(e.absentFromEveryRequest);assert(!e.chat.text.includes('青橙桥6719'));
  });
  await scenario('long_original',async e=>{
    const owner=await fixture(activeCase);
    const original='关于星河书店，我那次写的安排是：'+ '店里很安静，窗边摆着旧书，纸页微黄。'.repeat(65)+'最终取书暗号是青杉9R41，入口选东侧玻璃门。';
    const old=await source(owner,original);await pad(owner);
    e.sourceBytes=Buffer.byteLength(original);
    e.chat=await chat(owner,'上次那段星河书店的长安排，最后定的取书暗号和入口是什么？请把需要的原话查清楚再回答。');
    e.firstRequestExcludedAnswer=!requestContains(callsFor(activeCase).slice(0,1),'青杉9R41');
    assert.equal(e.chat.status,'completed');assert(e.firstRequestExcludedAnswer);
    assert(e.chat.text.includes('青杉9R41'));assert(e.chat.text.includes('东侧玻璃门'));assert(e.chat.sourceIds.includes(old.id));
    e.readOffsets=e.chat.tools.filter(t=>t.tool==='read_chat_history').map(t=>t.input.offset??0);
  });
  await scenario('memory_use_disabled',async e=>{
    const owner=await fixture(activeCase);await source(owner,'风铃展览的票号是紫藤X583。');await pad(owner);
    const [cat]=await db.select().from(cats).where(eq(cats.id,owner.catId));
    await changeSettings(owner.catId,{use:false,revision:cat.memoryRevision});
    e.chat=await chat(owner,'请查原话，风铃展览的票号是什么？找不到就说不知道。');
    assert.equal(e.chat.status,'completed');assert(!requestContains(callsFor(activeCase),'紫藤X583'));assert(!e.chat.text.includes('紫藤X583'));
    assert(e.chat.tools.some(t=>t.tool==='search_chat_history'&&t.output?.data?.available===false));
    assert(!/没找到|翻了|没有找到|没说过/.test(e.chat.text));
  });
  await scenario('long_recent_context',async e=>{
    const owner=await fixture(activeCase);await pad(owner,28,true);
    const question='现在只回答这句话：请说“小纸船K73，我陪着你”。不需要翻旧话。';
    e.chat=await chat(owner,question);const calls=callsFor(activeCase);
    assert.equal(e.chat.status,'completed');assert(e.chat.text.includes('小纸船K73'));assert(calls.every(r=>r.bytes<64*1024));
    assert(calls.every(r=>JSON.stringify(r.body.messages).includes(question)));
    e.requestBytes=calls.map(r=>r.bytes);
    e.preservedRows=(await db.select().from(messages).where(eq(messages.conversationId,owner.conversationId))).length;
    assert.equal(e.preservedRows,30);
  });
  await scenario('http_sse_history',async e=>{
    const { app }=await import('../src/api/app.ts');
    const { serve }=await import('@hono/node-server');
    const { hashToken }=await import('../src/auth-token.ts');
    const owner=await fixture(activeCase);const old=await source(owner,'海棠放映会的取票口在西厅2号口，取票口令为柏木R502。');await pad(owner);
    const token=randomUUID();await db.update(users).set({devTokenHash:hashToken(token)}).where(eq(users.id,owner.userId));
    const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
    try {
      if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
      const address=server.address();
      const response=await originalFetch(`http://127.0.0.1:${address.port}/v1/messages`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({client_message_id:randomUUID(),text:'海棠放映会的取票口在哪，口令是什么？翻原话确认。'}),signal:AbortSignal.timeout(60000)});
      e.httpStatus=response.status;e.contentType=response.headers.get('content-type');const body=await response.text();
      e.events=body.split('\n\n').filter(part=>part.includes('event:')).map(part=>({event:part.match(/event: ?([^\n]+)/)?.[1],data:JSON.parse(part.match(/data: ?([^\n]+)/)?.[1]??'{}')}));
      e.text=e.events.filter(v=>v.event==='delta').map(v=>v.data.text).join('');
      assert.equal(response.status,200);assert(e.contentType.includes('text/event-stream'));
      assert(e.events.some(v=>v.event==='accepted'));assert(e.events.some(v=>v.event==='done'));assert(!e.events.some(v=>v.event==='error'));
      assert(e.text.includes('柏木R502'));assert(/西厅.*2|西厅.*二/.test(e.text));
      assert(!requestContains(callsFor(activeCase).slice(0,1),'柏木R502'));
      const turnId=e.events.find(v=>v.event==='accepted').data.turn_id;
      const [turn]=await db.select().from(turns).where(eq(turns.id,turnId));assert(turn.contextSourceIds.includes(old.id));
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });
  await scenario('worker_history_and_frontend_report',async e=>{
    const owner=await fixture(activeCase);const old=await source(owner,'栀子茶馆的预约牌是青橙桥6719；我选北窗旁第三桌，因为那里安静。');await pad(owner);
    const instruction='请翻原话，整理栀子茶馆的预约牌和座位，做成一条简短备忘。';
    const current=await source(owner,instruction);
    const receipt=await startErrand(owner.catId,current.id,instruction);
    const [run]=await db.select().from(runs).where(eq(runs.ticketId,receipt.ticket_id));
    await withModelAccount(owner.userId,()=>processErrand(run.id));
    const [computed]=await db.select().from(runs).where(eq(runs.id,run.id));
    e.report=computed.report.active;e.dependencies=computed.report.dependencies;
    assert.equal((await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,owner.catId))).length,0);
    assert.equal(e.report?.status,'ready');assert(e.report.result.includes('青橙桥6719'));assert(e.dependencies.messages.includes(old.id));
    const reports=await db.select().from(workerReports).where(eq(workerReports.sourceId,run.id));
    for(const report of reports)await withModelAccount(owner.userId,()=>processReport(report.id));
    const letters=await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,owner.catId));
    e.letters=letters.map(l=>l.text);assert.equal(letters.length,1);assert(letters[0].text.includes('青橙桥6719'));
    const before=callsFor(activeCase).length;
    await withModelAccount(owner.userId,()=>processErrand(run.id));
    for(const report of reports)await withModelAccount(owner.userId,()=>processReport(report.id));
    assert.equal(callsFor(activeCase).length,before);
    assert.equal((await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,owner.catId))).length,1);
  });
  save();
  const usage=await db.select().from(modelCalls);
  writeFileSync(resolve(output,'usage.json'),JSON.stringify(usage.map(({purpose,model,inputTokens,outputTokens,reasoningTokens,latencyMs})=>({purpose,model,inputTokens,outputTokens,reasoningTokens,latencyMs})),null,2)+'\n');
  console.log(JSON.stringify({summary:results.map(r=>({name:r.name,status:r.status})),requests:requests.length,output}));
  process.exitCode=results.some(r=>r.status!=='passed')?1:0;
} finally {
  globalThis.fetch=originalFetch;
  await drainTurns(5000);await closeQueues();await sql.end();
}
