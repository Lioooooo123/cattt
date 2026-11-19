import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelClient } from '../llm/index.ts';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { users,modelReservations } from '../db/schema.ts';
import { config } from '../config.ts';
const account=new AsyncLocalStorage<string>();
export const withModelAccount=<T>(userId:string,run:()=>T):T=>account.run(userId,run);
export class ModelBudgetExceeded extends Error{constructor(){super('model_daily_budget');this.name='ModelBudgetExceeded';}}
/** 每次底层调用/重试前预留，失败和响应丢失均不退还。UTC日不随旅行重复发额度。 */
export function budgetModel(model:ModelClient,purpose:string):ModelClient{
 async function reserve(params:unknown){
  const userId=account.getStore();
  if(!userId){if(config.APP_ENV!=='development')throw new Error('model_account_required');return async(_status:string)=>{};}
  const p=params as {maxOutputTokens:number};const bytes=Buffer.byteLength(JSON.stringify(params));
  const reservedTokens=bytes+p.maxOutputTokens;
  const id=await db.transaction(async tx=>{
   await tx.select().from(users).where(eq(users.id,userId)).for('update');
   const [clock]=await tx.execute<{day:string}>(sql`select to_char(now() at time zone 'UTC','YYYY-MM-DD') as day`);const day=clock!.day;
   const [spent]=await tx.select({calls:sql<number>`count(*)::int`,tokens:sql<number>`coalesce(sum(${modelReservations.reservedTokens}),0)::int`}).from(modelReservations).where(and(eq(modelReservations.userId,userId),eq(modelReservations.day,day)));
   if(spent!.calls>=config.MODEL_DAILY_CALL_LIMIT||spent!.tokens+reservedTokens>config.MODEL_DAILY_TOKEN_LIMIT)throw new ModelBudgetExceeded();
   const [r]=await tx.insert(modelReservations).values({userId,day,purpose,reservedTokens}).returning();return r!.id;
  });
  return async(status:string)=>{await db.update(modelReservations).set({status}).where(eq(modelReservations.id,id));};
 }
 return {provider:model.provider,modelId:model.modelId,async *stream(request,signal){
  const params={...request,maxOutputTokens:Math.min(request.maxOutputTokens??2048,8000)};
  const finish=await reserve(params);let completed=false;
  try{for await(const event of model.stream(params,signal)){if(event.type==='finish')completed=event.finishReason!=='error';yield event;}}
  catch(error){completed=false;throw error;}
  finally{await finish(completed?'completed':'failed');}
 }};
}
export async function jobModelAccount<T>(job:{kind:string;objectId:string},run:()=>Promise<T>):Promise<T>{
 const [r]=await db.execute<{user_id:string}>(sql`select c.user_id from cats c where c.id = case
 when ${job.kind}='memory' then (select v.cat_id from turns t join conversations v on v.id=t.conversation_id where t.id=${job.objectId})
 when ${job.kind}='boundary' then (select cat_id from boundaries where id=${job.objectId})
 when ${job.kind}='diary_read' then (select cat_id from diary_entries where id=${job.objectId})
 when ${job.kind}='report' then (select cat_id from worker_reports where id=${job.objectId})
 when ${job.kind}='errand' then (select t.cat_id from runs r join tickets t on t.id=r.ticket_id where r.id=${job.objectId})
 else (select cat_id from triggers where id=${job.objectId}) end`);
 return r?withModelAccount(r.user_id,run):run();
}
