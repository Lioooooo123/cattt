import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const modelAdmissions = pgTable('model_admissions', {
  id: id(),
  resource: text('resource').notNull(),
  lane: text('lane').notNull(),
  purpose: text('purpose').notNull(),
  state: text('state').notNull(),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, t => [
  check('model_admissions_lane_check', sql`${t.lane} in ('chat', 'background')`),
  check('model_admissions_state_check', sql`${t.state} in ('waiting', 'running')`),
  index('model_admissions_queue_idx').on(t.resource, t.state, t.lane, t.createdAt),
]);

export const users = pgTable('users', {
  id: id(),
  devTokenHash: text('dev_token_hash').unique(),
  /** 以后接 Sign in with Apple 时填 */
  appleSub: text('apple_sub').unique(),
  name: text('name'),
  hostOwner: boolean('host_owner').notNull().default(false),
  timeZone: text('time_zone').notNull().default('Asia/Shanghai'),
  createdAt: createdAt(),
}, t => [uniqueIndex('users_single_host_owner').on(t.hostOwner).where(sql`${t.hostOwner} = true`)]);

export const pairingCodes = pgTable('pairing_codes', {
  codeHash: text('code_hash').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  burnedAt: timestamp('burned_at', { withTimezone: true }),
});

export const pairedDevices = pgTable('paired_devices', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** 四条特征的档位：0 低 / 1 中 / 2 高 */
export type Traits = { energy: number; initiative: number; directness: number; closeness: number };

export const cats = pgTable('cats', {
  id: id(),
  /** 开发者版一人一猫 */
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  appearance: text('appearance').notNull(),
  temperament: text('temperament').notNull(),
  traits: jsonb('traits').$type<Traits>().notNull(),
  /** 改性格时 +1，只影响之后的表达 */
  personaVersion: integer('persona_version').notNull().default(1),
  allowProactive: boolean('allow_proactive').notNull().default(false),
  proactiveRevision: integer('proactive_revision').notNull().default(0),
  learnMemories: boolean('learn_memories').notNull().default(true),
  useMemories: boolean('use_memories').notNull().default(true),
  memoryRevision: integer('memory_revision').notNull().default(0),
  learnAfterSeq: integer('learn_after_seq').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: id(),
  /** 开发者版一只猫一段连续对话 */
  catId: uuid('cat_id').notNull().unique().references(() => cats.id, { onDelete: 'cascade' }),
  /** 每来一条用户消息 +1，新鲜度复核用 */
  version: integer('version').notNull().default(0),
  createdAt: createdAt(),
});

export const messageRole = pgEnum('message_role', ['user', 'cat']);
export const messageStatus = pgEnum('message_status', ['done', 'stopped']);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    /** 排序和翻页用 */
    seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRole('role').notNull(),
    contextAllowed: boolean('context_allowed').notNull().default(true),
    memoryEligible: boolean('memory_eligible').notNull().default(true),
    text: text('text').notNull(),
    status: messageStatus('status').notNull().default('done'),
    /** 客户端生成的 id，发送失败重试不会存两条；猫的消息为空 */
    clientMessageId: text('client_message_id'),
    diaryEntryId: uuid('diary_entry_id'),
    /** 猫的消息属于哪一轮 */
    turnId: uuid('turn_id'),
    ticketId: uuid('ticket_id').references((): AnyPgColumn => tickets.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_client_id').on(t.conversationId, t.clientMessageId),
    index('messages_conversation_seq').on(t.conversationId, t.seq),
    uniqueIndex('messages_cat_turn').on(t.turnId).where(sql`${t.role} = 'cat'`),
  ],
);

export const turnStatus = pgEnum('turn_status', [
  'queued',
  'generating',
  'completed',
  'stopped',
  'superseded',
  'failed',
]);

export const turns = pgTable(
  'turns',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userMessageId: uuid('user_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** 建这一轮时的 conversation.version */
    inputVersion: integer('input_version').notNull(),
    status: turnStatus('status').notNull().default('queued'),
    catMessageId: uuid('cat_message_id'),
    /** 这一轮注入了哪些记忆 */
    memoryIds: uuid('memory_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    contextSourceIds: uuid('context_source_ids').array(),
    contextRevision: integer('context_revision'),
    diarySourceIds: uuid('diary_source_ids').array().notNull().default(sql`'{}'::uuid[]`),
    model: text('model'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    firstTokenAt: timestamp('first_token_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    /** worker 提取完记忆的时间；iOS 轮询「记下了」看它 */
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    /** 这一轮用户明确要记的内容记下了（新写入或确认了已有的） */
    remembered: boolean('remembered').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('turns_conversation_status').on(t.conversationId, t.status),
    index('turns_stale_active').on(sql`coalesce(${t.heartbeatAt}, ${t.createdAt})`).where(sql`${t.status} in ('queued', 'generating')`)],
);

export const modelCalls = pgTable('model_calls', {
  id: id(),
  turnId: uuid('turn_id'),
  jobId: text('job_id'),
  /** chat / memory_extract / boundary_summarize */
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  latencyMs: integer('latency_ms'),
  createdAt: createdAt(),
});

export const sensitivity = pgEnum('memory_sensitivity', ['low', 'medium', 'high']);
export const memoryStatus = pgEnum('memory_status', ['active', 'superseded', 'conflicted']);

export const memories = pgTable(
  'memories',
  {
    id: id(),
    catId: uuid('cat_id')
      .notNull()
      .references(() => cats.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    predicate: text('predicate').notNull(),
    value: text('value').notNull(),
    confidence: real('confidence').notNull(),
    sensitivity: sensitivity('sensitivity').notNull(),
    scope: text('scope').notNull().default('cat'),
    status: memoryStatus('status').notNull().default('active'),
    /** 用户明确说了「记住」 */
    explicit: boolean('explicit').notNull().default(false),
    /** subject + predicate 归一化后的哈希；阻断和冲突判断都按它 */
    fingerprint: text('fingerprint').notNull(),
    sourceMessageId: uuid('source_message_id').notNull(),
    extractorVersion: text('extractor_version').notNull(),
    editedThroughSeq: integer('edited_through_seq').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    createdAt: createdAt(),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 同一条来源消息重复提取不会写两遍
    uniqueIndex('memories_source_fingerprint').on(t.sourceMessageId, t.fingerprint),
    index('memories_cat_status').on(t.catId, t.status),
  ],
);

/** 删掉记忆后留下的阻断记录，只有指纹，没有原文 */
export const memoryBlocks = pgTable(
  'memory_blocks',
  {
    id: id(),
    catId: uuid('cat_id')
      .notNull()
      .references(() => cats.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    sourceSeq: integer('source_seq').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memory_blocks_cat_fingerprint').on(t.catId, t.fingerprint)],
);

/** 「不要再提」 */
export const boundaries = pgTable('boundaries', {
  id: id(),
  catId: uuid('cat_id')
    .notNull()
    .references(() => cats.id, { onDelete: 'cascade' }),
  sourceMessageId: uuid('source_message_id').notNull().unique(),
  /** worker 从那条消息整理出的一句话；整理好之前为空，先用原文 */
  description: text('description'),
  createdAt: createdAt(),
}, (t) => [index('boundaries_cat_created').on(t.catId, t.createdAt)]);

/** PG 是异步待办的真相源，pg-boss 负责可重建的投递。 */
export const asyncJobs = pgTable('async_jobs', {
  id: id(),
  kind: text('kind').notNull(),
  sourceId: uuid('source_id').notNull(),
  objectId: uuid('object_id').notNull(),
  version: text('version').notNull(),
  state: text('state').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  error: text('error'),
  remembered: boolean('remembered').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('async_jobs_source_kind_version').on(t.sourceId, t.kind, t.version),
  index('async_jobs_state_next_attempt').on(t.state, t.nextAttemptAt),
  index('async_jobs_state_lease').on(t.state, t.leaseUntil)]);

/** 即使候选仅确认已有记忆，也保存来源凭证，重放不能再次改变状态。 */
export const memoryReceipts = pgTable('memory_receipts', {
  questionId: uuid('question_id').references(() => messages.id),
  catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  sourceMessageId: uuid('source_message_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  accepted: boolean('accepted').notNull(),
}, (t) => [uniqueIndex('memory_receipts_source_fingerprint').on(t.sourceMessageId, t.fingerprint),
  index('memory_receipts_cat_question').on(t.catId, t.questionId),
  index('memory_receipts_cat_source').on(t.catId, t.sourceMessageId)]);

/** 同步保存与模型读取是两种许可；private 记录可同步但不能进入模型。 */
export const diaryEntries = pgTable('diary_entries', {
  id: id(),
  changeSeq: bigint('change_seq', { mode: 'number' }).notNull().default(0),
  seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
  catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  kind: text('kind').notNull(),
  text: text('text').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  timeZone: text('time_zone').notNull(),
  day: text('day').notNull(),
  time: text('time').notNull(),
  catAllowed: boolean('cat_allowed').notNull().default(false),
  revision: integer('revision').notNull().default(1),
  mutationId: uuid('mutation_id').notNull(),
  visit: integer('visit').notNull().default(0),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('diary_cat_client').on(t.catId, t.clientId), index('diary_cat_seq').on(t.catId, t.seq),
  index('diary_cat_change').on(t.catId, t.changeSeq)]);

export * from './schema-world.ts';
export * from './schema-soul.ts';
export * from './schema-runtime.ts';

/** 第二段只建立约定领域，不预建执行者。 */
export const triggers = pgTable('triggers', {
  id: id(), catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  payload: jsonb('payload').$type<{ ticket_id?: string; due_at?: string; message_id?: string; when?: string; about?: string; local_day?: string; time_zone?: string; start_at?: string; end_at?: string; inference_rule?: string; permission_revision?: number; watch_id?: string; command?: { kind: string; fingerprint: string }; receipt?: Record<string, string | boolean> }>().notNull(), receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('triggers_identity').on(t.catId, t.source, t.idempotencyKey)]);
export type Mandate = { kind: 'explicit'; source_message_id: string } | { kind: 'inferred'; rule_id: string; version: number; source_hash?: string; source_message_id?: string; permission_revision?: number; topic?: string };
export const tickets = pgTable('tickets', {
  id: id(), catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), goal: text('goal').notNull(), mandate: jsonb('mandate').$type<Mandate>().notNull(),
  status: text('status').notNull().default('open'), stage: text('stage').notNull().default('scheduled'),
  dueAt: timestamp('due_at', { withTimezone: true }), timeZone: text('time_zone'), localDay: text('local_day'),
  sourceMessageId: uuid('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
  endedReason: text('ended_reason'), createdAt: createdAt(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('tickets_due').on(t.status, t.dueAt), uniqueIndex('tickets_diary_day').on(t.catId, t.localDay).where(sql`${t.kind} = 'diary'`),
  check('tickets_kind', sql`${t.kind} in ('followup','errand','diary')`), check('tickets_status', sql`${t.status} in ('open','ended')`)]);
export const decisions = pgTable('decisions', {
  id: id(), triggerId: uuid('trigger_id').notNull().references(() => triggers.id, { onDelete: 'cascade' }),
  outcome: text('outcome').notNull(), reasons: jsonb('reasons').notNull(), ruleVersion: integer('rule_version').notNull().default(1),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }), createdAt: createdAt(),
}, t => [check('decisions_outcome', sql`${t.outcome} in ('accept','attach','ignore','silent')`)]);
export const ticketInputs = pgTable('ticket_inputs', {
  id: id(), ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }), text: text('text'),
  readAt: timestamp('read_at', { withTimezone: true }), createdAt: createdAt(),
});
export const outbox = pgTable('outbox', {
  id: id(), seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
  catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }), purpose: text('purpose').notNull(),
  kind: text('kind').notNull(), status: text('status').notNull().default('pending'), droppedReason: text('dropped_reason'), createdAt: createdAt(),
}, t => [uniqueIndex('outbox_ticket_purpose').on(t.ticketId, t.purpose), check('outbox_kind', sql`${t.kind} in ('chat_message','mailbox_letter','push')`), check('outbox_status', sql`${t.status} in ('pending','sent','dropped')`)]);
export const mailboxLetters = pgTable('mailbox_letters', {
  id: id(), seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
  catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }), text: text('text').notNull(),
  createdAt: createdAt(), readAt: timestamp('read_at', { withTimezone: true }),
}, t => [index('mailbox_cat_seq').on(t.catId, t.seq)]);
export const proactiveRules = pgTable('proactive_rules', {
  id: id(), ruleId: text('rule_id').notNull(), version: integer('version').notNull(), text: text('text').notNull(), mode: text('mode').notNull(),
}, t => [uniqueIndex('proactive_rules_version').on(t.ruleId, t.version), check('proactive_rules_mode', sql`${t.mode} in ('off','observe','auto')`)]);

/** 托付只保存完整模型步骤；report凭证在工具返回前持久化，恢复不重复副作用。 */
export type ErrandReport = {status:'progress'|'waiting'|'ready'|'blocked'|'failed'|'dropped';question?:string;result?:string;reason?:string};
export type RunJournal = {
 calls:Record<string,ErrandReport>;
 active?:ErrandReport & {callId:string;createdAt:string;runtimeFailure?:true};
 dependencies:{messages:string[];diaries:{id:string;revision:number}[];usedMemories:boolean;memoryRevision?:number};
 version?:number;timeZone?:string;freshRetries:number;
};
export const runs=pgTable('runs',{
 id:id(),ticketId:uuid('ticket_id').notNull().references(()=>tickets.id,{onDelete:'cascade'}),
 generation:integer('generation').notNull().default(0),localDay:text('local_day'),
 status:text('status').notNull().default('pending'),attempt:integer('attempt').notNull().default(0),
 leaseUntil:timestamp('lease_until',{withTimezone:true}),report:jsonb('report').$type<RunJournal>().notNull().default({calls:{},dependencies:{messages:[],diaries:[],usedMemories:false},freshRetries:0}),
 outputTokens:integer('output_tokens').notNull().default(0),elapsedMs:integer('elapsed_ms').notNull().default(0),
 stepStartedAt:timestamp('step_started_at',{withTimezone:true}),
 createdAt:createdAt(),
},t=>[uniqueIndex('runs_ticket_generation').on(t.ticketId,t.generation),uniqueIndex('runs_one_running').on(t.ticketId).where(sql`${t.status} = 'running'`),check('runs_status',sql`${t.status} in ('pending','running','ended')`)]);
export const runSteps=pgTable('run_steps',{
 id:id(),runId:uuid('run_id').notNull().references(()=>runs.id,{onDelete:'cascade'}),step:integer('step').notNull(),
 messages:jsonb('messages').$type<import('ai').ModelMessage[]>().notNull(),usage:jsonb('usage').$type<{outputTokens:number}>().notNull(),
 finishedAt:timestamp('finished_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('run_steps_checkpoint').on(t.runId,t.step)]);

/** 已确认的日内观察，仅存地点/活动，不把累计快照或手动天气复制成历史。 */
export const diaryFacts = pgTable('diary_facts', {
  id: id(), catId: uuid('cat_id').notNull().references(() => cats.id, { onDelete: 'cascade' }),
  localDay: text('local_day').notNull(), timeZone: text('time_zone').notNull(),
  fingerprint: text('fingerprint').notNull(), text: text('text').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, t => [uniqueIndex('diary_facts_day_identity').on(t.catId, t.localDay, t.fingerprint)]);
/** 启用时的日期标签固定；跨时区重扫已关闭日期，日期唯一键负责去重。 */
export const diaryCalendars = pgTable('diary_calendars', {
  catId: uuid('cat_id').primaryKey().references(() => cats.id, { onDelete: 'cascade' }),
  startDay: text('start_day').notNull(),
  nextDay: text('next_day'),
  nextScanAt: timestamp('next_scan_at', { withTimezone: true }).notNull().default(sql`'epoch'::timestamptz`),
}, t => [index('diary_calendar_due').on(t.nextScanAt, t.catId)]);

/** 正式身份只保存不可逆会话摘要；Apple sub不会按邮箱合并。 */
export const authNonces = pgTable('auth_nonces', { hash:text('hash').primaryKey(), expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(), usedAt:timestamp('used_at',{withTimezone:true}) });
export const sessions = pgTable('sessions', { id:id(),userId:uuid('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),tokenHash:text('token_hash').notNull().unique(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),revokedAt:timestamp('revoked_at',{withTimezone:true}),createdAt:createdAt() });
export const devices = pgTable('devices', { id:id(),userId:uuid('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),token:text('token').notNull(),environment:text('environment').notNull(),topic:text('topic').notNull(),invalidAt:timestamp('invalid_at',{withTimezone:true}),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow() },t=>[uniqueIndex('devices_identity').on(t.token,t.environment,t.topic)]);
export type PushProof={messageIds:string[];diaries:{id:string;revision:number}[];usedMemories:boolean;memoryRevision?:number;content:string;callId?:string;runId?:string};
export const pushNotifications = pgTable('push_notifications', {id:id(),catId:uuid('cat_id').notNull().references(()=>cats.id,{onDelete:'cascade'}),outboxId:uuid('outbox_id').notNull().unique().references(()=>outbox.id,{onDelete:'cascade'}),ticketIds:uuid('ticket_ids').array().notNull(),reason:text('reason').notNull(),payload:jsonb('payload').$type<Record<string,unknown>>().notNull(),proof:jsonb('proof').$type<PushProof>().notNull(),status:text('status').notNull().default('pending'),budgetDay:text('budget_day'),createdAt:createdAt() });
export const pushDeliveries = pgTable('push_deliveries',{id:id(),notificationId:uuid('notification_id').notNull().references(()=>pushNotifications.id,{onDelete:'cascade'}),deviceId:uuid('device_id').notNull().references(()=>devices.id,{onDelete:'cascade'}),apnsId:uuid('apns_id').notNull().defaultRandom(),status:text('status').notNull().default('pending'),attempts:integer('attempts').notNull().default(0),reason:text('reason'),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow()},t=>[uniqueIndex('push_delivery_identity').on(t.notificationId,t.deviceId)]);
export const modelReservations=pgTable('model_reservations',{id:id(),userId:uuid('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),day:text('day').notNull(),purpose:text('purpose').notNull(),reservedTokens:integer('reserved_tokens').notNull(),status:text('status').notNull().default('reserved'),createdAt:createdAt()},t=>[index('model_reservations_daily').on(t.userId,t.day)]);
/** 推送按实际发送当地日期预留；同通知多设备只占一次，跨日重试重新占当天一格。 */
export const pushBudgetReservations=pgTable('push_budget_reservations',{id:id(),catId:uuid('cat_id').notNull().references(()=>cats.id,{onDelete:'cascade'}),notificationId:uuid('notification_id').notNull().references(()=>pushNotifications.id,{onDelete:'cascade'}),day:text('day').notNull(),createdAt:createdAt()},t=>[uniqueIndex('push_budget_day_notification').on(t.notificationId,t.day),index('push_budget_cat_day').on(t.catId,t.day)]);

/** 推断只存来源引用/hash和时刻，不建立用户原文副本。 */
export const inferenceWatches=pgTable('inference_watches',{
 id:id(),catId:uuid('cat_id').notNull().references(()=>cats.id,{onDelete:'cascade'}),sourceMessageId:uuid('source_message_id').notNull().references(()=>messages.id,{onDelete:'cascade'}),sourceHash:text('source_hash').notNull(),ruleId:text('rule_id').notNull(),topic:text('topic').notNull(),dueAt:timestamp('due_at',{withTimezone:true}).notNull(),permissionRevision:integer('permission_revision').notNull(),state:text('state').notNull().default('waiting'),createdAt:createdAt(),
},t=>[uniqueIndex('inference_watch_source_rule').on(t.sourceMessageId,t.ruleId),index('inference_watch_due').on(t.state,t.dueAt)]);
export const inferenceObservations=pgTable('inference_observations',{
 id:id(),catId:uuid('cat_id').notNull().references(()=>cats.id,{onDelete:'cascade'}),sourceMessageId:uuid('source_message_id').notNull().references(()=>messages.id,{onDelete:'cascade'}),sourceHash:text('source_hash').notNull(),ruleId:text('rule_id').notNull(),ruleVersion:integer('rule_version').notNull(),topic:text('topic').notNull(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
},t=>[uniqueIndex('inference_observation_source_rule').on(t.sourceMessageId,t.ruleId)]);
export const inferredPublications=pgTable('inferred_publications',{
 id:id(),catId:uuid('cat_id').notNull().references(()=>cats.id,{onDelete:'cascade'}),ticketId:uuid('ticket_id').notNull().references(()=>tickets.id,{onDelete:'cascade'}),sourceMessageId:uuid('source_message_id').notNull().references(()=>messages.id,{onDelete:'cascade'}),localDay:text('local_day').notNull(),createdAt:createdAt(),
},t=>[uniqueIndex('inferred_publication_cat_day').on(t.catId,t.localDay),uniqueIndex('inferred_publication_source').on(t.sourceMessageId)]);

/** 执行者的持久汇报；只有前台 Router 消费并调用发布出口。 */
export type WorkerReportPayload =
  | {kind:'errand'; runId:string; attempt:number; callId:string}
  | {kind:'diary_read'; entryId:string; version:string; revision:number; comment:string|null}
  | {kind:'daily_diary'; input:import('../agent/daily-diary.ts').DailyInput; text:string; triggerId:string};
export const workerReports = pgTable('worker_reports', {
  id: id(),
  catId: uuid('cat_id').notNull().references(() => cats.id, {onDelete:'cascade'}),
  sourceId: uuid('source_id').notNull(),
  version: text('version').notNull(),
  payload: jsonb('payload').$type<WorkerReportPayload>().notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('worker_reports_source_version').on(t.sourceId,t.version)]);
