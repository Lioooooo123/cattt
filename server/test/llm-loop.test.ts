import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetMessages, createDeepSeek, emptyUsage, estimateRequest, INPUT_BUDGET, ModelOutputError, runCatAgent, runModelStep, type AgentOptions, type ModelClient, type ModelEvent, type ModelMessage, type RuntimeTool, type StepInfo, type ToolTrace } from '../src/llm/index.ts';
import { scriptedClient } from '../src/llm/testing.ts';
import { timeTool } from '../src/runtime/time.ts';

const usage = { ...emptyUsage(), inputTokens: 10, outputTokens: 3 };
function step(text: string, calls: { name: string; id: string; input?: Record<string, unknown> }[] = []): ModelEvent[] {
  return [ ...(text ? [{ type: 'text-delta' as const, delta: text }] : []),
    ...calls.map(c => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.input ?? {}, rawInput: JSON.stringify(c.input ?? {}) })),
    { type: 'finish', finishReason: calls.length ? 'tool-calls' : 'stop', usage } ];
}
const observation = { status: 'succeeded' as const, source: 'fixture', observed_at: '2026-09-12T00:00:00Z', data: { ok: true } };
const fake: RuntimeTool = { description: 'fake', inputSchema: z.object({}), execute: async () => observation };
async function run(client: ModelClient, tools: Record<string, RuntimeTool> = { lookup: fake }, extras: Partial<AgentOptions> = {}) {
  let text = '';
  const traces: ToolTrace[] = [], steps: StepInfo[] = [];
  await runCatAgent({ client, instructions: '猫', messages: [{ role: 'user', content: '你好' }], tools,
    signal: new AbortController().signal, guard: async () => {}, onText: async t => { text += t; },
    onTool: async t => { traces.push(t); }, onStep: async s => { steps.push(s); }, ...extras });
  return { text, traces, steps, phases: steps.map(s => s.phase) };
}

