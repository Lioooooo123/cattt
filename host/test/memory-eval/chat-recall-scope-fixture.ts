import { getConversation } from "../../src/store/conversations.ts";
import { saveMemory } from "../../src/store/knowledge.ts";
import { setupContextFixture } from "./context-fixture.ts";

export const chatRecallScopeProbes = {
  "cat-opinion": "团子，你也喜欢这只风铃吗？",
  "cat-opinion-alternative": "你自己喜不喜欢这只风铃？",
  "companionship": "外面起风了，跟我随意聊聊风铃吧。",
  "explicit-recall": "我上次定下来的风铃材质是什么？",
  "comparison": "上次我们各自选的风铃材质是什么？",
  "personalized-advice": "陪我聊聊风铃，按我喜欢的声音推荐一款吧。",
  "unmarked-chat": "窗边好像可以挂一只风铃。",
  "mixed-request": "团子，你喜欢这只风铃吗？我上次定的是哪种风铃材质？",
} as const;

export function chatRecallScopeFixture() {
  const seed = setupContextFixture();
  const { actors, clock, db, source, send } = seed;
  const first = send("own-bell", "a", "我的风铃选黄铜。", "direct-a");
  const second = send("reported-bell", "a", "小禾的风铃材质定的是青瓷，我帮忙选的。", "direct-a");
  const third = send("own-sound", "b", "我喜欢风铃声音低沉一些。", "direct-b");
  for (const [message, subjectMemberId, predicate, value] of [
    [first, actors.a.memberId, "风铃材质", "黄铜"],
    [second, actors.b.memberId, "风铃材质", "青瓷"],
    [third, actors.b.memberId, "风铃声音偏好", "低沉"],
  ] as const) {
    if (!saveMemory(db, clock, { ...source(message), subjectMemberId, predicate, fingerprint: predicate, value })) {
      throw new Error("未能写入风铃记忆夹具");
    }
  }
  const nearby = send("nearby", "a", "眼前这只风铃挂在窗边。");
  const input = (id: keyof typeof chatRecallScopeProbes) => {
    const trigger = send("request-" + id, "b", chatRecallScopeProbes[id]);
    return { conversation: getConversation(db, actors.b, trigger.conversation_id), trigger, history: [nearby] };
  };
  return { ...seed, second, nearby, input };
}
