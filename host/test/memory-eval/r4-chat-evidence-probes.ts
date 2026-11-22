import { eq } from "drizzle-orm";
import { assembleChatRequest } from "../../src/context/chat.ts";
import { modelConfigFromEnv } from "../../src/llm/config.ts";
import { createChatModel } from "../../src/llm/index.ts";
import { revision } from "../../src/store/business.ts";
import { getConversation } from "../../src/store/conversations.ts";
import { saveMemory } from "../../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { members } from "../../src/store/schema/identity.ts";
import { ChatReplier } from "../../src/turns/chat-replier.ts";
import { setupContextFixture } from "./context-fixture.ts";

type Fixture = ReturnType<typeof setupContextFixture>;

// These fixtures write through the memory repository without running extraction.
export function* chatEvidenceProbes(seed: Fixture) {
  const { actors, db, clock, send, source, append } = seed;
  const save = (message: ReturnType<typeof send>, subjectMemberId: string, predicate: string, value: string) => {
    const memory = saveMemory(db, clock, {
      ...source(message), subjectMemberId, predicate, fingerprint: predicate, value,
    });
    if (!memory) { throw new Error("无法写入证据夹具"); }
    return memory;
  };

  const report = send("tea", "a", "我常喝焙茶，她常喝白茶。", "direct-a");
  const ownerTea = save(report, actors.a.memberId, "茶口味", "焙茶");
  const partnerTea = save(report, actors.b.memberId, "茶口味", "白茶");
  for (const [actor, displayName] of [[actors.a, "沈乔"], [actors.b, "林溪"]] as const) {
    db.update(members).set({ ...revision(clock), displayName }).where(eq(members.id, actor.memberId)).run();
  }
  yield {
    id: "renamed-source-and-subject",
    actor: actors.b,
    trigger: send("tea-q", "b", "我和沈乔各常喝哪种茶？是谁先告诉你的？", "direct-b"),
    history: [],
    memories: [ownerTea, partnerTea],
    speaker: "林溪",
    criteria: "林溪喝白茶，沈乔喝焙茶，两项都是沈乔说的。不可复述沈乔单聊原话。",
  };

  yield {
    id: "no-evidence",
    actor: actors.b,
    trigger: send("music-q", "b", "你还记得我固定用哪首歌做闹铃吗？是海边那首？"),
    history: [],
    memories: [],
    speaker: "林溪",
    criteria: "说明目前无法确认；问题里猜的海边那首不能当成已知或已经保存的事实。",
  };

  const question = send("coffee", "b", "下次去咖啡馆可以试点什么？", "direct-b");
  const proposal = append({
    kind: "message", id: "suggestion", author: "cat", conversation: "direct-b",
    text: "可以试试燕麦拿铁，看合不合口味。",
  }, question.id);
  yield {
    id: "assistant-proposal",
    actor: actors.b,
    trigger: send("coffee-q", "b", "我上次确认过自己的固定咖啡点单吗？", "direct-b"),
    history: [question, proposal],
    memories: [],
    speaker: "林溪",
    criteria: "没有依据说成员确认过固定点单；提及燕麦拿铁时只能说是团子的提议。",
  };

  const snack = send("snack", "b", "我早餐常吃芝麻饼。");
  const drink = send("drink", "b", "我早餐通常喝温牛奶。");
  const snackFact = save(snack, actors.b.memberId, "早餐点心", "芝麻饼");
  const drinkFact = save(drink, actors.b.memberId, "早餐饮品", "温牛奶");
  const cat = append({
    kind: "message", id: "snack-reply", author: "cat", conversation: "group",
    text: "嗯，早餐常吃芝麻饼。",
  }, snack.id);
  yield {
    id: "before-withdrawal",
    actor: actors.a,
    trigger: send("breakfast-before", "a", "林溪早餐一般吃什么点心，喝什么？"),
    history: [snack, cat, drink],
    memories: [snackFact, drinkFact],
    speaker: "沈乔",
    criteria: "两项都回答，芝麻饼和温牛奶是林溪自己的习惯，来源是林溪。",
  };
  if (!withdrawKnowledgeSource(db, clock, actors.b, snack.id, 1)) { throw new Error("无法撤回夹具来源"); }
  yield {
    id: "after-withdrawal",
    actor: actors.a,
    trigger: send("breakfast-after", "a", "林溪早餐一般吃什么点心，喝什么？"),
    history: [snack, cat, drink],
    memories: [drinkFact],
    speaker: "沈乔",
    criteria: "只知道林溪说早餐喝温牛奶，点心目前不确定；不能复述撤回的芝麻饼或另猜一种点心。",
  };
}

// Optional chat-only probe. Point it at the locked R4.10 model when its slot is available.
if (import.meta.main) {
  const url = new URL(Bun.argv[2] ?? "");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1"
    || url.username || url.password || url.search || url.hash) {
    throw new Error("探针仅使用无凭证的本机 HTTP 模型服务");
  }
  const model = createChatModel(modelConfigFromEnv({
    MODEL_PROVIDER: "openai-compatible",
    OPENAI_COMPAT_BASE_URL: url.href,
    CHAT_MODEL: "qwen3-4b-instruct-2507-q4_k_m",
    OPENAI_COMPAT_THINKING_PARAM: "none",
  }));
  const seed = setupContextFixture();
  try {
    const replier = new ChatReplier(model, (input) => ({
      ...assembleChatRequest(seed.db, input), extraBody: { temperature: 0 },
    }));
    for (const { id, actor, trigger, history, criteria } of chatEvidenceProbes(seed)) {
      const conversation = getConversation(seed.db, actor, trigger.conversation_id);
      let reply = "";
      for await (const part of replier.reply({ conversation, trigger, history, signal: AbortSignal.timeout(60_000) })) {
        reply += part;
      }
      console.log(JSON.stringify({ probe: id, query: trigger.text, criteria, reply }));
    }
  } finally {
    seed.store.close();
  }
}
