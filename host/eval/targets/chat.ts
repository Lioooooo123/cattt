import { ManualClock } from "../../src/clock/index.ts";
import { assembleChatRequest } from "../../src/context/chat.ts";
import type { Message } from "../../src/conversations/types.ts";
import type { Actor } from "../../src/identity/index.ts";
import { uuidv7 } from "../../src/ids/index.ts";
import { modelConfigFromEnv } from "../../src/llm/config.ts";
import { createChatModel } from "../../src/llm/index.ts";
import type { ModelClient } from "../../src/llm/types.ts";
import { businessRow } from "../../src/store/business.ts";
import { getConversation, listConversations, messageDto, sendMessage } from "../../src/store/conversations.ts";
import { setHostMeta } from "../../src/store/host-meta.ts";
import { createMember, ensureHousehold } from "../../src/store/identity.ts";
import { openStore } from "../../src/store/index.ts";
import { createBoundary, replaceMemory, saveMemory } from "../../src/store/knowledge.ts";
import type { Memory } from "../../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { messages } from "../../src/store/schema/conversations.ts";
import { ChatReplier } from "../../src/turns/chat-replier.ts";
import type { EvalCase, EvalMode } from "../schema.ts";
import { traceModel } from "../trace.ts";
import type { ModelCallTrace } from "../trace.ts";

export async function runChat(item: EvalCase, mode: EvalMode, trace: ModelCallTrace[], onText: (text: string) => void) {
  const client: ModelClient = mode === "env" ? createChatModel(modelConfigFromEnv(process.env)) : {
    provider: "mock", modelId: "eval-scripted",
    async *stream(request, signal) {
      signal?.throwIfAborted(); request.guard?.();
      if (item.scripted === undefined) throw new Error("离线评测缺少 scripted 回复");
      yield { type: "text-delta", delta: item.scripted };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const store = openStore(":memory:");
  try {
    const { db } = store;
    const clock = new ManualClock("eval", Date.UTC(2026, 0, 1));
    const hostId = uuidv7(clock);
    setHostMeta(db, "host_id", hostId);
    const householdId = ensureHousehold(db, clock, hostId, { householdName: "我们的家", hostName: "评测宿主" });
    const actors = new Map<string, Actor>(item.setup.members.map(({ id, name }) => [id, {
      memberId: createMember(db, clock, { householdId, homeHostId: hostId, displayName: name }),
      householdId, hostId, deviceId: "eval",
    }]));
    const actor = (id: string) => {
      const value = actors.get(id);
      if (!value) throw new Error(`未知成员：${id}`);
      return value;
    };
    const scopeId = (scope: EvalCase["setup"]["conversation"]) => {
      const owner = actor(scope.member ?? item.input.sender);
      return listConversations(db, owner).find((row) => row.kind === scope.kind)!.id;
    };
    const send = (sender: string, text: string, conversationId: string) => {
      clock.advance(1000);
      return sendMessage(db, clock, actor(sender), conversationId, { clientMessageId: uuidv7(clock), text }).body.message;
    };
    const source = (message: Message) => {
      if (message.author.kind !== "member") throw new Error("记忆来源须为成员");
      return { householdId, sourceMemberId: message.author.member_id, sourceMessageId: message.id, sourceRevision: 1 };
    };
    const saved = new Map<string, Memory>();
    for (const memory of item.setup.memories) {
      const original = send(memory.source, memory.source_text, scopeId({ kind: "direct", member: memory.source }));
      const input = { ...source(original), subjectMemberId: memory.subject === null ? null : actor(memory.subject).memberId,
        fingerprint: memory.predicate, predicate: memory.predicate, value: memory.value };
      const previous = memory.replaces ? saved.get(memory.replaces) : undefined;
      const row = previous ? replaceMemory(db, clock, actor(memory.source), previous.id, previous.rev, input) : saveMemory(db, clock, input);
      if (!row) throw new Error(`无法保存记忆：${memory.id}`);
      saved.set(memory.id, row);
      if (memory.withdrawn && !withdrawKnowledgeSource(db, clock, actor(memory.source), original.id, 1)) throw new Error("无法撤回记忆来源");
    }
    for (const boundary of item.setup.boundaries) {
      const original = send(boundary.member, boundary.description, scopeId({ kind: "direct", member: boundary.member }));
      if (!createBoundary(db, clock, { ...source(original), subjectMemberId: actor(boundary.member).memberId, description: boundary.description })) throw new Error("无法保存边界");
    }
    const conversationId = scopeId(item.setup.conversation);
    const history: Message[] = [];
    for (const prior of item.setup.prior_messages) {
      const id = scopeId(prior.conversation ?? item.setup.conversation);
      clock.advance(1000);
      const message = prior.sender === "cat" ? messageDto(db.insert(messages).values({
        ...businessRow(clock, hostId), conversationId: id, authorMemberId: null,
        text: prior.text, modality: "text", status: "complete",
      }).returning().get()!) : send(prior.sender, prior.text, id);
      if (id === conversationId) history.push(message);
    }
    const trigger = send(item.input.sender, item.input.text, conversationId);
    const replier = new ChatReplier(traceModel(client, trace), (input) => assembleChatRequest(db, input, () => clock.wallMs()));
    for await (const chunk of replier.reply({ conversation: getConversation(db, actor(item.input.sender), conversationId),
      trigger, history, signal: AbortSignal.timeout(60_000) })) onText(chunk);
    return { provider: client.provider, model: client.modelId };
  } finally { store.close(); }
}
