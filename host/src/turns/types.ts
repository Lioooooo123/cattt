import type { Conversation, Message } from "../conversations/types.ts";

export interface Replier {
  reply(input: { conversation: Conversation; history: Message[]; trigger: Message; signal: AbortSignal }): AsyncIterable<string>;
}
