import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { ticketInputs, tickets } from '../db/schema.ts';
import { userTimeZone } from '../runtime/time.ts';
import { TicketError } from './errors.ts';
import { commandOrigin, receiveCommand } from './intake.ts';
export { TicketError } from './errors.ts';
export const ticketView = (t: typeof tickets.$inferSelect) => ({
  id: t.id,
  source_message_id:t.sourceMessageId,
  kind: t.kind,
  mandate_kind: t.mandate.kind,
  goal: t.goal,
  status: t.status,
  stage: t.stage,
  due_at: t.dueAt,
  time_zone: t.timeZone,
  ended_reason: t.endedReason,
});
export function localISO(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
/** 只接具体本地ISO时间或带偏移的ISO。自然语言由聊天结合 get_time 澄清后再调用。 */
export function parseFollowupTime(when: string, timeZone: string): Date {
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)?$/.exec(when);
  if (!parts || (parts[7] && !parts[8])) throw new TicketError(400, '请先说清具体日期和时间');
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59)
    throw new TicketError(400, '请填写有效的日期和时间');
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(when)) {
    const value = new Date(when);
    if (Number.isFinite(+value)) return value;
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(when)) throw new TicketError(400, '请先说清具体日期和时间');
  const normalized = when.length === 16 ? when + ':00' : when;
  const wall = Date.parse(normalized + 'Z');
  let instant = wall;
  for (let i = 0; i < 4; i++) instant += wall - Date.parse(localISO(new Date(instant), timeZone) + 'Z');
  if (!Number.isFinite(instant) || localISO(new Date(instant), timeZone) !== normalized)
    throw new TicketError(400, '这个本地时间不存在，请换个时间');
  // 夏令时回拨的重复时刻必须由用户给出偏移，不能替用户猜。
  for (const delta of [-3600000, 3600000])
    if (localISO(new Date(instant + delta), timeZone) === normalized)
      throw new TicketError(400, '这个时间有两个时区偏移，请说清具体偏移');
  return new Date(instant);
}
export async function listTickets(catId: string, status = 'open') {
  return db
    .select()
    .from(tickets)
    .where(and(eq(tickets.catId, catId), sql`${tickets.kind} in ('followup','errand')`, status === 'all' ? undefined
      : status === 'actionable' ? sql`(${tickets.status}='open' or (${tickets.kind}='errand' and ${tickets.status}='ended' and ${tickets.stage} in ('failed','blocked')))`
      : eq(tickets.status, status)))
    .orderBy(asc(tickets.dueAt), asc(tickets.createdAt));
}
export async function scheduleFollowup(catId: string, sourceId: string, when: string, about: string, now = new Date()) {
  const zone = await userTimeZone(catId);
  const due = parseFollowupTime(when, zone);
  about = about.trim();
  if (!about || about.length > 60) throw new TicketError(400, '请约一个之后的具体时间，主题不超过60字');
  return receiveCommand(catId, { source: 'chat', messageId: sourceId }, {
    kind: 'schedule', input: { when: due.toISOString(), about },
    legacyKey: `chat:${sourceId}:${due.toISOString()}:${about}`,
    payload: { when: due.toISOString(), about },
  }, async tx => {
    // 时间检查放在首次执行；重放只读取原收据，不因时间流逝重新建单。
    if (+due <= +now) throw new TicketError(400, '请约一个之后的具体时间，主题不超过60字');
    const [ticket] = await tx.insert(tickets).values({
      catId, kind: 'followup', goal: about,
      mandate: { kind: 'explicit', source_message_id: sourceId },
      dueAt: due, timeZone: zone, sourceMessageId: sourceId,
    }).returning();
    return { receipt: { ticket_id: ticket!.id, when: localISO(due, zone), time_zone: zone },
      ticketId: ticket!.id, outcome: 'accept', reasons: ['用户亲口约定'] };
  }, prior => ({ ticket_id: prior.id, when: localISO(prior.dueAt!, zone), time_zone: zone }));
}

export async function updateTicket(catId: string, ticketId: string, when: string, sourceId?: string, now = new Date(), requestId?: string) {
  return receiveCommand(catId, commandOrigin(sourceId, requestId), {
    // 重放按原始请求识别；首次执行才用当时的时区解释时间。
    kind: 'reschedule', input: { ticket_id: ticketId, when },
    payload: { when },
  }, async (tx, source) => {
    const zone = await userTimeZone(catId, tx);
    const due = parseFollowupTime(when, zone);
    const [ticket] = await tx.select().from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.catId, catId), eq(tickets.kind, 'followup'), eq(tickets.status, 'open')))
      .for('update');
    if (!ticket) throw new TicketError(404, '没有这件约定');
    if (+due <= +now) throw new TicketError(400, '请选之后的时间');
    if (source) await tx.insert(ticketInputs).values({ ticketId, messageId: source.id, text: source.text, readAt: sql`now()` });
    await tx.update(tickets).set({ dueAt: due, timeZone: zone, updatedAt: sql`now()` }).where(eq(tickets.id, ticketId));
    return { receipt: { ticket_id: ticketId, when: localISO(due, zone), time_zone: zone },
      ticketId, outcome: 'attach', reasons: ['用户改期'] };
  });
}

export async function cancelTicket(catId: string, ticketId: string, sourceId?: string, requestId?: string) {
  return receiveCommand(catId, commandOrigin(sourceId, requestId), {
    kind: 'cancel', input: { ticket_id: ticketId },
  }, async tx => {
    const [ticket] = await tx.update(tickets)
      .set({ status: 'ended', stage: 'cancelled', endedReason: 'cancelled', updatedAt: sql`now()` })
      .where(and(eq(tickets.id, ticketId), eq(tickets.catId, catId), sql`${tickets.kind} in ('followup','errand')`, sql`(${tickets.status}='open' or (${tickets.kind}='errand' and ${tickets.status}='ended' and ${tickets.stage} in ('failed','blocked')) or exists(select 1 from outbox o where o.ticket_id=${tickets.id} and o.kind='push' and o.status='pending'))`))
      .returning();
    if (!ticket) throw new TicketError(404, '没有这件约定');
    // attach表示对既有事项的决定；取消以command.kind及事项终态明确记录。
    return { receipt: { ticket_id: ticket.id, cancelled: true }, ticketId: ticket.id,
      outcome: 'attach', reasons: ['用户取消'] };
  });
}

export function availableAt(due: Date, zone: string) {
  const local = localISO(due, zone),
    hour = Number(local.slice(11, 13));
  if (hour >= 9 && hour < 22) return due;
  const day = new Date(local.slice(0, 10) + 'T12:00:00Z');
  if (hour >= 22) day.setUTCDate(day.getUTCDate() + 1);
  return parseFollowupTime(day.toISOString().slice(0, 10) + 'T09:00:00', zone);
}
