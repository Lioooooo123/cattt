/**
 * 冒烟测试：对着正在跑的服务，把 spec 第 10 节第 2、3 步的验收逐条走一遍。
 *   用假模型起服务（MODEL_PROVIDER=mock pnpm dev）后：pnpm smoke
 * 每次新建一个临时账号，跑完删掉，互不影响。
 * 用到假模型的 [slow] [fail1] 标记，所以只在 mock 下全部有效。
 */
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { hashToken } from '../src/auth-token.ts';
import { config } from '../src/config.ts';
import { randomUUID } from 'node:crypto';
import { sql } from '../src/db/client.ts';
import { createDevUser, deleteUser } from '../src/dev-user.ts';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const devUser = await createDevUser('smoke');
const headers = { authorization: `Bearer ${devUser.token}`, 'content-type': 'application/json' };

type Ev = { id: string; event: string; data: any };

/** 读 SSE。stopWhen 返回 true 时主动断开，模拟断线 */
async function sse(
  method: string,
  path: string,
  opts: { body?: unknown; lastEventId?: string; stopWhen?: (evs: Ev[]) => boolean } = {},
): Promise<Ev[]> {
  const ac = new AbortController();
  const input = {method,headers:{...headers,...(opts.lastEventId?{'last-event-id':opts.lastEventId}:{})},body:opts.body?JSON.stringify(opts.body):undefined,signal:ac.signal};
  // Node fetch的HTTPS连接池会让长SSE占住后续请求；独立原生连接保留真实并发取消/补一句的验收。
  const res = BASE.startsWith('https:') ? await new Promise<Response>((resolve,reject)=>{
    const req=httpsRequest(BASE+path,{method,headers:input.headers,signal:ac.signal,agent:false},response=>{
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>,{status:response.statusCode??500}));
    });
    req.on('error',reject);if(input.body)req.write(input.body);req.end();
  }) : await fetch(BASE+path,input);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  const evs: Ev[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body!) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev: Partial<Ev> = {};
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4);
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
        }
        if (!ev.event) continue;
        evs.push(ev as Ev);
        if (['done', 'superseded', 'error'].includes(ev.event)) return evs;
        if (opts.stopWhen?.(evs)) {
          ac.abort();
          return evs;
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  }
  return evs;
}

const send = (text: string, opts: Parameters<typeof sse>[2] = {}) =>
  sse('POST', '/v1/messages', { ...opts, body: { client_message_id: randomUUID(), text } });

