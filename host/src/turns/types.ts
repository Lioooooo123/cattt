import type { Conversation, Message } from "../conversations/types.ts";
import type { StoreDb } from "../store/index.ts";
import type { RecallEvidence } from "../store/knowledge-use.ts";
import type { TicketChatSource } from "../tickets/types.ts";
import type { YardChatTurn } from "./yard-chat.ts";

export interface ReplyPublicationGuard {
  check(db: Pick<StoreDb, "select" | "transaction">): void;
  knowledgeEvidence: RecallEvidence[];
}

export interface Replier {
  reply(input: {
    conversation: Conversation;
    history: Message[];
    trigger: Message;
    signal: AbortSignal;
    turnId?: string;
    assertPublication?: () => void;
    beforePublish?: (guard: ReplyPublicationGuard) => void;
    yardTurn?: YardChatTurn;
    ticketSource?: TicketChatSource;
    assertCurrentTurn?: (db: Pick<StoreDb, "select" | "transaction">) => void;
  }): AsyncIterable<string>;
}