describe('自研前台循环', () => {
  it('普通聊天只请求一次，不强制 finish_tools', async () => {
    const client = scriptedClient([step('嗯，我在。')]);
    const result = await run(client);
    expect(result.text).toBe('嗯，我在。'); expect(result.traces).toHaveLength(0);
    expect(client.requests.map(r => r.toolChoice)).toEqual(['auto']);
    expect(result.steps[0]).toMatchObject({ step: 0, phase: 'answer', finishReason: 'stop', usage });
    expect(result.steps[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('终答保留工具定义并明确 none，防止 DeepSeek DSML 泄漏', async () => {
    const requests: any[] = [];
    const client = createDeepSeek({ modelId: 'deepseek-flash', apiKey: 'fixture', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const first = requests.length === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: 'f', function: { name: 'finish_tools', arguments: '{}' } }] }
        : { content: body.tools?.length && body.tool_choice === 'none' ? '我是团子。' : '<｜｜DSML｜｜ calls>' };
      return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } });
    expect((await run(client)).text).toBe('我是团子。'); expect(requests).toHaveLength(2);
    expect(requests[1].tool_choice).toBe('none'); expect(requests[1].tools.map((t: any) => t.function.name)).toEqual(['lookup', 'finish_tools']);
  });
  it('丢弃工具步承诺，日期序列化后续传，finish_tools 结束工具阶段', async () => {
    const client = scriptedClient([step('我已经到池塘了', [{ name: 'lookup', id: '1' }]), step('', [{ name: 'finish_tools', id: '2' }]), step('暂时去不了，喵。')]);
    const result = await run(client, { lookup: { ...fake, execute: async () => ({ ...observation, data: { observedAt: new Date('2026-09-12T00:00:00Z') } }) } });
    expect(result.text).toBe('暂时去不了，喵。'); expect(result.phases).toEqual(['tools', 'tools', 'answer']);
    expect(client.requests).toHaveLength(3); expect(client.requests[2]!.toolChoice).toBe('none');
    expect(JSON.stringify(client.requests[1]!.messages)).toContain('2026-09-12T00:00:00.000Z');
  });
  it('第四步保留终答，没有工具定义也明确 none', async () => {
    const client = scriptedClient([step('', [{ name: 'lookup', id: '1' }]), step('', [{ name: 'lookup', id: '2' }]), step('', [{ name: 'lookup', id: '3' }]), step('知道这些，喵。')]);
    expect((await run(client)).text).toContain('知道这些'); expect(client.requests.map(r => r.toolChoice)).toEqual(['auto', 'auto', 'auto', 'none']);
    const empty = scriptedClient([step('嗯')]); await run(empty, {}); expect(empty.requests[0]!.toolChoice).toBe('none');
    expect(empty.requests[0]!.tools?.map(t => t.name)).toEqual(['finish_tools']);
  });
  it('同一步工具顺序执行，世界动作每轮最多一次，持久记录先于副作用', async () => {
    const order: string[] = [], traces: ToolTrace[] = [];
    const move: RuntimeTool = { ...fake, changesWorld: true, execute: async () => {
      expect(traces.at(-1)?.tool).toBe('move'); expect(traces.at(-1)?.output).toBeUndefined(); order.push('move'); return observation;
    } };
    const lookup: RuntimeTool = { ...fake, execute: async () => { expect(order).toEqual(['move']); order.push('lookup'); return observation; } };
    const client = scriptedClient([step('', [{ name: 'move', id: '1' }, { name: 'lookup', id: '2' }, { name: 'move', id: '3' }]), step('', [{ name: 'move', id: '4' }]), step('嗯')]);
    await run(client, { move, lookup }, { onTool: async t => { traces.push(t); } });
    expect(order).toEqual(['move', 'lookup']);
    for (const id of ['3', '4']) expect(traces.find(t => t.callId === id && t.output)?.output?.error?.code).toBe('tool_budget');
  });
  it('工具上限和 finish_tools 都阻止同一步后续工具，下一步 none', async () => {
    for (const first of ['lookup', 'finish_tools']) {
      let executed = 0;
      const client = scriptedClient([step('', [{ name: first, id: '1' }, { name: 'lookup', id: '2' }]), step('好')]);
      const result = await run(client, { lookup: { ...fake, execute: async () => { executed++; return observation; } } }, { maxTools: first === 'lookup' ? 1 : 6 });
      expect(executed).toBe(first === 'lookup' ? 1 : 0); expect(client.requests[1]!.toolChoice).toBe('none');
      expect(result.traces.find(t => t.callId === '2' && t.output)?.output?.error?.code).toBe('tool_budget');
    }
  });
  it('即使供应商终答仍请求工具，也不派发副作用且不超过步数', async () => {
    let executed = 0;
    const client = scriptedClient([step('', [{ name: 'lookup', id: '1' }])]);
    const result = await run(client, { lookup: { ...fake, execute: async () => { executed++; return observation; } } }, { maxSteps: 1 });
    expect(executed).toBe(0); expect(client.requests).toHaveLength(1); expect(result.traces[1]!.output?.error?.code).toBe('tool_budget');
  });
  it('取消阻止下个工具和正文，失败步骤报告 aborted', async () => {
    const abort = new AbortController(); let second = 0; const steps: StepInfo[] = [];
    const client = scriptedClient([step('', [{ name: 'first', id: '1' }, { name: 'second', id: '2' }]), step('不应出现')]);
    await expect(run(client, { first: { ...fake, execute: async () => { abort.abort(); return observation; } }, second: { ...fake, execute: async () => { second++; return observation; } } },
      { signal: abort.signal, onStep: async s => { steps.push(s); }, onText: async () => { throw new Error('不应发布'); } })).rejects.toBeDefined();
    expect(second).toBe(0); expect(steps[0]).toMatchObject({ finishReason: 'aborted', usage: null });
  });
  it('guard 拦截请求、执行和文字发布；持久记录失败不执行工具', async () => {
    const denied = scriptedClient([step('不应请求')]);
    await expect(run(denied, {}, { guard: async () => { throw new Error('失去租约'); } })).rejects.toThrow('失去租约'); expect(denied.requests).toHaveLength(0);
    let executed = 0;
    const tool = { ...fake, execute: async () => { executed++; return observation; } };
    await expect(run(scriptedClient([step('', [{ name: 'lookup', id: '1' }])]), { lookup: tool }, { onTool: async () => { throw new Error('写入失败'); } })).rejects.toThrow('写入失败');
    expect(executed).toBe(0);
    let published = 0;
    const client: ModelClient = { provider: 'mock', modelId: 'guard', async *stream() { yield { type: 'text-delta', delta: '不应发布' }; } };
    let checks = 0;
    await expect(run(client, {}, { guard: async () => { if (++checks >= 3) throw new Error('已撤回'); }, onText: async () => { published++; } })).rejects.toThrow('已撤回');
    expect(published).toBe(0);
  });
  it('终答边读边发，auto 步等确认无工具才发布', async () => {
    const variants: Record<string, RuntimeTool>[] = [{}, { lookup: fake }];
    for (const tools of variants) {
      const chunks: string[] = [];
      const client: ModelClient = { provider: 'mock', modelId: 'stream', async *stream() {
        yield { type: 'text-delta', delta: '甲' }; expect(chunks).toEqual(Object.keys(tools).length ? [] : ['甲']);
        yield { type: 'text-delta', delta: '乙' }; yield { type: 'finish', finishReason: 'stop', usage };
      } };
      await run(client, tools, { onText: async t => { chunks.push(t); } });
      expect(chunks).toEqual(Object.keys(tools).length ? ['甲乙'] : ['甲', '乙']);
    }
  });
  it('工具失败变为观察，模型失败不重试且 onStep 记录错误', async () => {
    const result = await run(scriptedClient([step('', [{ name: 'lookup', id: '1' }]), step('没查到')]), { lookup: { ...fake, execute: async () => { throw new Error('失败'); } } });
    expect(result.traces[1]!.output?.error).toEqual({ code: 'tool_failed', retryable: true });
    const client = scriptedClient([new TypeError('网络')]); const steps: StepInfo[] = [];
    await expect(run(client, undefined, { onStep: async s => { steps.push(s); } })).rejects.toThrow('网络');
    expect(client.requests).toHaveLength(1); expect(steps[0]).toMatchObject({ phase: 'tools', finishReason: 'error', usage: null });
  });
  it('时间工具仍按真实时区并拒绝无效时区', async () => {
    const tool = timeTool(() => new Date('2026-09-12T23:30:00Z'));
    const result = await tool.execute({ timeZone: 'Asia/Shanghai' }, new AbortController().signal);
    expect(JSON.stringify(result.data)).toContain('2026年9月13日'); expect(tool.inputSchema.safeParse({ timeZone: 'invented/city' }).success).toBe(false);
  });
});

