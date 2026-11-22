import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { canSeeConversation } from "../identity/access.ts";
import type { Actor } from "../identity/index.ts";
import type { PushRequest } from "../push/apns.ts";
import type { PublicationPushAdapter, PublicationPushIntent } from "../router/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { availableAt, localISO } from "../tickets/time.ts";
import { readConversationScope } from "./conversations.ts";
import { enrolledPushDevices, invalidatePushBinding, isHomeDevice } from "./device-push.ts";
import { getMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { dayMs, getWorkerReport, reviewPublication } from "./report-publications.ts";
import { messages } from "./schema/conversations.ts";
import { mailboxLetters, mailboxReads, publicationReceipts, pushOutbox } from "./schema/publications.ts";
import { pushDeliveries } from "./schema/push.ts";

type Reader = Pick<StoreDb, "select">;
type PushRow = typeof pushOutbox.$inferSelect;
type Delivery = typeof pushDeliveries.$inferSelect;

function readTarget(ctx: HostContext, db: Reader, row: PushRow) {
  const report = getWorkerReport(db, row.reportId);
  const receipt = db.select().from(publicationReceipts).where(eq(publicationReceipts.reportId, row.reportId)).get();
  const member = getMember(db, row.memberId);
  if (!report || !receipt?.messageId || receipt.status !== "published" || receipt.hostId !== ctx.hostId
    || receipt.ticketId !== report.ticketId || row.hostId !== ctx.hostId || member?.homeHostId !== ctx.hostId
    || member.id !== report.forMemberId || member.householdId !== ctx.householdId || report.householdId !== ctx.householdId
    || report.publisherHostId !== ctx.hostId) return;
  const result = report.result.status;
  if (result !== "due" && result !== "ready" && result !== "waiting") return;

  const scope = readConversationScope(db, report.conversationId);
  const recipient = { memberId: member.id, householdId: member.householdId, hostId: ctx.hostId };
  if (!scope || !canSeeConversation({ ...recipient, deviceId: "" }, scope)) return;
  const message = db.select().from(messages).where(and(
    eq(messages.id, receipt.messageId), eq(messages.conversationId, report.conversationId),
    isNull(messages.authorMemberId), isNull(messages.deletedAt),
  )).get();
  const letter = result === "ready" && receipt.letterId ? db.select().from(mailboxLetters).where(and(
    eq(mailboxLetters.id, receipt.letterId), eq(mailboxLetters.forMemberId, row.memberId),
    eq(mailboxLetters.householdId, report.householdId), eq(mailboxLetters.conversationId, report.conversationId),
    eq(mailboxLetters.ticketId, report.ticketId), isNull(mailboxLetters.deletedAt),
  )).get() : undefined;
  if (!message || (result === "ready" && !letter)) return;
  const intent: PublicationPushIntent = {
    id: row.id, ...recipient, conversationId: report.conversationId, ticketId: report.ticketId,
    reason: result === "due" ? "followup_due" : result === "ready" ? "errand_ready" : "errand_waiting",
    destination: letter ? { route: "mailbox", letterId: letter.id } : { route: "chat", messageId: message.id },
  };
  return { intent, report, message, letter };
}

function reviewPush(ctx: HostContext, db: Reader, row: PushRow, now: number) {
  const target = readTarget(ctx, db, row);
  if (!target) return;
  const { report, message, letter } = target;
  const expiration = Math.min(row.createdAt + dayMs, report.quietAfter ?? Infinity,
    report.dueAt === null ? Infinity : report.dueAt + dayMs + 1);
  if (now >= expiration || (letter && (letter.readAt !== null
    || db.select().from(mailboxReads).where(eq(mailboxReads.letterId, letter.id)).get()))) return;

  const review = reviewPublication(ctx, db, report, letter ? [message.text, letter.text] : [message.text]);
  if ("reason" in review) return;
  return {
    intent: target.intent,
    day: localISO(now, review.timeZone).slice(0, 10),
    allowedAt: Math.min(availableAt(now, review.timeZone), expiration),
  };
}

export function resolvePublicationPush(ctx: HostContext, actor: Actor, id: string) {
  const db = ctx.store.db;
  if (!isHomeDevice(ctx, db, actor)) return;
  const row = db.select().from(pushOutbox).where(and(
    eq(pushOutbox.id, id), eq(pushOutbox.memberId, actor.memberId), eq(pushOutbox.hostId, actor.hostId),
  )).get();
  if (!row) return;
  return readTarget(ctx, db, row)?.intent;
}

export function recoverInterruptedPush(ctx: HostContext): void {
  ctx.store.db.transaction((tx) => {
    const sending = and(eq(pushOutbox.hostId, ctx.hostId), eq(pushOutbox.status, "sending"));
    tx.update(pushDeliveries).set({ status: "uncertain" }).where(and(
      eq(pushDeliveries.status, "sending"),
      inArray(pushDeliveries.notificationId, tx.select({ id: pushOutbox.id }).from(pushOutbox).where(sending)),
    )).run();
    tx.update(pushOutbox).set({ status: "uncertain", updatedAt: ctx.clock.wallMs() }).where(sending).run();
  }, { behavior: "immediate" });
}

export function claimNextPublicationPush(ctx: HostContext): PublicationPushIntent | undefined {
  return ctx.store.db.transaction((tx) => {
    const now = ctx.clock.wallMs();
    const ready = tx.select().from(pushOutbox).where(and(
      eq(pushOutbox.hostId, ctx.hostId), eq(pushOutbox.status, "pending"), lte(pushOutbox.retryAt, now),
    )).orderBy(asc(pushOutbox.retryAt), asc(pushOutbox.id)).limit(100).all();
    for (const row of ready) {
      const update = (values: Partial<PushRow>) => tx.update(pushOutbox)
        .set({ ...values, updatedAt: now }).where(eq(pushOutbox.id, row.id)).run();
      const finishPending = () => {
        const related = eq(pushDeliveries.notificationId, row.id);
        tx.update(pushDeliveries).set({ status: "dropped" }).where(and(
          related, eq(pushDeliveries.status, "pending"),
        )).run();
        const previous = tx.select({ status: pushDeliveries.status }).from(pushDeliveries).where(related).all();
        const status = previous.some((device) => device.status === "uncertain") ? "uncertain"
          : previous.some((device) => device.status === "sent") ? "sent" : "dropped";
        update({ status });
      };
      const review = reviewPush(ctx, tx, row, now);
      if (!review) {
        finishPending();
        continue;
      }
      if (review.allowedAt > now) {
        update({ retryAt: review.allowedAt });
        continue;
      }
      // 同一日的供应商重试复用名额。过日界停止旧通知。
      const reserved = tx.select({ id: pushOutbox.id }).from(pushOutbox)
        .where(and(eq(pushOutbox.memberId, row.memberId), eq(pushOutbox.budgetDay, review.day))).limit(2).all();
      if (row.budgetDay === null ? reserved.length >= 2 : row.budgetDay !== review.day) {
        finishPending();
        continue;
      }
      update({ status: "sending", budgetDay: review.day });
      return review.intent;
    }
  }, { behavior: "immediate" });
}

const deliveryKey = (delivery: Pick<Delivery, "notificationId" | "deviceId">) => and(
  eq(pushDeliveries.notificationId, delivery.notificationId), eq(pushDeliveries.deviceId, delivery.deviceId),
);

export function publicationPushDevices(ctx: HostContext, notificationId: string, topic: string): Delivery[] {
  return ctx.store.db.transaction((tx) => {
    const row = tx.select().from(pushOutbox).where(and(
      eq(pushOutbox.id, notificationId), eq(pushOutbox.hostId, ctx.hostId), eq(pushOutbox.status, "sending"),
    )).get();
    if (!row) return [];
    const query = tx.select().from(pushDeliveries).where(eq(pushDeliveries.notificationId, notificationId))
      .orderBy(asc(pushDeliveries.deviceId));
    const existing = query.all();
    if (existing.length) return existing;
    const devices = enrolledPushDevices(ctx, tx, row.memberId, topic);
    if (!devices.length) return [];
    tx.insert(pushDeliveries).values(devices.map(({ deviceId, bindingId }) => ({
      deviceId, bindingId, notificationId, apnsId: crypto.randomUUID(), status: "pending" as const,
    }))).run();
    return query.all();
  }, { behavior: "immediate" });
}

export function preparePushDevice(ctx: HostContext, delivery: Delivery, topic: string): PushRequest | number | undefined {
  return ctx.store.db.transaction((tx) => {
    const row = tx.select().from(pushOutbox).where(and(
      eq(pushOutbox.id, delivery.notificationId), eq(pushOutbox.hostId, ctx.hostId), eq(pushOutbox.status, "sending"),
    )).get();
    const current = tx.select().from(pushDeliveries).where(deliveryKey(delivery)).get();
    if (!row || current?.status !== "pending") return;

    const now = ctx.clock.wallMs();
    const review = reviewPush(ctx, tx, row, now);
    const device = enrolledPushDevices(ctx, tx, row.memberId, topic).find(({ deviceId, bindingId }) =>
      deviceId === current.deviceId && bindingId === current.bindingId);
    if (!device || !review || review.day !== row.budgetDay) {
      tx.update(pushDeliveries).set({ status: "dropped" }).where(deliveryKey(current)).run();
      return;
    }
    if (review.allowedAt > now) return review.allowedAt;

    const { intent } = review;
    tx.update(pushDeliveries).set({ status: "sending" }).where(deliveryKey(current)).run();
    return {
      token: device.token, environment: device.environment, topic: device.topic, apnsId: current.apnsId,
      payload: {
        aps: { alert: { title: "团子", body: intent.reason === "errand_ready"
          ? "信箱里留了一封信，想看时再拆。" : "我留了一句话，想聊时再来。" } },
        notification_id: intent.id, member_id: intent.memberId, household_id: intent.householdId,
        host_id: intent.hostId, device_id: current.deviceId,
      },
    };
  }, { behavior: "immediate" });
}

export function settlePushDevice(ctx: HostContext, delivery: Delivery, status: Delivery["status"], invalidAt?: number): void {
  ctx.store.db.transaction((tx) => {
    tx.update(pushDeliveries).set({ status }).where(and(
      deliveryKey(delivery), eq(pushDeliveries.status, "sending"),
    )).run();
    if (invalidAt !== undefined) invalidatePushBinding(tx, delivery.deviceId, delivery.bindingId, invalidAt);
  }, { behavior: "immediate" });
}

export function settlePublicationPush(
  ctx: HostContext, id: string, result: Awaited<ReturnType<PublicationPushAdapter>>,
): void {
  const now = ctx.clock.wallMs();
  const values: Partial<PushRow> = typeof result === "string" ? { status: result }
    : Number.isSafeInteger(result.retryAt) ? { status: "pending", retryAt: Math.max(now + 1000, result.retryAt) }
    : { status: "uncertain" };
  ctx.store.db.update(pushOutbox).set({ ...values, updatedAt: now }).where(and(
    eq(pushOutbox.id, id), eq(pushOutbox.hostId, ctx.hostId), eq(pushOutbox.status, "sending"),
  )).run();
}
