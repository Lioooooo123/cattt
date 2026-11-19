import { followupText } from '../agent/router.ts';
import { localISO, parseFollowupTime } from '../agent/tickets.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelClient, ModelEvent, ModelRequest, ModelMessage, ModelUsage } from '../llm/index.ts';
import { config } from '../config.ts';

/**
 * 假模型：MODEL_PROVIDER=mock 时用。不花钱、结果固定，测试和没有 key 时用它。
 * 用户消息里的测试标记：
 * - [fail]  每次都在吐了几个字之后报错
 * - [fail1] 同一句话只在第一次报错，用来测「再试一次」
 * - [slow]  每个字停 300ms，用来测停止、作废和续传
 */
const failedOnce = new Set<string>();

type MockMessage = { role: 'system'; content: string }
  | { role: 'user'; content: { type: 'text'; text: string }[] }
  | Extract<ModelMessage, { role: 'assistant' | 'tool' }>;
type MockRequest = Omit<ModelRequest, 'messages'> & { messages: MockMessage[] };
type MockReply = { stream?: AsyncIterable<ModelEvent>; content?: ({ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: string })[]; usage?: ModelUsage };
function mockClient(options: { provider: string; modelId: string; doGenerate?: (request: MockRequest) => Promise<MockReply>; doStream?: (request: MockRequest) => Promise<MockReply> }): ModelClient {
  return { provider: options.provider, modelId: options.modelId, async *stream(request, signal) {
    const signals = [request.signal, signal].filter((s): s is AbortSignal => !!s);
    const combined = signals.length ? AbortSignal.any(signals) : undefined;
    combined?.throwIfAborted();
    const messages: MockMessage[] = request.messages.map(m => m.role === 'user' && typeof m.content === 'string' ? { role: 'user', content: [{ type: 'text', text: m.content }] } : m) as MockMessage[];
    if (request.system) messages.unshift({ role: 'system', content: request.system });
    const result = await (options.doStream ?? options.doGenerate)!({ ...request, messages, signal: combined });
    if (result.stream) { yield* result.stream; return; }
    let hasTools = false;
    for (const part of result.content ?? []) {
      combined?.throwIfAborted();
      if (part.type === 'text') yield { type: 'text-delta', delta: part.text };
      else { hasTools = true; yield { ...part, input: JSON.parse(part.input), rawInput: part.input }; }
    }
    yield { type: 'finish', finishReason: hasTools ? 'tool-calls' : 'stop', usage: result.usage! };
  } };
}


export function mockDiaryModel() {
  return mockClient({ provider: 'mock', modelId: 'mock-diary', doGenerate: async options => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ comment: lastUserText(options).includes('[quiet]') ? null : '在这里陪你坐一会儿。' }) }], usage: usage(100, 20),
  }) });
}

const usage = (input: number, output: number): ModelUsage => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: 0, reasoningTokens: 0,
});

function lastUserText(options: MockRequest): string {
  for (let i = options.messages.length - 1; i >= 0; i--) {
    const m = options.messages[i]!;
    if (m.role === 'user') {
      return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    }
  }
  return '';
}

