import assert from "node:assert/strict";
import type { Conversation, Message } from "../../src/conversations/types.ts";
import { buildChatPrompt } from "../../src/turns/chat-replier.ts";
import { contextInput, members, timelines } from "./corpus.ts";
import { scoreContext, summarize } from "./score.ts";

// 冻结在 R3 的组装入口。R4 新增记忆装配后，比较时用 750223c 的实现运行此脚本。
const context = timelines.flatMap((timeline) => timeline.context.map((probe) => {
  const { query } = contextInput(timeline, probe);
  assert.ok(query.author !== "cat", "召回探针必须来自成员");
  const isGroup = query.conversation === "group";
  const conversation: Conversation = {
    id: query.conversation,
    kind: isGroup ? "group" : "direct",
    owner_member_id: isGroup ? null : query.author,
    participant_member_ids: isGroup ? Object.keys(members) : [query.author],
    publisher_host_id: "baseline",
    created_at: 0,
    last_message: null,
  };
  const trigger: Message = {
    id: query.id,
    conversation_id: conversation.id,
    cursor: "baseline",
    author: { kind: "member", member_id: query.author },
    text: query.text,
    modality: "text",
    status: "complete",
    client_message_id: null,
    reply_to_message_id: null,
    turn_id: null,
    created_at: 0,
  };
  const request = buildChatPrompt({ conversation, history: [], trigger, signal: new AbortController().signal },
    (id) => members[id as keyof typeof members]);
  assert.deepEqual(request.messages, [{ role: "user", content: `${JSON.stringify(members[query.author])}：${query.text}` }]);
  assert.ok(typeof request.system === "string");
  assert.match(request.system, /只使用本对话提供的消息/);
  assert.doesNotMatch(request.system, /关于(?:阿岚|小禾|你们俩)/);
  return scoreContext(timeline, probe, { entries: [], memoryText: "" });
}));

const extraction = timelines.flatMap(({ extraction }) => extraction);
const summary = summarize(context);
console.log(JSON.stringify({
  extraction: {
    status: "unsupported",
    probes: extraction.length,
    expectedFacts: extraction.reduce((sum, probe) => sum + probe.mustConfirm.length, 0),
    expectedPending: extraction.reduce((sum, probe) => sum + probe.mustPend.length, 0),
  },
  context: summary,
  probes: context.map(({ probe, matchedFacts, expectedFacts, violations, passed }) => ({
    probe, matchedFacts, expectedFacts, violations, passed,
  })),
  live: { status: "not_run" },
}, null, 2));
process.exitCode = summary.passed ? 0 : 1;