async function get(path: string) {
  const res = await fetch(BASE + path, { headers });
  return res.json() as Promise<any>;
}
async function post(path: string) {
  const res = await fetch(BASE + path, { method: 'POST', headers });
  return res.json() as Promise<any>;
}
async function del(path: string) {
  const res = await fetch(BASE + path, { method: 'DELETE', headers });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

const textOf = (evs: Ev[]) => evs.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
const last = (evs: Ev[]) => evs[evs.length - 1]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitExtracted(turnId: string) {
  for (let i = 0; i < 40; i++) {
    const t = await get(`/v1/turns/${turnId}`);
    if (t.extracted) return t;
    await sleep(250);
  }
  throw new Error(`turn ${turnId} 10 秒内没提取完`);
}

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n    ${(err as Error).message}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await check('一轮完整回复：accepted → delta… → done，落库的就是发出去的字', async () => {
  const evs = await send('今天好累');
  expect(evs[0]?.event === 'accepted', `第一个事件是 ${evs[0]?.event}`);
  expect(last(evs).event === 'done' && last(evs).data.status === 'done', `最后是 ${JSON.stringify(last(evs))}`);
  const { messages } = await get('/v1/messages?limit=1');
  expect(messages[0].id === last(evs).data.message_id, '最新消息不是这条回复');
  expect(messages[0].text === textOf(evs), `库里「${messages[0].text}」≠ 发出「${textOf(evs)}」`);
});

await check('重复的 client_message_id：不存第二条，返回同一轮', async () => {
  const id = randomUUID();
  const a = await sse('POST', '/v1/messages', { body: { client_message_id: id, text: '重复测试' } });
  const before = (await get('/v1/messages?limit=100')).messages.length;
  const b = await sse('POST', '/v1/messages', { body: { client_message_id: id, text: '重复测试' } });
  const after = (await get('/v1/messages?limit=100')).messages.length;
  expect(a[0]!.data.turn_id === b[0]!.data.turn_id, '两次返回的不是同一轮');
  expect(before === after, `消息数从 ${before} 变成 ${after}`);
  expect(textOf(a) === textOf(b), '重放的内容不一致');
});

await check('中途断线再续：拿到完整回复，库里只有一条', async () => {
  const first = await send('[slow] 断线测试', { stopWhen: (evs) => evs.filter((e) => e.event === 'delta').length >= 3 });
  expect(last(first).event === 'delta', '没断在中途');
  const turnId = first[0]!.data.turn_id;
  const rest = await sse('GET', `/v1/turns/${turnId}/stream`, { lastEventId: last(first).id });
  expect(last(rest).event === 'done', `续传最后是 ${last(rest).event}`);
  const { messages } = await get('/v1/messages?limit=100');
  const replies = messages.filter((m: any) => m.turn_id === turnId);
  expect(replies.length === 1, `这一轮有 ${replies.length} 条猫消息`);
  expect(replies[0].text === textOf(first) + textOf(rest), `拼起来「${textOf(first) + textOf(rest)}」≠ 库里「${replies[0].text}」`);
});

await check('等回复时补一句：旧的收到 superseded，新的一轮回复', async () => {
  let accepted!:()=>void;const acceptedP=new Promise<void>(resolve=>accepted=resolve);
  const oldP = send('[slow] 第一句',{stopWhen:events=>{if(events.some(e=>e.event==='accepted'))accepted();return false;}});
  await acceptedP;
  const fresh = await send('第二句');
  const old = await oldP;
  expect(last(old).event === 'superseded', `旧的一轮最后是 ${last(old).event}`);
  expect(last(fresh).event === 'done', `新的一轮最后是 ${last(fresh).event}`);
  const { messages } = await get('/v1/messages?limit=100');
  expect(!messages.some((m: any) => m.turn_id === old[0]!.data.turn_id), '作废的一轮还是留下了猫消息');
});

await check('停止：保留已经说出来的字，状态 stopped', async () => {
  // 边读边看：读到 3 个字就发停止，然后接着读到结束
  const seen: Ev[] = [];
  const reading = send('[slow] 停止测试', {
    stopWhen: (evs) => {
      seen.splice(0, seen.length, ...evs);
      return false;
    },
  });
  while (seen.filter((e) => e.event === 'delta').length < 3) await sleep(50);
  // 带上「屏幕上已经显示的长度」：服务端停住之前还会多吐几个字，存库时要截回到这里
  const shown = textOf(seen);
  const res = await fetch(`${BASE}/v1/turns/${seen[0]!.data.turn_id}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ visible_length: shown.length }),
  });
  expect(res.ok, `cancel 返回 ${res.status}`);
  const done = await reading;
  expect(last(done).event === 'done' && last(done).data.status === 'stopped', `最后是 ${JSON.stringify(last(done))}`);
  const { messages } = await get('/v1/messages?limit=1');
  expect(messages[0].status === 'stopped', `状态是 ${messages[0].status}`);
  expect(messages[0].text === shown, `库里「${messages[0].text}」≠ 屏幕上的「${shown}」`);
});

await check('模型输出里的空行压成一个换行，开头结尾不留换行', async () => {
  // 假模型会原样复述用户的话，里面的连续换行就是要压的
  const evs = await send('第一行\n\n\n第二行');
  const shown = textOf(evs);
  expect(shown.includes('\n') && !shown.includes('\n\n'), `发出去的是「${JSON.stringify(shown)}」`);
  const { messages } = await get('/v1/messages?limit=1');
  expect(messages[0].text === shown, '库里和发出去的不一致');
});

await check('模型出错：发可重试的 error；「再试一次」对同一句话重新回复', async () => {
  const text = `[fail1] 失败测试 ${randomUUID().slice(0, 8)}`;
  const evs = await send(text);
  expect(last(evs).event === 'error' && last(evs).data.retryable === true, `最后是 ${JSON.stringify(last(evs))}`);
  const again = await sse('POST', `/v1/messages/${evs[0]!.data.user_message_id}/reply`);
  expect(last(again).event === 'done', `重新回复最后是 ${last(again).event}`);
  const { messages } = await get('/v1/messages?limit=2');
  expect(messages[0].role === 'user' && messages[1].role === 'cat', '用户那句没有重复存');
});

let rememberedTurn = '';
await check('「记住……」：提取出明确要记的记忆，/turns 显示 remembered', async () => {
  const evs = await send('记住我对猫毛过敏');
  rememberedTurn = evs[0]!.data.turn_id;
  const t = await waitExtracted(rememberedTurn);
  expect(t.remembered === true, 'remembered 不是 true');
  const { memories } = await get('/v1/memories');
  expect(memories.some((m: any) => m.value.includes('猫毛过敏') && m.explicit), '记忆列表里没有');
  // 同一件事再说一遍「记住」：已有记忆只刷新，但这一轮照样要显示「记下了」
  const again = await send('记住我对猫毛过敏');
  const t2 = await waitExtracted(again[0]!.data.turn_id);
  expect(t2.remembered === true, '第二次说「记住」时 remembered 不是 true');
  const after = (await get('/v1/memories')).memories.filter((m: any) => m.value.includes('猫毛过敏'));
  expect(after.length === 1, `同一件事存了 ${after.length} 条`);
  // 重新打开 app 拉历史时，「记下了」要还在
  const { messages } = await get('/v1/messages?limit=100');
  const reply = messages.find((m: any) => m.id === last(evs).data.message_id);
  expect(reply?.remembered === true, '历史记录里这条回复没带 remembered');
});

await check('相关话题的下一轮回复会用上记住的事', async () => {
  const evs = await send('我对猫毛过敏，接触猫毛时要注意什么？');
  const t = await get(`/v1/turns/${evs[0]!.data.turn_id}`);
  const { memories } = await get('/v1/memories');
  const target = memories.find((m: any) => m.value.includes('猫毛过敏'));
  expect(t.memory_ids.includes(target.id), `这一轮用到的记忆 ${JSON.stringify(t.memory_ids)} 里没有它`);
});

await check('删掉的记忆：不再召回，同样的话再说一遍也不会被重新提取', async () => {
  const a = await send('我喜欢拿铁');
  await waitExtracted(a[0]!.data.turn_id);
  let { memories } = await get('/v1/memories');
  const latte = memories.find((m: any) => m.value.includes('拿铁'));
  expect(latte, '第一次没提取出来');
  const impact = await get(`/v1/memories/${latte.id}/impact`);
  await del(`/v1/memories/${latte.id}?withdraw_sources=false&revision=${impact.revision}`);
  const b = await send('我喜欢拿铁');
  const t = await waitExtracted(b[0]!.data.turn_id);
  expect(!t.memory_ids.includes(latte.id), '删掉的记忆还在被召回');
  ({ memories } = await get('/v1/memories'));
  expect(!memories.some((m: any) => m.value.includes('拿铁')), '删掉后又被提取回来了');
});

await check('「不要再提」：写进边界，worker 整理出一句话', async () => {
  const evs = await send('我们聊聊前任吧');
  await post(`/v1/messages/${last(evs).data.message_id}/boundary`);
  for (let i = 0; i < 40; i++) {
    const { boundaries } = await get('/v1/boundaries');
    const b = boundaries.find((x: any) => x.source_message_id === last(evs).data.message_id);
    if (b?.description) {
      const { messages } = await get('/v1/messages?limit=100');
      const marked = messages.find((m: any) => m.id === last(evs).data.message_id);
      expect(marked?.boundary === true, '历史记录里这条没带 boundary');
      return;
    }
    await sleep(250);
  }
  throw new Error('10 秒内没整理出描述');
});

await check('约定聊天工具 → 改成后天直达 → 到期提问/信箱 → 已读与取消', async () => {
  const when = new Date(Date.now()+86400000).toISOString().slice(0,19)+'Z';
  const events = await send(`[followup:${when}|面试怎么样]`);
  expect(textOf(events).includes('约好了'), '聊天没有成功保存约定');
  let page = await get('/v1/tickets?status=open');
  expect(page.tickets.length === 1, '未读取到唯一约定');
  const id = page.tickets[0].id;
  expect(textOf(await send('改成后天')).includes('改好了'), '追加没有直达已有约定');
  page = await get('/v1/tickets?status=open'); expect(page.tickets.length===1 && page.tickets[0].id===id,'错误新建了事项');
  // 可控到期：不等待两天；仅测试账号使用UTC白天，保留真实worker/pg-boss链路。
  await sql`update users set time_zone='UTC' where id=${devUser.userId}`;
  await sql`update tickets set due_at=now()-interval '1 minute' where id=${id}`;
  let letter:any;
  for(let n=0;n<140;n++) {
    const box=await get('/v1/mailbox?after=0'); letter=box.letters.find((x:any)=>x.ticket_id===id);
    if(letter) break; await sleep(500);
  }
  expect(letter,'到期70秒内没有投递信箱');
  const history=await get('/v1/messages?limit=100');
  expect(history.messages.filter((m:any)=>m.ticket_id===id && m.turn_id===null).length===1,'主动聊天消息不唯一或错误绑定轮次');
  const session=await fetch(BASE+'/v1/world/sessions',{method:'POST',headers,body:JSON.stringify({protocolVersion:1})}).then(r=>r.json()) as any;
  const signal=await sse('GET',`/v1/world/events?sessionId=${session.sessionId}&generation=${session.generation}`,{stopWhen:evs=>evs.some(e=>e.event==='inbox')});
  expect(signal.some(e=>e.event==='inbox'&&e.data.seq>0),'前台没有inbox提示');
  await post('/v1/mailbox/'+letter.id+'/read'); expect((await get('/v1/mailbox?after=0')).letters.find((l:any)=>l.id===letter.id).read_at,'已读未保存');
  await send(`[followup:${when}|另一件事]`);
  const next=(await get('/v1/tickets?status=open')).tickets[0]; expect(next,'第二件未保存');
  expect(textOf(await send('取消这件约定')).includes('取消了'),'聊天取消失败');
  expect((await get('/v1/tickets?status=open')).tickets.length===0,'取消后仍显示未结束');
});

// 第三段：真实HTTP聊天工具→PG待办→pg-boss→执行检查点→发布出口。
await check('托付想好后只来一封信和一句话；等待回答经工具直达继续', async()=>{
  await sql`update users set time_zone='UTC' where id=${devUser.userId}`;
  // UTC午间仅用于本地验收的安静时段判定，不改机器时钟。
  const hour=new Date().getUTCHours();
  const zone=hour>=9&&hour<22?'UTC':'Pacific/Honolulu';
  // 当前主机时刻若不在两地白天，选一个可用的IANA时区。
  const zones=[zone,'Asia/Shanghai','America/New_York','Europe/London','Pacific/Auckland'];
  const daytime=zones.find(z=>{const h=Number(new Intl.DateTimeFormat('en-GB',{timeZone:z,hour:'2-digit',hourCycle:'h23'}).format(new Date()));return h>=9&&h<22;})!;
  await sql`update users set time_zone=${daytime} where id=${devUser.userId}`;
  expect(textOf(await send('[errand:想想周末怎么过]')).includes('我想想'),'托付没有成功确认');
  const first=(await get('/v1/tickets?status=open')).tickets.find((t:any)=>t.kind==='errand');expect(first,'没有托付凭证');
  const waitLetter=async(id:string)=>{
    for(let i=0;i<160;i++){const box=await get('/v1/mailbox?after=0');const l=box.letters.find((x:any)=>x.ticket_id===id);if(l)return l;await sleep(500);}throw new Error('80秒内没有来信');
  };
  const letter=await waitLetter(first.id);expect(letter.text.includes('周末'),'结果信内容缺失');
  const history=await get('/v1/messages?limit=100');expect(history.messages.filter((m:any)=>m.ticket_id===first.id).length===1,'托付聊天通知不唯一');
  expect(textOf(await send('[errand:[waiting] 想想在家怎么过]')).includes('我想想'),'等待托付未保存');
  const waiting=(await get('/v1/tickets?status=open')).tickets.find((t:any)=>t.kind==='errand');expect(waiting,'缺少等待事项');
  for(let i=0;i<160;i++){const state=(await get('/v1/tickets?status=open')).tickets.find((t:any)=>t.id===waiting.id);if(state?.stage==='waiting')break;if(i===159)throw new Error('未进入等待');await sleep(500);}
  expect(textOf(await send('[ticket-input:想待在家里]')).includes('放进那件事'),'聊天补充未保存');
  expect((await waitLetter(waiting.id)).text.includes('想待在家里'),'执行下一步未读到补充');
  const stages=(await get('/v1/tickets?status=all')).tickets;expect(stages.filter((t:any)=>t.kind==='errand'&&t.stage==='ready').length===2,'列表缺少已完成阶段');
});

// 第四段：本账号的可控历史日界；真实HTTP世界上报→worker扫描→pg-boss→唯一出口→日记同步。
await check('每日猫日记三日补齐、HTTP保护、inbox提示，不写聊天和普通来信', async()=>{
  await fetch(BASE+'/v1/me/time-zone',{method:'PUT',headers,body:JSON.stringify({time_zone:'UTC'})}).then(r=>{expect(r.ok,'时区上报失败');});
  const [fixture]=await sql`select c.id as cat_id, to_char(now()-interval '3 days','YYYY-MM-DD') as start_day from cats c where user_id=${devUser.userId}`;
  await sql`update diary_calendars set start_day=${fixture!.start_day}, next_day=${fixture!.start_day}, next_scan_at='epoch'
    where cat_id=${fixture!.cat_id}`;
  const session=await fetch(BASE+'/v1/world/sessions',{method:'POST',headers,body:JSON.stringify({protocolVersion:1})}).then(r=>r.json()) as any;
  const state=await fetch(BASE+'/v1/world/state',{method:'PUT',headers,body:JSON.stringify({...session,snapshot:{stateVersion:1,sceneVersion:4,destinationIds:['grass'],currentDestinationId:'grass',targetDestinationId:'grass',phase:'idle',action:'rest',activity:'rest',paused:false,runnable:true}})});
  expect(state.ok,'真实世界上报失败');
  const beforeMessages=(await get('/v1/messages?limit=100')).messages.length;
  const beforeLetters=(await get('/v1/mailbox?after=0')).letters.length;
  let diaries:any[]=[];
  for(let i=0;i<160;i++){diaries=(await get('/v1/diary')).entries.filter((e:any)=>e.kind==='cat');if(diaries.length===3)break;await sleep(500);}
  expect(diaries.length===3 && new Set(diaries.map(d=>d.day)).size===3,'未逐日生成三篇猫日记');
  expect(diaries.every(d=>d.client_id.startsWith('daily-cat:')&&!d.text.includes('草地')),'将当天观察误用为历史');
  const d=diaries[0];const edited=await fetch(BASE+'/v1/diary',{method:'PUT',headers,body:JSON.stringify({client_id:d.client_id,kind:'cat',text:'不应写入',recorded_at:d.recorded_at,time_zone:d.time_zone,day:d.day,time:d.time,cat_allowed:false,revision:d.revision,mutation_id:randomUUID()})});
  expect(edited.status===409,'客户端改写了服务端猫日记');
  const signal=await sse('GET',`/v1/world/events?sessionId=${session.sessionId}&generation=${session.generation}`,{stopWhen:evs=>evs.some(e=>e.event==='inbox')});
  expect(signal.some(e=>e.event==='inbox'&&e.data.seq>0),'猫日记没有inbox提示');
  expect((await get('/v1/messages?limit=100')).messages.length===beforeMessages,'日记错误写入主动聊天');
  expect((await get('/v1/mailbox?after=0')).letters.length===beforeLetters,'同一日记又变成普通来信');
  const [calls]=await sql`select count(*)::int as n from model_calls where purpose='cat_diary' and job_id in(select id::text from tickets where cat_id=${fixture!.cat_id} and kind='diary')`;
  expect(calls!.n>=3,'未实际经过写作者模型槽位');
});

await check('正式会话HTTP账号/日记读取与退出；设备注册/注销和账号隔离', async()=>{
 const token=randomUUID();await sql`insert into sessions(user_id,token_hash,expires_at) values(${devUser.userId},${hashToken(token)},now()+interval '1 hour')`;
 const sessionHeaders={authorization:'Bearer '+token,'content-type':'application/json'};
 const me=await fetch(BASE+'/v1/me',{headers:sessionHeaders}).then(r=>r.json()) as any;expect(me.account_id===devUser.userId,'会话账号不稳定');
 expect((await fetch(BASE+'/v1/diary',{headers:sessionHeaders})).status===200,'正式会话不能恢复日记');
 if(config.APNS_TOPIC){
 const registered=await fetch(BASE+'/v1/devices',{method:'POST',headers:sessionHeaders,body:JSON.stringify({token:'a'.repeat(64),environment:'sandbox',topic:config.APNS_TOPIC})});expect(registered.status===200,'设备登记失败');const device=await registered.json() as any;
 expect((await fetch(BASE+'/v1/devices/'+device.id,{method:'DELETE',headers:sessionHeaders})).status===200,'设备注销失败');
 }
 expect((await fetch(BASE+'/v1/devices',{method:'POST',headers:sessionHeaders,body:JSON.stringify({token:'a'.repeat(64),environment:'sandbox',topic:'wrong.topic'})})).status===400,'topic未隔离');
 expect((await fetch(BASE+'/v1/notifications/'+randomUUID(),{headers:sessionHeaders})).status===404,'不存在的通知制造了目标');
 expect((await fetch(BASE+'/v1/session/logout',{method:'POST',headers:sessionHeaders})).status===200,'退出失败');
 expect((await fetch(BASE+'/v1/me',{headers:sessionHeaders})).status===401,'退出没有撤销会话');
});

// 第六段：真实HTTP新聊天→PG待办/pg-boss→observe聚合；始终不切真实auto规则。
await check('主动许可默认关闭；HTTP聊天异步observe只记聚合，关闭后不再评估', async()=>{
 const {outcomeMetrics}=await import('../src/agent/inference.ts');
 const patch=(allowed:boolean)=>fetch(BASE+'/v1/me/proactive',{method:'PATCH',headers,body:JSON.stringify({allow_proactive:allowed})});
 expect((await get('/v1/me/proactive')).allow_proactive===false,'默认许可没有关闭');
 expect((await patch(true)).ok,'开启观察许可失败');
 const [cat]=await sql`select id from cats where user_id=${devUser.userId}`;
 const zones=['UTC','Asia/Shanghai','America/New_York','Europe/London','Pacific/Auckland'];
 const zone=zones.find(z=>{const h=Number(new Intl.DateTimeFormat('en-GB',{timeZone:z,hour:'2-digit',hourCycle:'h23'}).format(new Date()));return h>=9&&h<22;})!;
 await fetch(BASE+'/v1/me/time-zone',{method:'PUT',headers,body:JSON.stringify({time_zone:zone})});
 const when=new Date(Date.now()-300000).toISOString();
 const sent=await send(`我的重要面试在${when}结束`);expect(sent.some(e=>e.event==='done'),'正常聊天未结束');
 let observed=false;
 for(let i=0;i<160;i++){const [row]=await sql`select count(*)::int as n from inference_observations where cat_id=${cat!.id}`;if(row!.n===1){observed=true;break;}await sleep(500);}
 expect(observed,'没有经worker生成observe聚合引用');
 const aggregate=await outcomeMetrics({catId:cat!.id});expect(aggregate.would_ask_total===1&&aggregate.pending===1,'聚合不正确');
 expect(!JSON.stringify(aggregate).includes('面试'),'聚合泄漏原文');
 const [external]=await sql`select count(*)::int as n from messages where conversation_id in(select id from conversations where cat_id=${cat!.id}) and role='cat' and turn_id is null`;
 // 早先约定/托付已有主动正文；仅检查inferred没有任何可见产出。
 const [inferred]=await sql`select count(*)::int as n from tickets where cat_id=${cat!.id} and mandate->>'kind'='inferred' and kind!='diary'`;
 expect(inferred!.n===0,'observe错误建发布事项');
 const [receipts]=await sql`select count(*)::int as n from outbox where cat_id=${cat!.id} and purpose like 'inferred:%'`;
 expect(receipts!.n===0,'observe错误写外发收据');
 expect((await patch(false)).ok && !(await get('/v1/me/proactive')).allow_proactive,'关闭许可未持久保存');
 const [before]=await sql`select count(*)::int as n from triggers where cat_id=${cat!.id} and payload->>'inference_rule'='ask_outcome'`;
 await send(`我的重要考试在${when}结束`);
 const [after]=await sql`select count(*)::int as n from triggers where cat_id=${cat!.id} and payload->>'inference_rule'='ask_outcome'`;
 expect(after!.n===before!.n,'关闭后仍建推断候选');
 const [lastExternal]=await sql`select count(*)::int as n from messages where conversation_id in(select id from conversations where cat_id=${cat!.id}) and role='cat' and turn_id is null`;
 expect(lastExternal!.n===external!.n,'观察/关闭引起主动外发');
});

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项没通过`);
await sql`delete from async_jobs where object_id in (select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${devUser.userId}) or source_id in (select t.id from triggers t join cats c on c.id=t.cat_id where c.user_id=${devUser.userId})`;
await deleteUser(devUser.userId);

await sql.end();
process.exit(failed === 0 ? 0 : 1);