export function mockChatModel() {
  return mockClient({
    provider: 'mock',
    modelId: 'mock-chat',
    doStream: async (options) => {
      const said = lastUserText(options);
      if (options.toolChoice !== 'none' && options.tools?.length) {
        const toolReplies = options.messages.filter((m) => m.role === 'tool').flatMap((m) => m.content);
        const hasTime = toolReplies.some((p) => p.type === 'tool-result' && p.toolName === 'get_time');
        const worldReply = toolReplies.find((p) => p.type === 'tool-result' && p.toolName === 'get_world_state');
        const hasMove = toolReplies.some((p) => p.type === 'tool-result' && p.toolName === 'move_cat');
        let toolName = said.includes('[time]') && !hasTime ? 'get_time' : 'finish_tools';
        let toolInput: object = {};
        if (said.includes('[move]') && !hasMove) {
          if (!worldReply) toolName = 'get_world_state';
          else if (worldReply.type === 'tool-result' && worldReply.output.type === 'json') {
            const observation = worldReply.output.value as { data?: { available?: boolean; sessionId: string; generation: string; stateVersion: number } };
            if (observation.data?.available && options.tools.some(t => t.name === 'move_cat')) {
              toolName = 'move_cat';
              toolInput = { destinationId: 'pond', sessionId: observation.data.sessionId, generation: observation.data.generation, stateVersion: observation.data.stateVersion };
            }
          }
        }
        const currentResults = options.messages.slice(options.messages.map(m=>m.role).lastIndexOf('user')+1).filter(m=>m.role==='tool').flatMap(m=>m.content).filter(p=>p.type==='tool-result');
        const has = (name:string) => currentResults.some(p=>p.toolName===name);
        if (['陪我坐一会儿', '今天有点累，陪我坐一会儿'].includes(said.replace(/[。！？]$/, '')) &&
            options.tools.some(t => t.name === 'sit_together') && !has('sit_together')) {
          toolName = 'sit_together';
        }
        const list = currentResults.find(p=>p.toolName==='list_tickets');
        const listed = list?.output.type==='json' ? (list.output.value as any)?.data?.tickets : [];
        const systemText = options.messages.find(m=>m.role==='system')?.content ?? '';
        const timeReply = currentResults.find(p=>p.toolName==='get_time');
        const observedZone=timeReply?.output.type==='json' ? (timeReply.output.value as any)?.data?.timeZone : undefined;
        const zone = observedZone ?? systemText.match(/时区[：:] ?([A-Za-z_]+\/[A-Za-z_]+)/)?.[1] ?? 'Asia/Shanghai';
        const marked = said.match(/\[followup:([^|]+)\|([^\]]+)\]/);
        const wantsChange = /改成|改到|取消/.test(said) && !/记住|更正/.test(said);
        const errand = said.match(/\[errand:([\s\S]+)\]/);
        const addInput = said.match(/\[ticket-input:([^\]]+)\]/);
        if(addInput && !has('update_ticket')) {
          if(!has('list_tickets')) {toolName='list_tickets';toolInput={};}
          else if(listed?.length===1) {toolName='update_ticket';toolInput={ticket_id:listed[0].id,text:addInput[1]};}
        } else if((errand || /帮我想想|想好了告诉我/.test(said)) && !has('start_errand')) {
          toolName='start_errand';toolInput={goal:errand?.[1]??said.slice(0,60)};
        } else if(wantsChange && !has('update_ticket') && !has('cancel_ticket')) {
          if(!has('get_time')) { toolName='get_time'; toolInput={}; }
          else if(!has('list_tickets')) { toolName='list_tickets'; toolInput={}; }
          else if(listed?.length===1) {
            const ticket=listed[0];
            if(said.includes('取消')) {toolName='cancel_ticket';toolInput={ticket_id:ticket.id};}
            else {
              const date=new Date(); const day=localISO(date,zone).slice(0,10); const base=new Date(day+'T12:00:00Z'); base.setUTCDate(base.getUTCDate()+(said.includes('后天')?2:1));
              toolName='update_ticket';toolInput={ticket_id:ticket.id,when:base.toISOString().slice(0,10)+'T'+localISO(new Date(ticket.due_at),zone).slice(11)};
            }
          }
        } else if((marked || /问我|提醒我/.test(said)) && !has('schedule_followup')) {
          let when=marked?.[1]?.trim();
          const minutes=said.match(/(\d+)分钟后/);
          if(minutes) when=localISO(new Date(Date.now()+Number(minutes[1])*60000),zone);
          const explicit=said.match(/(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?)/); if(explicit && !marked) when=explicit[1]!.replace(' ','T');
          if(!when) {
            const hour=said.match(/(\d{1,2})[点时]/);
            if(hour && /明天|后天/.test(said)) { const day=new Date(localISO(new Date(),zone).slice(0,10)+'T12:00:00Z');day.setUTCDate(day.getUTCDate()+(said.includes('后天')?2:1)); when=day.toISOString().slice(0,10)+'T'+String(Number(hour[1])+(/下午|晚上/.test(said)&&Number(hour[1])<12?12:0)).padStart(2,'0')+':00:00'; }
          }
          if(when) {toolName='schedule_followup';toolInput={when,about:marked?.[2]?.trim() ?? said.split(/问我|提醒我/).at(-1)!.replace(/[。！]$/,'').slice(0,60)}; if(!has('get_time')) {toolName='get_time';toolInput={};}}
        }
        return { content: [{ type: 'tool-call', toolCallId: `mock-${toolName}`, toolName, input: JSON.stringify(toolInput) }],
          usage: usage(200, 5) };

      }
      const system = options.messages.find(m => m.role === 'system')?.content ?? '';
      const recalled = system.match(/## 你记得的事\n([\s\S]*?)(?=\n\n|$)/)?.[1]?.trim();
      const diary = system.match(/## 本轮日记来源\n([^\n]+)/)?.[1];
      const finalTools=options.messages.slice(options.messages.map(m=>m.role).lastIndexOf('user')+1).filter(m=>m.role==='tool').flatMap(m=>m.content).filter(p=>p.type==='tool-result');
      const agreement=finalTools.find(p=>['schedule_followup','start_errand','update_ticket','cancel_ticket'].includes(p.toolName));
      const observation=agreement?.output.type==='json' ? agreement.output.value as any : undefined;
      const confirmation=observation?.status==='succeeded'
        ? agreement!.toolName==='start_errand' ? (observation.data.queued?'这件我先记着，前面那件办完再来。':'好，我想想，想好了留封信给你。')
        : agreement!.toolName==='cancel_ticket'?'好，这件事取消了。'
        : observation.data.when ? `好，${agreement!.toolName==='update_ticket'?'改好了':'约好了'}，${observation.data.when.replace('T',' ')}，到时候问你。` : '好，这句也放进那件事里了。'
        : agreement?'这次没存好，稍后再试。': /改天|明晚/.test(said)&&/问我|提醒我/.test(said)?'你想约哪一天、几点呢？':undefined;
      const sitting = finalTools.some(p => p.toolName === 'sit_together');
      const reply = confirmation ?? (sitting ? '嗯，我陪你。' : undefined) ?? (said.includes('[diary]') ? `合成验收：本轮日记来源${diary ?? '为空'}`
        : said.includes('[recall]') ? `合成验收：本轮可参考的长期记忆${recalled ? `如下。\n${recalled}` : '为空。'}`
        : `喵，我听到了：「${said.replace(/\[(fail1?|slow)\]/g, '').trim()}」。`);
      // 诊断回复只验证上下文到达，不逐字放大本机PG往返；故障/慢流标记仍按字输出。
      const chars = /\[(recall|diary)\]/.test(said) && !/\[(fail1?|slow)\]/.test(said) ? [reply] : Array.from(reply);
      const delayMs = said.includes('[slow]') ? 300 : config.MOCK_DELAY_MS;
      let shouldFail = said.includes('[fail]');
      if (said.includes('[fail1]') && !failedOnce.has(said)) {
        failedOnce.add(said);
        shouldFail = true;
      }
      return { stream: (async function* (): AsyncGenerator<ModelEvent> {
        for (const [i, ch] of chars.entries()) {
          await delay(delayMs, undefined, { signal: options.signal });
          if (shouldFail && i === 3) throw new Error('mock model failure');
          yield { type: 'text-delta', delta: ch };
        }
        yield { type: 'finish', finishReason: 'stop', usage: usage(said.length + 200, chars.length) };
      })() };

    },
  });
}

