import type { ModelClient } from "../../src/llm/types.ts";
import type { ExtractionMessage } from "../../src/memory/extraction.ts";
import { extractMemoryForMessage } from "../../src/memory/extraction.ts";
import { extractionInput, members } from "./corpus.ts";
import type { ExtractionProbe, MemberId, MessageEvent, Timeline } from "./corpus.ts";
import { scoreExtraction } from "./score.ts";

const roster = Object.entries(members).map(([id, name]) => ({ id, name }));

function record(event: MessageEvent): ExtractionMessage {
  return {
    id: event.id, conversation_id: event.conversation, text: event.text, status: "complete", permission: "allowed",
    author: event.author === "cat" ? { kind: "cat" } : { kind: "member", member_id: event.author },
  };
}

export async function runExtractionProbe(timeline: Timeline, probe: ExtractionProbe, client: ModelClient) {
  const { message, history } = extractionInput(timeline, probe);
  const owner = message.conversation === "group" ? null : message.conversation === "direct-a" ? "a" : "b";
  const result = await extractMemoryForMessage({
    conversation: {
      id: message.conversation, kind: owner ? "direct" : "group", owner_member_id: owner,
      participant_member_ids: owner ? [owner] : ["a", "b"],
    },
    members: roster, learningEnabled: true, current: record(message), history: history.map(record),
    signal: AbortSignal.timeout(60_000),
  }, client);
  const score = scoreExtraction(timeline, probe, {
    confirmed: result.confirmed.map((entry) => ({
      ...entry, subject: entry.subject.kind === "pair" ? "pair" : entry.subject.memberId as MemberId,
      sourceMemberId: entry.sourceMemberId as MemberId,
    })),
    pending: result.pending.map((entry) => ({ ...entry, messageId: entry.sourceMessageId })),
  });
  return { status: result.status, score };
}
