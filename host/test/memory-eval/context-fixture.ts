import { ManualClock } from "../../src/clock/index.ts";
import { assembleChatRequest } from "../../src/context/chat.ts";
import type { Message } from "../../src/conversations/types.ts";
import type { Actor } from "../../src/identity/index.ts";
import { uuidv7 } from "../../src/ids/index.ts";
import { createMockModel } from "../../src/llm/mock.ts";
import { businessRow } from "../../src/store/business.ts";
import { getConversation, listConversations, messageDto, sendMessage } from "../../src/store/conversations.ts";
import { setHostMeta } from "../../src/store/host-meta.ts";
import { createMember, ensureHousehold } from "../../src/store/identity.ts";
import { openStore } from "../../src/store/index.ts";
import { messages } from "../../src/store/schema/conversations.ts";
import { ChatReplier } from "../../src/turns/chat-replier.ts";
import { members } from "./corpus.ts";
import type { ContextObservation } from "./score.ts";
import type { ConversationId, Fact, MemberId, MessageEvent } from "./corpus.ts";

export function setupContextFixture() {
  const store = openStore(":memory:");
  const { db } = store;
  const clock = new ManualClock("r4-context", Date.UTC(2026, 0, 1));
  const hostId = uuidv7(clock);
  setHostMeta(db, "host_id", hostId);
  const householdId = ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
  const actor = (name: string): Actor => ({
    memberId: createMember(db, clock, { householdId, homeHostId: hostId, displayName: name }),
    householdId, hostId, deviceId: "fixture",
  });
  const actors = { a: actor(members.a), b: actor(members.b) };
  const ids = {
    group: listConversations(db, actors.a).find(({ kind }) => kind === "group")!.id,
    "direct-a": listConversations(db, actors.a).find(({ kind }) => kind === "direct")!.id,
    "direct-b": listConversations(db, actors.b).find(({ kind }) => kind === "direct")!.id,
  };
  function append(event: MessageEvent, replyToMessageId: string | null = null) {
    clock.advance(86_400_000);
    const conversationId = ids[event.conversation];
    const message = event.author === "cat"
      ? messageDto(db.insert(messages).values({
        ...businessRow(clock, hostId), conversationId, authorMemberId: null, text: event.text,
        modality: "text", status: "complete", replyToMessageId,
      }).returning().get()!)
      : sendMessage(db, clock, actors[event.author], conversationId, {
        clientMessageId: event.id, text: event.text,
      }).body.message;
    return message;
  }
  const source = (message: Message) => {
    if (message.author.kind !== "member") { throw new Error("夹具来源须由成员提供"); }
    return { householdId, sourceMemberId: message.author.member_id, sourceMessageId: message.id, sourceRevision: 1 };
  };
  const send = (id: string, author: MemberId, text: string, conversation: ConversationId = "group") =>
    append({ kind: "message", id, author, text, conversation });
  const model = createMockModel(0, true);
  const replier = new ChatReplier(model, (input) => assembleChatRequest(db, input));
  async function request(trigger: Message, history: Message[] = []) {
    if (trigger.author.kind !== "member") { throw new Error("夹具问题须由成员发送"); }
    const triggerMemberId = trigger.author.member_id;
    const actor = Object.values(actors).find(({ memberId }) => memberId === triggerMemberId)!;
    const conversation = getConversation(db, actor, trigger.conversation_id);
    for await (const _ of replier.reply({ conversation, history, trigger, signal: new AbortController().signal })) {
      // Consume the same stream interface as the turn runner.
    }
    return model.requests.at(-1)!;
  }
  return { store, db, clock, hostId, householdId, actors, ids, append, send, source, request, model };
}

export function observeContext(system: string, actorIds: Map<string, MemberId>, messageIds: Map<string, string>): ContextObservation {
  const start = system.indexOf("\n\n## 相关记忆\n");
  if (start === -1) { return { entries: [], memoryText: "" }; }
  const memoryText = system.slice(start);
  const entries: ContextObservation["entries"][number][] = [];
  let section: Fact["subject"] | undefined;
  for (const line of memoryText.trim().split("\n").slice(1)) {
    if (line === "### 关于你们俩") {
      section = "pair";
    } else if (line.startsWith("### 关于成员 ")) {
      const label = JSON.parse(line.slice("### 关于成员 ".length));
      const member = Object.entries(members).find(([, name]) => name === label)?.[0] as MemberId | undefined;
      if (!member) { throw new Error(`未知分节 ${line}`); }
      section = member;
    } else if (line) {
      if (!section || !line.startsWith("- ")) { throw new Error(`无法识别实际提示词 ${line}`); }
      const entry = JSON.parse(line.slice(2));
      const { subjectMemberId, predicate, value, sourceMemberId, sourceMember, sourceMessageId } = entry;
      const subject = subjectMemberId === null ? "pair" : actorIds.get(subjectMemberId);
      const author = actorIds.get(sourceMemberId);
      const source = messageIds.get(sourceMessageId);
      if (!subject || !author || sourceMember !== members[author] || !source
        || typeof predicate !== "string" || typeof value !== "string") {
        throw new Error(`实际提示词中的事实无法归属 ${line}`);
      }
      entries.push({ section, fact: { subject, key: predicate, value, sourceMemberId: author, sourceMessageId: source } });
    }
  }
  return { entries, memoryText };
}
