import { rethrowForQueue } from './model-error.ts';
import { generateText } from '../llm/index.ts';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { boundaries, messages } from '../db/schema.ts';
import { extractSlot, recordModelCall } from '../runtime/model.ts';

/** 把用户标了「不要再提」的那条消息，概括成一句「不要主动提起的话题」 */
export async function summarizeBoundary(boundaryId: string, jobId: string) {
  const [row] = await db
    .select({ id: boundaries.id, description: boundaries.description, text: messages.text })
    .from(boundaries)
    .innerJoin(messages, eq(messages.id, boundaries.sourceMessageId))
    .where(and(eq(boundaries.id, boundaryId), eq(messages.contextAllowed, true)));
  if (!row || row.description) return;

  const slot = extractSlot();
  const started = Date.now();
  const { text, usage } = await generateText(slot.client, {
    system:
      '用户不想再聊下面这条消息涉及的话题。用一个短语概括这个话题，不超过 12 个字，只输出短语本身，不加标点和解释。',
    messages: [{ role: 'user', content: row.text }],
    extraBody: slot.extraBody,
  }, { maxRetries: 2 }).catch(rethrowForQueue);
  await recordModelCall({ purpose: 'boundary_summarize', modelId: slot.modelId, usage, latencyMs: Date.now() - started, jobId });

  const description = text.trim().slice(0, 40);
  if (description) await db.update(boundaries).set({ description }).where(eq(boundaries.id, boundaryId));
}