/**
 * 假的记忆提取：
 * - 「记住……」→ 一条用户明确要记的
 * - 「我喜欢……」→ 一条普通偏好
 * 其余不提取。
 */
export function mockExtractModel() {
  return mockClient({
    provider: 'mock',
    modelId: 'mock-extract',
    doGenerate: async (options) => {
      const said = lastUserText(options);
      const system = options.messages.find((m) => m.role === 'system')?.content ?? '';
      // 边界整理：返回一个短语
      if (system.includes('概括')) {
        const text = `关于「${Array.from(said).slice(0, 6).join('')}」的事`;
        return {
          content: [{ type: 'text', text }],
          usage: usage(100, 10),
        };
      }
      const found: unknown[] = [];
      // 按行匹配：对话里猫也会复述用户的话，只取第一处（用户那行）
      const remember = said.match(/记住(.+?)(?:[。！!]|$)/m);
      if (remember) {
        found.push({
          subject: '用户',
          predicate: '让你记住的事',
          value: remember[1]!.trim(),
          kind: 'fact',
          confidence: 0.95,
          sensitivity: 'low',
          explicit: true,
          correction: false,
        });
      }
      const like = said.match(/我喜欢(.+?)(?:[。！!，,]|$)/m);
      if (like) {
        found.push({
          subject: '用户',
          predicate: '喜欢的东西',
          value: like[1]!.trim(),
          kind: 'preference',
          confidence: 0.8,
          sensitivity: 'low',
          explicit: false,
          correction: false,
        });
      }
      const text = JSON.stringify({ memories: found });
      return {
        content: [{ type: 'text', text }],
        usage: usage(300, text.length),
      };
    },
  });
}

/** 测试扩词仅模拟结构化返回，不代表真实模型理解质量。 */
export function mockRecallModel() {
  return mockClient({
    provider: 'mock', modelId: 'mock-recall',
    doGenerate: async options => {
      const query = lastUserText(options);
      const terms = /烧脑.*(读物|看)|硬核.*(读物|看)/.test(query) ? ['阅读', '小说', '科幻']
        : /晚饭|晚餐|吃什么/.test(query) ? ['饮食', '口味', '忌口']
        : /提神|清醒/.test(query) ? ['咖啡', '饮品', '茶饮'] : [];
      const text = JSON.stringify({ terms });
      return { content: [{ type: 'text', text }], usage: usage(query.length + 180, text.length) };
    },
  });
}