describe('单步与检查点', () => {
  it('同一步多个工具结果保持旧检查点的单条tool消息格式', async () => {
    const client=scriptedClient([step('',[{name:'report',id:'one'},{name:'report',id:'two'}])]);
    const order:string[]=[];
    const result=await runModelStep({client,instructions:'',messages:[],signal:new AbortController().signal,guard:async()=>{},tools:{
      report:{description:'报告',inputSchema:z.object({}),execute:async(_input,_signal,call)=>{order.push(call.toolCallId);return {saved:call.toolCallId};}},
    }});
    expect(order).toEqual(['one','two']);
    expect(result.responseMessages).toHaveLength(2);
    expect(result.responseMessages[1]).toEqual({role:'tool',content:order.map(id=>({type:'tool-result',toolCallId:id,toolName:'report',output:{type:'json',value:{saved:id}}}))});
  });
  it('只调用一次，顺序执行 report，返回可续跑的 assistant/tool 消息而不自动 finish_tools', async () => {
    const client = scriptedClient([[{ type: 'reasoning-delta', delta: '想' }, ...step('内部文字', [{ name: 'report', id: 'r', input: { status: 'ready' } }])], step('后续')]);
    let callId = '';
    const result = await runModelStep({ client, instructions: '后台', messages: [{ role: 'user', content: '托付' }], signal: new AbortController().signal,
      guard: async () => {}, toolChoice: 'required', maxOutputTokens: 1600, preserveUsers: true, extraBody: { thinking: { type: 'enabled' } },
      tools: { report: { description: '报告', inputSchema: z.object({ status: z.literal('ready') }), execute: async (input, _signal, call) => { callId = call.toolCallId; return { saved: true, status: input.status }; } } } });
    expect(callId).toBe('r'); expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({ toolChoice: 'required', maxOutputTokens: 1600, extraBody: { thinking: { type: 'enabled' } } });
    expect(result.responseMessages).toEqual([
      { role: 'assistant', content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '内部文字' }, { type: 'tool-call', toolCallId: 'r', toolName: 'report', input: { status: 'ready' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'r', toolName: 'report', output: { type: 'json', value: { saved: true, status: 'ready' } } }] },
    ]);
  });
  it.each(['unknown', 'invalid', 'truncated'])('错误模型输出不执行工具 %s', async kind => {
    const client = scriptedClient([kind === 'truncated' ? [] : step('', [{ name: kind === 'unknown' ? 'missing' : 'report', id: '1' }])]);
    let calls = 0;
    await expect(runModelStep({ client, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {}, tools: {
      report: { description: '', inputSchema: z.object({ status: z.string() }), execute: async () => { calls++; return {}; } },
    } })).rejects.toBeInstanceOf(ModelOutputError); expect(calls).toBe(0);
  });

  it('严格模式先预检整批，前项有效后项无效也不执行任何工具', async () => {
    const client = scriptedClient([step('', [
      { name: 'first', id: 'valid', input: { count: 1 } },
      { name: 'last', id: 'invalid', input: { count: 'secret-value' } },
    ])]);
    let executions = 0;
    await expect(runModelStep({ client, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {}, tools: {
      first: { description: '', inputSchema: z.object({ count: z.number() }), execute: async () => { executions++; return {}; } },
      last: { description: '', inputSchema: z.object({ count: z.number() }), execute: async () => { executions++; return {}; } },
    } })).rejects.toBeInstanceOf(ModelOutputError);
    expect(executions).toBe(0);
  });

  it.each(['constructor', 'toString'])('原型工具名 %s 视为未知，不暴露工具清单', async name => {
    const client = scriptedClient([step('', [{ name, id: 'unknown', input: {} }])]);
    const result = await runModelStep({ client, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {},
      recoverToolValidation: true, tools: { lookup: fake } });
    expect(result.toolValidationFailed).toBe(true);
    expect(result.responseMessages[1]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'unknown', output: { value: { error: { code: 'unknown_tool' } } } }] });
    expect(JSON.stringify(result.responseMessages[1])).not.toContain('lookup');
  });

  it('拒绝整批、逐调用回传失败，诊断不包含原始参数或Zod消息', async () => {
    const client = scriptedClient([step('', [
      { name: 'first', id: 'good', input: { value: 1 } },
      { name: 'second', id: 'bad', input: { value: 'private-value' } },
    ])]);
    let executions = 0;
    const hooks: string[] = [];
    const result = await runModelStep({ client, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {},
      recoverToolValidation: true, onToolValidationFailure: async (call, observation) => { hooks.push(`${call.toolCallId}:${observation.error?.code}`); }, tools: {
        first: { description: '', inputSchema: z.object({ value: z.number() }), execute: async () => { executions++; return {}; } },
        second: { description: '', inputSchema: z.object({ value: z.number() }), execute: async () => { executions++; return {}; } },
      } });
    expect(result.toolValidationFailed).toBe(true); expect(executions).toBe(0);
    expect(hooks).toEqual(['good:tool_batch_rejected', 'bad:invalid_tool_input']);
    const rejected = result.responseMessages[1]!;
    expect(rejected).toMatchObject({ role: 'tool', content: [
      { toolCallId: 'good', output: { value: { error: { code: 'tool_batch_rejected' } } } },
      { toolCallId: 'bad', output: { value: { error: { code: 'invalid_tool_input' }, data: { issues: [{ code: 'invalid_type', path: 'value' }] } } } },
    ] });
    expect(JSON.stringify(rejected)).not.toContain('private-value'); expect(JSON.stringify(rejected)).not.toContain('Expected number');
  });

  it('重复或空调用 ID、截断结束原因和未结束流都绝不执行', async () => {
    const duplicate = scriptedClient([step('', [{ name: 'report', id: 'same' }, { name: 'report', id: 'same' }])]);
    const emptyId = scriptedClient([step('', [{ name: 'report', id: '' }])]);
    const incomplete = scriptedClient([[{ type: 'tool-call', toolCallId: 'cut', toolName: 'report', input: {}, rawInput: '{}' }]]);
    const truncated = ['length', 'content-filter', 'error', 'other'].map(reason => scriptedClient([[
      { type: 'tool-call' as const, toolCallId: `cut-${reason}`, toolName: 'report', input: {}, rawInput: '{}' },
      { type: 'finish' as const, finishReason: reason as 'length' | 'content-filter' | 'error' | 'other', usage },
    ]]));
    for (const client of [duplicate, emptyId, incomplete, ...truncated]) {
      let executions = 0;
      await expect(runModelStep({ client, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {}, recoverToolValidation: true,
        tools: { report: { description: '', inputSchema: z.object({}), execute: async () => { executions++; return {}; } } },
      })).rejects.toBeInstanceOf(ModelOutputError);
      expect(executions).toBe(0);
    }
  });

  it('使用 Zod 转换后的输入执行', async () => {
    const client = scriptedClient([step('', [{ name: 'report', id: 'converted', input: { name: '猫' } }])]);
    let received = '';
    await runModelStep({ client, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {}, tools: {
      report: { description: '', inputSchema: z.object({ name: z.string() }).transform(value => ({ name: value.name.toUpperCase() })),
        execute: async input => { received = input.name; return {}; } },
    } });
    expect(received).toBe('猫'.toUpperCase());
  });

  it('中止信号与验证失败持久化异常都不会进入自动修正', async () => {
    const aborted = scriptedClient([step('', [{ name: 'report', id: 'a', input: { value: 'bad' } }])]);
    const controller = new AbortController(); let abortHooks = 0;
    await expect(runModelStep({ client: aborted, instructions: '', messages: [], signal: controller.signal, guard: async () => {}, recoverToolValidation: true,
      onToolValidationFailure: async () => { abortHooks++; controller.abort(); }, tools: {
        report: { description: '', inputSchema: z.object({ value: z.number() }), execute: async () => ({}) },
      } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.requests).toHaveLength(1); expect(abortHooks).toBe(1);

    const persistence = scriptedClient([step('', [{ name: 'report', id: 'p', input: { value: 'bad' } }])]);
    await expect(runModelStep({ client: persistence, instructions: '', messages: [], signal: new AbortController().signal, guard: async () => {}, recoverToolValidation: true,
      onToolValidationFailure: async () => { throw new Error('trace persistence failed'); }, tools: {
        report: { description: '', inputSchema: z.object({ value: z.number() }), execute: async () => ({}) },
      } })).rejects.toThrow('trace persistence failed');
    expect(persistence.requests).toHaveLength(1);
  });
});

