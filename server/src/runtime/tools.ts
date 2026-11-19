import { historyTools } from './chat-history.ts';
import { messages, turns } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { and,eq } from 'drizzle-orm';
import { config } from '../config.ts';
import { dispatchTicketCommand, type TicketCommand } from '../agent/engine.ts';
import { listTickets, ticketView, TicketError } from '../agent/tickets.ts';
import { z } from 'zod';
import type { Observation, RuntimeTool } from './agent.ts';
import { timeTool, userTimeZone } from './time.ts';
import { weatherTool } from './weather.ts';
import { getActionStatus, getWorldState, moveCat } from '../world/service.ts';
import { WorldError } from '../world/protocol.ts';

export async function catTools(owner: { catId: string; turnId: string; userMessageId: string }): Promise<Record<string, RuntimeTool>> {
  const dispatch = (command: TicketCommand) => dispatchTicketCommand({ catId: owner.catId,
    origin: { source: 'chat', messageId: owner.userMessageId } }, command);
  const observe = async (work: () => Promise<unknown>): Promise<Omit<Observation, 'call_id'>> => {
    try { return { status: 'succeeded', data: await work(), source: 'world-bridge', observed_at: new Date().toISOString() }; }
    catch (error) { return { status: 'failed', error: { code: error instanceof WorldError ? error.code : 'world_failed', retryable: true }, source: 'world-bridge', observed_at: new Date().toISOString() }; }
  };
  const tools: Record<string, RuntimeTool> = {
    ...await historyTools({catId:owner.catId,anchorId:owner.userMessageId,register:async(ids,revision,tx)=>{
      const [turn]=await tx.select().from(turns).where(and(eq(turns.id,owner.turnId),eq(turns.status,'generating'))).for('update');
      if(!turn || turn.contextRevision!==revision)throw new Error('history_context_changed');
      await tx.update(turns).set({contextSourceIds:[...new Set([...(turn.contextSourceIds??[]),...ids])]}).where(eq(turns.id,owner.turnId));
    }}),
    get_time: timeTool(undefined, await userTimeZone(owner.catId)),
    get_weather: weatherTool(),
    get_world_state: { description: '读取猫的真实世界观察；available=false 表示当前不能执行动作。移动中 current 是上次到达位置。', inputSchema: z.object({}), execute: () => observe(() => getWorldState(owner.catId)) },
    get_action_status: { description: '查询已知动作的真实状态，不忙轮询。读取成功仅表示查到了记录。data.status=arrived 才代表到达；陪坐也只有 arrived 才能说坐下了。', inputSchema: z.object({ actionId: z.uuid() }), execute: ({ actionId }) => observe(() => getActionStatus(owner.catId, actionId)) },
  };
  const agreement = async (work: () => Promise<unknown>): Promise<Omit<Observation, 'call_id'>> => {
    try { return {status:'succeeded',data:await work(),source:'saved-agreement',observed_at:new Date().toISOString()}; }
    catch(error) { return {status:'failed',data:{reason:error instanceof TicketError?error.message:'保存未成功'},error:{code:'agreement_failed',retryable:!(error instanceof TicketError)},source:'saved-agreement',observed_at:new Date().toISOString()}; }
  };
  tools.schedule_followup = {
    description:'只在用户明确约定、日期和时间都确定后保存约定。when 为用户本地 ISO 日期时间；先用 get_time 确认用户时区与今天，相对日期据此解析。改天、明晚等模糊时间先问具体几点，不调用。仅 succeeded 凭证才能说约好了。',
    inputSchema:z.object({when:z.string(),about:z.string().trim().min(1).max(60)}),
    execute:({when,about})=>agreement(()=>dispatch({kind:'schedule',when,about})),
  };
  tools.start_errand = {
    description:'只用于用户明确托付的耗时思考、整理。记住、保存或更正用户信息属于本轮记忆保存，绝不是托付；保存失败或不完整也不能交给后台重试。不能联网检索、外部文档或执行代码。成功凭证才可承诺；queued时说“这件我先记着，前面那件办完再来”。',
    inputSchema:z.object({goal:z.string().trim().min(1).max(60)}),execute:({goal})=>agreement(async()=>{
      const [source] = await db.select({text:messages.text}).from(messages).where(eq(messages.id,owner.userMessageId));
      if (source && /记住|记一下|记下来|以后.*记/.test(source.text))
        throw new TicketError(400,'记忆请求由本轮记忆保存处理，不能创建托付；请按本轮实际保存结果回应。');
      return dispatch({kind:'start',goal});
    }),
  };
  tools.list_tickets = {
    description:'读取用户未结束的约定、托付，以及失败或受阻的托付与 ticket_id。用户说改期、取消或继续那件事时先读，按聊天所指直达 update_ticket/cancel_ticket；无法唯一判断就澄清，不另建一件。失败或受阻只在用户明确继续或补充后恢复。',
    inputSchema:z.object({}),execute:()=>agreement(async()=>({tickets:(await listTickets(owner.catId,'actionable')).map(ticketView)})),
  };
  tools.update_ticket = {
    description:'把已有约定改到确定的时间，ticket_id 必须来自 list_tickets。相对日期按 get_time 的用户时区，改成后天可沿用原本地钟点；时间不清楚先问。托付传text保存用户补充；失败或受阻的托付在用户明确继续时由此恢复原事项。成功才说收到了，queued表示仍在排队。不可用when修改托付。',
    inputSchema:z.object({ticket_id:z.uuid(),when:z.string().optional(),text:z.string().trim().min(1).max(2000).optional()}).refine(x=>!!x.when!==!!x.text),
    execute:({ticket_id,when,text})=>agreement(()=>dispatch(text ? {kind:'append',ticketId:ticket_id,text} : {kind:'reschedule',ticketId:ticket_id,when:when!})),
  };
  tools.cancel_ticket = {
    description:'用户明确撤回已有约定或托付时取消，成功才说取消了。ticket_id 来自 list_tickets，指代不明先问清。',
    inputSchema:z.object({ticket_id:z.uuid()}),execute:({ticket_id})=>agreement(()=>dispatch({kind:'cancel',ticketId:ticket_id})),
  };
  const performAction = async (dispatch: () => ReturnType<typeof moveCat>, signal: AbortSignal) => {
    const result = await observe(async () => {
      let action = await dispatch();
      const deadline = performance.now() + 2_000;
      while ((action.status === 'requested' || (action.activity === 'sit' && ['accepted', 'running'].includes(action.status))) && performance.now() < deadline) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 100));
        action = await getActionStatus(owner.catId, action.id);
      }
      return { actionId: action.id, status: action.status, destinationId: action.destinationId, activity: action.activity, reason: action.reason };
    });
    if (result.status === 'failed') return result;
    const data = result.data as { status: string };
    if (['accepted', 'running'].includes(data.status)) return { ...result, status: 'accepted' as const };
    if (data.status === 'arrived') return result;
    return { ...result, status: 'failed' as const, error: { code: data.status === 'requested' ? 'accept_unknown' : `action_${data.status}`, retryable: false } };
  };
  const world = await getWorldState(owner.catId);
  if (world.available) tools.move_cat = {
    description: '用户明确要求去某个地点时移动。先 get_world_state 获取 sessionId、generation 和 stateVersion；地点必须来自该观察的 destinationIds。邀请陪坐使用 sit_together。',
    inputSchema: z.object({ destinationId: z.string().max(80), stateVersion: z.number().int().min(0), sessionId: z.uuid(), generation: z.uuid() }),
    changesWorld: true,
    execute: (input, signal) => performAction(() => moveCat({ ...input, ...owner }), signal),
  };
  if (world.available && world.companionSeat) tools.sit_together = {
    description: '用户明确邀请一起坐、陪坐片刻时调用一次。由院子根据性格和当下状态选座。用户只想说话、倾诉或询问时不要调用。只有 arrived 才表示已坐稳，其余只简短回应陪伴。',
    inputSchema: z.object({}),
    changesWorld: true,
    execute: (_, signal) => performAction(async () => {
      const state = await getWorldState(owner.catId);
      if (!state.available || !state.companionSeat || !state.sessionId || !state.generation || state.stateVersion === undefined) throw new WorldError('seat_unavailable');
      return moveCat({ ...owner, sessionId: state.sessionId, generation: state.generation, stateVersion: state.stateVersion,
        destinationId: state.companionSeat, activity: 'sit' });
    }, signal),
  };
  if(config.AGENT_ENABLED==='false')for(const name of ['schedule_followup','start_errand','update_ticket'])delete tools[name];
  return tools;
}
