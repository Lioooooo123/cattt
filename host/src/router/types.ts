import type { StoreDb } from "../store/index.ts";

export interface GroupPublicationAuthority {
  /** R6 在当前事务内核对持久租约。任期内返回稳定凭证，换任期必须换值。 */
  currentEpoch(db: Pick<StoreDb, "select">, scope: {
    hostId: string;
    householdId: string;
    conversationId: string;
    now: number;
  }): string | undefined;
}

export type PublicationPushIntent = {
  id: string;
  hostId: string;
  memberId: string;
  householdId: string;
  conversationId: string;
  ticketId: string;
  reason: "followup_due" | "errand_ready" | "errand_waiting";
  destination: { route: "chat"; messageId: string } | { route: "mailbox"; letterId: string };
};

/** 适配端在本机为该成员解析仍有效的 APNs 设备。ID 供设备收据/回执去重；报告正文不离开 Router。 */
export type PublicationPushAdapter = (
  intent: PublicationPushIntent, signal: AbortSignal,
) => Promise<"sent" | "dropped" | "uncertain" | { retryAt: number }>;