export function mockRouterModel() {
  return mockClient({provider:'mock',modelId:'mock-router',doGenerate:async options=>{
    const snapshot=JSON.parse(lastUserText(options));
    if(snapshot.worker_report)return {content:[{type:'text' as const,text:JSON.stringify({text:'我想好了一些，放在信箱里了，想看时再拆。'})}],usage:usage(200,30)};
    if(snapshot.inference)return {content:[{type:'text' as const,text:JSON.stringify({decision:snapshot.event?'accept':'ignore',rule_assessments:[{rule_id:snapshot.rule.rule_id,version:snapshot.rule.version,matched:!!snapshot.event}],evidence:snapshot.event?[{message_id:snapshot.source.id,quote:snapshot.source.text}]:[],topic:snapshot.event?.topic,after_at:snapshot.event?.after_at,resolved:false})}],usage:usage(200,100)};
    if ('facts' in snapshot) return {content:[{type:'text' as const,text:JSON.stringify({has_events:snapshot.facts.length>0,fact_ids:snapshot.facts.map((f:{id:string})=>f.id)})}],usage:usage(100,30)};
    if(snapshot.tickets.some((t:{goal:string})=>t.goal.includes('[route-fail]'))) throw new Error('mock route failure');
    return {content:[{type:'text' as const,text:JSON.stringify({decision:'attach',ticket_ids:snapshot.tickets.map((t:{id:string})=>t.id),merge:true,text:followupText(snapshot.tickets),rule_assessments:[{rule_id:'followup_due',matched:true,reason:'用户亲口约定到期'}]})}],usage:usage(150,50)};
  }});
}

/** 后台假模型：每步仍经过自研工具循环；标记仅用于固定验收反例。 */
export function mockWorkerModel(options:{onRequest?:()=>void|Promise<void>}={}) {
 return mockClient({provider:'mock',modelId:'mock-worker',doGenerate:async call=>{
 await options.onRequest?.();
 const goal=call.messages.filter(m=>m.role==='user').flatMap(m=>m.content).filter(p=>p.type==='text').map(p=>p.text).join('\n');
 if(call.messages.some(m=>m.role==='system'&&m.content.includes('写每日猫日记'))) {const card=JSON.parse(goal);return {content:[{type:'text' as const,text:JSON.stringify({reflection:'有些小念头，不必急着弄明白。我想把心里的柔软留在这一页，慢慢想。',fact_ids:card.facts.slice(0,4).map((f:{id:string})=>f.id)})}],usage:usage(100,40)};}
 const observations=call.messages.filter(m=>m.role==='tool').flatMap(m=>m.content).filter(p=>p.type==='tool-result');
 const has=(name:string)=>observations.some(p=>p.toolName===name);
 const inputs=goal.match(/用户补充：([^\n]+)/g)?.join('；')??'';
 let toolName='report',input:Record<string,unknown>;
 if(goal.includes('[memory]')&&!has('recall_memories')){toolName='recall_memories';input={query:'周末建议'};}
 else if(goal.includes('[diary]')&&!has('read_permitted_diary')){toolName='read_permitted_diary';input={};}
 else if(goal.includes('[loop]')||goal.includes('[output-budget]'))input={status:'progress'};
 else if(goal.includes('[waiting]')&&!inputs)input={status:'waiting',question:'周末想出门，还是想待在家里？'};
 else if(goal.includes('[blocked]'))input={status:'blocked',reason:'这件事需要联网查证，我现在查不了。'};
 else if(goal.includes('[failed]'))input={status:'failed',reason:'这次没能想出可靠的办法。'};
 else if(goal.includes('[dropped]'))input={status:'dropped'};
 else if(!has('report')&&!has('recall_memories')&&!has('read_permitted_diary'))input={status:'progress'};
 else input={status:'ready',result:'我想了想，周末可以留一段不用赶时间的空当，散散步，或者在家看点喜欢的东西。'+inputs};
 if(goal.includes('[whitelist]')&&call.tools?.some(t=>!['get_time','get_weather','recall_memories','read_permitted_diary','search_chat_history','read_chat_history','report'].includes(t.name)))throw new Error('unexpected worker tool');
 const index=observations.length;
 return {content:[{type:'tool-call',toolCallId:`mock-worker-${index}`,toolName,input:JSON.stringify(input)}],usage:usage(200,goal.includes('[output-budget]')?4000:60)};
 }});
}