describe('前台有界工具修正', () => {
  it('失败轨迹后用下一普通请求修正，且只在修正请求执行工具', async () => {
    const client = scriptedClient([
      step('', [{ name: 'lookup', id: 'bad', input: { count: 'no' } }]),
      step('', [{ name: 'lookup', id: 'good', input: { count: 2 } }]),
      step('完成'),
    ]);
    let executed = 0;
    const result = await run(client, { lookup: { description: '查找', inputSchema: z.object({ count: z.number() }),
      execute: async ({ count }) => { executed++; return { ...observation, data: { count } }; } } }, { maxSteps: 3 });
    expect(client.requests).toHaveLength(3); expect(client.requests[1]!.system).toContain('上一批工具调用已整体拒绝');
    expect(executed).toBe(1);
    expect(result.traces.map(trace => [trace.callId, trace.output?.error?.code, trace.output?.status])).toEqual([
      ['bad', undefined, undefined], ['bad', 'invalid_tool_input', 'failed'], ['good', undefined, undefined], ['good', undefined, 'succeeded'],
    ]);
  });

  it('第二个无效批次严格失败，不增加隐藏请求或工具执行', async () => {
    const client = scriptedClient([step('', [{ name: 'lookup', id: 'one', input: { count: 'bad' } }), step('', [{ name: 'lookup', id: 'two', input: { count: 'bad' } })]);
    let executed = 0;
    await expect(run(client, { lookup: { description: '', inputSchema: z.object({ count: z.number() }), execute: async () => { executed++; return observation; } })).rejects.toBeInstanceOf(ModelOutputError);
    expect(client.requests).toHaveLength(2); expect(executed).toBe(0);
  });

  it('拒绝批次计入工具预算并消耗一个普通步骤', async () => {
    const client = scriptedClient([step('', [{ name: 'lookup', id: 'rejected', input: { count: 'bad' } }]), step('回答')]);
    let executed = 0;
    await run(client, { lookup: { description: '', inputSchema: z.object({ count: z.number() }), execute: async () => { executed++; return observation; } } }, { maxTools: 1, maxSteps: 2 });
    expect(client.requests).toHaveLength(2); expect(client.requests[1]!.toolChoice).toBe('none'); expect(executed).toBe(0);
  });

  it('整批拒绝时不执行 finish_tools，修正请求仍处于工具阶段', async () => {
    const client = scriptedClient([
      step('', [{ name: 'finish_tools', id: 'rejected-finish' }, { name: 'lookup', id: 'bad', input: { count: 'bad' } }]),
      step('', [{ name: 'lookup', id: 'good', input: { count: 1 } }]), step('回答'),
    ]);
    let executed = 0;
    await run(client, { lookup: { description: '', inputSchema: z.object({ count: z.number() }), execute: async () => { executed++; return observation; } } }, { maxSteps: 3 });
    expect(client.requests[1]!.toolChoice).toBe('auto'); expect(executed).toBe(1);
  });

  it('拒绝的世界动作不占世界动作名额，修正后也仍最多执行一次', async () => {
    const client = scriptedClient([
      step('', [{ name: 'move', id: 'rejected-move', input: { place: 1 } }]),
      step('', [{ name: 'move', id: 'corrected-move', input: { place: 'yard' } }]),
      step('', [{ name: 'move', id: 'second-move', input: { place: 'room' } }]),
      step('回答'),
    ]);
    let executed = 0;
    const result = await run(client, { move: { ...fake, changesWorld: true, inputSchema: z.object({ place: z.string() }),
      execute: async () => { executed++; return observation; } } }, { maxSteps: 4 });
    expect(executed).toBe(1);
    expect(result.traces.find(trace => trace.callId === 'rejected-move' && trace.output)?.output?.error?.code).toBe('invalid_tool_input');
    expect(result.traces.find(trace => trace.callId === 'second-move' && trace.output)?.output?.error?.code).toBe('tool_budget');
  });

  it('awaiting 工具开始记录时权限撤回会阻止副作用', async () => {
    const client = scriptedClient([step('', [{ name: 'lookup', id: 'guarded' }])]);
    let allowed = true, executed = 0;
    await expect(run(client, { lookup: { ...fake, execute: async () => { executed++; return observation; } } }, {
      guard: async () => { if (!allowed) throw new Error('permission revoked'); },
      onTool: async trace => { if (!trace.output) { await Promise.resolve(); allowed = false; } },
    })).rejects.toThrow('permission revoked');
    expect(client.requests).toHaveLength(1); expect(executed).toBe(0);
  });
});

describe('56KiB 上下文预算', () => {
  const pair = (id: string, text: string): ModelMessage[] => [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'x', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'x', output: { type: 'text', value: text } }] },
  ];
  it('完整删除旧用户轮次，保留中文 emoji 当前问题与工具链，不修改历史', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: '旧'.repeat(80000) }, { role: 'assistant', content: '回答' }, { role: 'user', content: '现在🙂问题' }, ...pair('a', '结果')];
    const original = JSON.stringify(messages), result = budgetMessages('人格', messages, {});
    expect(result).toEqual(messages.slice(2)); expect(JSON.stringify(messages)).toBe(original); expect(estimateRequest('人格', result, {})).toBeLessThanOrEqual(INPUT_BUDGET);
  });
  it('同轮按完整工具链裁剪，保留最新观察；worker 保留全部用户补充', () => {
    const user: ModelMessage = { role: 'user', content: '当前原话' };
    expect(budgetMessages('', [user, ...pair('old', '旧观察'.repeat(30000)), ...pair('new', '新观察')], {})).toEqual([user, ...pair('new', '新观察')]);
    expect(() => budgetMessages('', [{ role: 'user', content: '原托付'.repeat(20000) }, { role: 'user', content: '补充' }], {}, true)).toThrow('model_input_budget');
    expect(budgetMessages('', [], {})).toEqual([]);
  });
  it('首步和工具后续步都有界，原话完整', async () => {
    const question = '现在的问题🙂保持完整';
    const client = scriptedClient([step('', [{ name: 'lookup', id: '1' }]), step('看到了')]);
    const messages: ModelMessage[] = [{ role: 'user', content: '旧聊天'.repeat(40000) }, { role: 'assistant', content: '旧答复' }, { role: 'user', content: question }];
    const original = JSON.stringify(messages); await run(client, undefined, { messages });
    expect(client.requests).toHaveLength(2); expect(JSON.stringify(messages)).toBe(original);
    for (const request of client.requests) { expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(INPUT_BUDGET); expect(JSON.stringify(request.messages)).toContain(question); }
  });
  it('必需问题和最新工具结果超限，不向模型发送超限请求', async () => {
    const client = scriptedClient([step('不应请求')]);
    await expect(run(client, {}, { messages: [{ role: 'user', content: '🙂中文'.repeat(50000) }] })).rejects.toThrow('model_input_budget'); expect(client.requests).toHaveLength(0);
    const next = scriptedClient([step('', [{ name: 'large', id: '1' }])]);
    await expect(run(next, { large: { ...fake, execute: async () => ({ ...observation, data: '中文🙂'.repeat(30000) }) } })).rejects.toThrow('model_input_budget'); expect(next.requests).toHaveLength(1);
  });
});
