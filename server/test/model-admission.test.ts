import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { generateText, emptyUsage, type ModelClient, type ModelRequest } from '../src/llm/index.ts';
import { scriptedClient } from '../src/llm/testing.ts';
import { sql } from '../src/db/client.ts';
import { acquire, admissionLane, admissionModel } from '../src/runtime/admission.ts';
import { slotFrom } from '../src/runtime/model.ts';
import { config } from '../src/config.ts';

const resources: string[] = [];
const resource = () => { const r = `test:${randomUUID()}`; resources.push(r); return r; };
const options: ModelRequest = { messages: [{ role: 'user', content: '你好' }] };
async function waiting(r: string, count: number) {
  await vi.waitFor(async () => {
    const [row] = await sql`select count(*)::int as n from model_admissions where resource = ${r} and state = 'waiting'`;
    expect(row!.n).toBe(count);
  });
}
afterEach(async () => { for (const r of resources) await sql`delete from model_admissions where resource = ${r}`; vi.restoreAllMocks(); });
afterAll(async () => { await sql.end(); });

test('单并发先聊天，车道内先到先服务，释放幂等', async () => {
  const r = resource(); const release = await acquire(r, 'background', 'holder', 1);
  const order: string[] = [];
  const b = acquire(r, 'background', 'B', 1).then(async done => { order.push('B'); await done(); });
  await waiting(r, 1);
  const c = acquire(r, 'chat', 'C', 1).then(async done => { order.push('C'); await done(); });
  await waiting(r, 2);
  await Promise.all([release(), release()]); await Promise.all([b, c]);
  expect(order).toEqual(['C', 'B']);
});

test('槽位包装：慢后台流结束后，聊天越过第二个后台', async () => {
  const old = config.MODEL_MOCK_CONCURRENCY;
  config.MODEL_MOCK_CONCURRENCY = 1;
  resources.push('mock');
  try {
    const spec = { name: 'chat' as const, provider: 'mock' as const, model: 'mock-chat', thinking: 'disabled' as const };
    const background = slotFrom(spec, 'cat_diary').client;
    const chat = slotFrom(spec, 'chat').client;
    const first = background.stream({ messages: [{ role: 'user', content: '[slow] 你好' }] })[Symbol.asyncIterator]();
    await first.next();
    const order: string[] = [];
    const consume = async (model: ModelClient, label: string) => {
      for await (const _ of model.stream(options)) { order.push(label); break; }
    };
    const b = consume(background, 'B'); await waiting('mock', 1);
    const c = consume(chat, 'C'); await waiting('mock', 2);
    await first.return?.();
    await Promise.all([b, c]); expect(order).toEqual(['C', 'B']);
  } finally { config.MODEL_MOCK_CONCURRENCY = old; }
});

test('崩溃持有者过期后回收', async () => {
  const r = resource();
  await sql`insert into model_admissions (id,resource,lane,purpose,state,lease_expires_at)
    values (${randomUUID()},${r},'background','dead','running',now() - interval '1 second')`;
  const done = await acquire(r, 'chat', 'chat', 1);
  const rows = await sql`select * from model_admissions where resource = ${r}`;
  expect(rows).toHaveLength(1); expect(rows[0]!.state).toBe('running'); await done();
});

test('等候时取消删除行，已经取消不入队', async () => {
  const r = resource(); const done = await acquire(r, 'background', 'holder', 1);
  const abort = new AbortController();
  const pending = acquire(r, 'chat', 'chat', 1, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  await waiting(r, 1); abort.abort(); await rejected; await waiting(r, 0);
  await expect(acquire(r, 'chat', 'chat', 1, abort.signal)).rejects.toThrow(); await done();
});

test('流提前结束、正常完成、流错误和调用抛错均释放', async () => {
  for (const mode of ['cancel', 'finish', 'error', 'throw']) {
    const r = resource();
    const base: ModelClient = {provider:'mock',modelId:'release',async *stream(){
      if(mode==='throw')throw new Error('failed');
      yield {type:'text-delta',delta:'好'};
      if(mode==='error')throw new Error('failed');
      yield {type:'finish',finishReason:'stop',usage:emptyUsage()};
    }};
    const model=admissionModel(base,'chat',r,1);
    if(mode==='cancel'){for await(const _ of model.stream(options))break;}
    else if(mode==='error'||mode==='throw')await expect(generateText(model,options,{maxRetries:0})).rejects.toThrow('failed');
    else await generateText(model,options);
    expect(await sql`select id from model_admissions where resource = ${r}`).toHaveLength(0);
  }
});

test('生成成功或失败都释放；关闭准入不访问数据库', async () => {
  const r=resource();
  const base=scriptedClient([new Error('provider_failed')]);
  const model=admissionModel(base,'chat',r,1);
  await expect(generateText(model,options,{maxRetries:0})).rejects.toThrow('provider_failed');
  const success=scriptedClient([[{type:'text-delta',delta:'好'},{type:'finish',finishReason:'stop',usage:emptyUsage()}]]);
  await generateText(admissionModel(success,'chat',r,1),options);
  expect(await sql`select id from model_admissions where resource = ${r}`).toHaveLength(0);
  const debug=sql.options.debug;
  const queries=vi.fn();sql.options.debug=queries;
  try {
    await sql`select 1`;expect(queries).toHaveBeenCalled();queries.mockClear();
    expect(admissionModel(base,'chat',r,0)).toBe(base);
    await(await acquire(r,'chat','chat',0))();
    const failed=scriptedClient([new Error('provider_failed')]);
    await expect(generateText(admissionModel(failed,'chat',r,0),options,{maxRetries:0})).rejects.toThrow('provider_failed');
    expect(queries).not.toHaveBeenCalled();
  }finally{sql.options.debug=debug;}
});

test('运行中任一调用信号取消均释放，未结束的空流也释放', async () => {
  for(const mode of ['request','argument','empty']){
    const r=resource(),request=new AbortController(),argument=new AbortController();
    const base:ModelClient={provider:'mock',modelId:'abort',async *stream(_options,signal){
      expect(await sql`select id from model_admissions where resource = ${r} and state = 'running'`).toHaveLength(1);
      if(mode==='empty')return;
      yield {type:'text-delta',delta:'好'};
      signal?.throwIfAborted();
      yield {type:'finish',finishReason:'stop',usage:emptyUsage()};
    }};
    const model=admissionModel(base,'chat',r,1);
    const iterator=model.stream({...options,signal:request.signal},argument.signal)[Symbol.asyncIterator]();
    await iterator.next();
    if(mode!=='empty'){
      (mode==='request'?request:argument).abort();
      await expect(iterator.next()).rejects.toThrow();
    }
    expect(await sql`select id from model_admissions where resource = ${r}`).toHaveLength(0);
  }
});

test('同步记忆保存和检索走聊天，其余用途后台', () => {
  for (const purpose of ['chat', 'memory_recall', 'memory_extract_chat']) expect(admissionLane(purpose)).toBe('chat');
  for (const purpose of ['memory_extract', 'route', 'errand', 'diary_read', 'cat_diary', 'boundary_summarize']) expect(admissionLane(purpose)).toBe('background');
});
