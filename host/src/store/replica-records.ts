import { catFactReplica } from "./cat-fact-replica.ts";
import { worldReplicas } from "./world-replicas.ts";
import { pgImportReplicas } from "./pg-import/replicas.ts";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  fileDescriptionModelSchema, fileDescriptionTextSchema, fileMediaTypeSchema, fileNameSchema, MAX_FILE_BYTES, SHA256_PATTERN,
} from "../files/types.ts";
import { businessFields, businessId, ReplicationError } from "../replication/types.ts";
import type { ReplicationSource } from "../replication/types.ts";
import { localISO } from "../tickets/time.ts";
import {
  assertReplicaIdentity, assertReplicaWriter, defineReplicationAdapter, requireReplicaDependency,
} from "./replication-adapter.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { conversations, messages, participants } from "./schema/conversations.ts";
import { groupSendIntents } from "./schema/group-sends.ts";
import { messagePublicationFact, publicationIsSealed, publicationProof } from "./publication.ts";
import { households, hosts, members } from "./schema/identity.ts";
import { fileDescriptions, files } from "./schema/files.ts";
import { knowledgeReplicas, replyEvidenceSchema, projectMessageReplica } from "./knowledge-replicas.ts";
import { chatReplyKnowledge } from "./schema/memory-extraction.ts";
import { relayGrants } from "./schema/relay.ts";

import { conversationInHousehold, hostInHousehold, household, memberInHousehold } from "./replica-scope.ts";
import { ticketReplicaAdapters } from "./ticket-replica-records.ts";

const name = z.string().min(1);

const householdReplica = defineReplicationAdapter("household", z.strictObject({
  ...businessFields,
  name,
}), {
  read: (tx, id) => tx.select().from(households).where(eq(households.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(households).where(and(
    eq(households.id, source.householdId), eq(households.originHostId, source.sourceHostId),
  )).limit(limit).all(),
  write: (tx, row) => { tx.insert(households).values(row).onConflictDoUpdate({ target: households.id, set: row }).run(); },
  authorize: (_tx, source, row) => assertReplicaWriter(row.id === source.householdId && row.originHostId === source.sourceHostId),
  identity: () => [],
});

const hostReplica = defineReplicationAdapter("host", z.strictObject({
  ...businessFields,
  householdId: businessId,
  displayName: name,
}), {
  read: (tx, id) => tx.select().from(hosts).where(eq(hosts.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(hosts).where(and(
    eq(hosts.id, source.sourceHostId), eq(hosts.householdId, source.householdId),
  )).limit(limit).all(),
  write: (tx, row) => { tx.insert(hosts).values(row).onConflictDoUpdate({ target: hosts.id, set: row }).run(); },
  authorize(tx, source, row) {
    assertReplicaWriter(row.householdId === source.householdId
      && row.id === source.sourceHostId && row.originHostId === source.sourceHostId);
    household(tx, row.householdId);
  },
  identity: (row) => [row.householdId],
});

const memberReplica = defineReplicationAdapter("member", z.strictObject({
  ...businessFields,
  householdId: businessId,
  homeHostId: businessId,
  displayName: name,
}), {
  read: (tx, id) => tx.select().from(members).where(eq(members.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(members).where(and(
    eq(members.householdId, source.householdId), eq(members.originHostId, source.sourceHostId),
  )).orderBy(asc(members.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(members).values(row).onConflictDoUpdate({ target: members.id, set: row }).run(); },
  authorize(tx, source, row) {
    assertReplicaWriter(row.householdId === source.householdId && row.originHostId === source.sourceHostId);
    hostInHousehold(tx, source.sourceHostId, row.householdId);
    hostInHousehold(tx, row.homeHostId, row.householdId);
  },
  identity: (row) => [row.householdId, row.homeHostId],
});

const conversationReplica = defineReplicationAdapter("conversation", z.strictObject({
  ...businessFields,
  householdId: businessId,
  kind: z.enum(["group", "direct"]),
  ownerMemberId: businessId.nullable(),
  publisherHostId: businessId,
}), {
  read: (tx, id) => tx.select().from(conversations).where(eq(conversations.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(conversations).where(and(
    eq(conversations.householdId, source.householdId), eq(conversations.originHostId, source.sourceHostId),
  )).orderBy(asc(conversations.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(conversations).values(row).onConflictDoUpdate({ target: conversations.id, set: row }).run(); },
  authorize(tx, source, row) {
    assertReplicaWriter(row.householdId === source.householdId && row.originHostId === source.sourceHostId);
    const family = household(tx, row.householdId);
    hostInHousehold(tx, row.publisherHostId, row.householdId);
    if (row.kind === "group") {
      assertReplicaWriter(row.ownerMemberId === null && row.originHostId === family.originHostId
        && row.publisherHostId === family.originHostId);
    } else {
      assertReplicaWriter(row.ownerMemberId !== null);
      const owner = memberInHousehold(tx, row.ownerMemberId, row.householdId);
      assertReplicaWriter(row.originHostId === owner.originHostId && row.publisherHostId === owner.homeHostId);
    }
    const existing = tx.select({ id: conversations.id }).from(conversations).where(and(
      eq(conversations.kind, row.kind),
      row.ownerMemberId === null
        ? eq(conversations.householdId, row.householdId)
        : eq(conversations.ownerMemberId, row.ownerMemberId),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [row.householdId, row.kind, row.ownerMemberId],
});

const participantReplica = defineReplicationAdapter("participant", z.strictObject({
  ...businessFields,
  conversationId: businessId,
  memberId: businessId,
}), {
  read: (tx, id) => tx.select().from(participants).where(eq(participants.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select({ row: participants }).from(participants)
    .innerJoin(conversations, eq(participants.conversationId, conversations.id)).where(and(
      eq(conversations.householdId, source.householdId), eq(participants.originHostId, source.sourceHostId),
    )).orderBy(asc(participants.id)).limit(limit).all().map(({ row }) => row),
  write: (tx, row) => { tx.insert(participants).values(row).onConflictDoUpdate({ target: participants.id, set: row }).run(); },
  authorize(tx, source, row) {
    assertReplicaWriter(row.originHostId === source.sourceHostId);
    const conversation = conversationInHousehold(tx, source, row.conversationId);
    const member = memberInHousehold(tx, row.memberId, conversation.householdId);
    assertReplicaWriter(member.originHostId === source.sourceHostId
      && (conversation.kind === "group" || conversation.ownerMemberId === member.id));
    const existing = tx.select({ id: participants.id }).from(participants).where(and(
      eq(participants.conversationId, row.conversationId), eq(participants.memberId, row.memberId),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [row.conversationId, row.memberId],
});

const replyEvidenceListSchema = z.array(replyEvidenceSchema);

const messageReplica = defineReplicationAdapter("message", z.strictObject({
  ...businessFields,
  conversationId: businessId,
  authorMemberId: businessId.nullable(),
  text: z.string(),
  modality: z.literal("text"),
  status: z.enum(["complete", "stopped"]),
  clientMessageId: z.string().min(1).max(100).nullable(),
  replyToMessageId: businessId.nullable(),
  publicationEpoch: z.int().positive().nullable().default(null),
  knowledgeEvidence: replyEvidenceListSchema.default([]),
  historyContextBlocked: z.literal(true).optional(),
}), {
  read: (tx, id) => {
    const row = tx.select().from(messages).where(eq(messages.id, id)).get();
    return row && projectMessageReplica(tx, row);
  },
  snapshotRows: (tx, source, limit) => tx.select({ row: messages }).from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id)).where(and(
      eq(conversations.householdId, source.householdId), eq(messages.originHostId, source.sourceHostId),
    )).orderBy(sql`"messages".rowid`).limit(limit).all().map(({ row }) => projectMessageReplica(tx, row)),
  write: (tx, { knowledgeEvidence, ...row }) => {
    // Preserve a local turn link if the same business row already exists here.
    const persisted = { ...row, historyContextBlocked: row.historyContextBlocked ?? false };
    tx.insert(messages).values(persisted).onConflictDoUpdate({ target: messages.id, set: persisted }).run();
    if (knowledgeEvidence.length) {
      tx.insert(chatReplyKnowledge).values({ messageId: row.id, references: knowledgeEvidence }).onConflictDoNothing().run();
    }
  },
  authorize(tx, source, row) {
    assertReplicaWriter(row.originHostId === source.sourceHostId);
    const conversation = conversationInHousehold(tx, source, row.conversationId);
    assertReplicaWriter(!row.historyContextBlocked || conversation.kind === "direct");
    if (row.knowledgeEvidence.length) {
      const stored = tx.select().from(chatReplyKnowledge).where(eq(chatReplyKnowledge.messageId, row.id)).get();
      if (stored) {
        const current = replyEvidenceListSchema.safeParse(stored.references);
        assertReplicaIdentity(current.success && JSON.stringify(current.data) === JSON.stringify(row.knowledgeEvidence));
      }
    }
    if (conversation.ownerMemberId === null) {
      const epoch = row.publicationEpoch ?? 1;
      const proof = requireReplicaDependency(
        publicationProof(tx, conversation.householdId, epoch), "publication_epoch", `${conversation.householdId}/${epoch}`,
      );
      assertReplicaWriter(proof.holderHostId === source.sourceHostId);
      if (publicationIsSealed(tx, conversation.householdId, epoch)) {
        const existing = tx.select().from(messages).where(eq(messages.id, row.id)).get();
        assertReplicaWriter(existing && JSON.stringify(messagePublicationFact(existing)) === JSON.stringify(messagePublicationFact({ ...row, historyContextBlocked: row.historyContextBlocked ?? false })));
      }
    } else {
      const owner = memberInHousehold(tx, conversation.ownerMemberId, conversation.householdId);
      assertReplicaWriter(row.publicationEpoch === null && owner.homeHostId === source.sourceHostId);
    }
    if (row.authorMemberId !== null) {
      assertReplicaWriter(row.knowledgeEvidence.length === 0);
      memberInHousehold(tx, row.authorMemberId, conversation.householdId);
      assertReplicaWriter(conversation.kind === "group" || conversation.ownerMemberId === row.authorMemberId);
    }
    if (row.replyToMessageId !== null) {
      const replyTo = requireReplicaDependency(
        tx.select().from(messages).where(eq(messages.id, row.replyToMessageId)).get(),
        "message", row.replyToMessageId,
      );
      assertReplicaIdentity(replyTo.conversationId === row.conversationId && replyTo.id !== row.id);
    }
    if (row.authorMemberId !== null && row.clientMessageId !== null) {
      const existing = tx.select({ id: messages.id }).from(messages).where(and(
        eq(messages.conversationId, row.conversationId), eq(messages.authorMemberId, row.authorMemberId),
        eq(messages.clientMessageId, row.clientMessageId),
      )).get();
      assertReplicaIdentity(!existing || existing.id === row.id);
    }
  },
  identity: (row) => [row.conversationId, row.authorMemberId, row.modality, row.clientMessageId, row.replyToMessageId, row.publicationEpoch],
  fact: (row) => [row.text, row.status, row.hlc, row.rev, row.updatedAt, row.historyContextBlocked ?? false],
  equalRevisionOrder: (next, current) => Number(next.knowledgeEvidence.length > 0) - Number(current.knowledgeEvidence.length > 0),
});

const groupSendIntentReplica = defineReplicationAdapter("group_send_intent", z.strictObject({
  ...businessFields,
  householdId: businessId,
  conversationId: businessId,
  memberId: businessId,
  clientMessageId: z.string().min(1).max(100),
  text: z.string().min(1).max(4000).refine((value) => value === value.trim()),
}), {
  read: (tx, id) => tx.select().from(groupSendIntents).where(eq(groupSendIntents.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(groupSendIntents).where(and(
    eq(groupSendIntents.originHostId, source.sourceHostId), eq(groupSendIntents.householdId, source.householdId),
  )).orderBy(asc(groupSendIntents.id)).limit(limit).all(),
  write(tx, row) {
    tx.insert(groupSendIntents).values(row).onConflictDoNothing({ target: groupSendIntents.id }).run();
  },
  authorize(tx, source, row) {
    assertReplicaWriter(row.originHostId === source.sourceHostId && row.householdId === source.householdId
      && row.rev === 1 && row.deletedAt === null && row.createdAt === row.updatedAt);
    const conversation = conversationInHousehold(tx, source, row.conversationId);
    const member = memberInHousehold(tx, row.memberId, row.householdId);
    assertReplicaWriter(conversation.kind === "group" && member.homeHostId === source.sourceHostId);
    const existing = tx.select({ id: groupSendIntents.id }).from(groupSendIntents).where(and(
      eq(groupSendIntents.conversationId, row.conversationId), eq(groupSendIntents.memberId, row.memberId),
      eq(groupSendIntents.clientMessageId, row.clientMessageId),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [row.householdId, row.conversationId, row.memberId, row.clientMessageId],
  fact: (row) => [row.text, row.hlc, row.updatedAt],
});

const knowledgeSourceFields = {
  householdId: businessId,
  sourceMemberId: businessId,
  sourceMessageId: businessId,
  sourceRevision: z.int().positive(),
};

function checkSource(
  tx: ReplicationTx, source: ReplicationSource, row: {
    originHostId: string; householdId: string; sourceMemberId: string; sourceMessageId: string; sourceRevision: number;
  },
) {
  assertReplicaWriter(row.householdId === source.householdId && row.originHostId === source.sourceHostId);
  const member = memberInHousehold(tx, row.sourceMemberId, row.householdId);
  const message = requireReplicaDependency(
    tx.select().from(messages).where(eq(messages.id, row.sourceMessageId)).get(), "message", row.sourceMessageId,
  );
  conversationInHousehold(tx, source, message.conversationId);
  assertReplicaWriter(member.homeHostId === source.sourceHostId && message.authorMemberId === member.id
    && message.rev >= row.sourceRevision);
  return message;
}

function validSourceDay(row: { createdAt: number; sourceDay: string; sourceTimeZone: string }) {
  try {
    return localISO(row.createdAt, row.sourceTimeZone).slice(0, 10) === row.sourceDay;
  } catch {
    return false;
  }
}

const sourceIdentity = (row: { householdId: string; sourceMemberId: string; sourceMessageId: string; sourceRevision: number }) =>
  [row.householdId, row.sourceMemberId, row.sourceMessageId, row.sourceRevision];

const relayGrantReplica = defineReplicationAdapter("relay_grant", z.strictObject({
  ...businessFields,
  ...knowledgeSourceFields,
  targetMemberId: businessId,
  targetHostId: businessId,
  sourceGeneration: z.uuidv4(),
  sourceSeq: z.int().positive(),
  sourceDay: z.iso.date(),
  sourceTimeZone: z.string().min(1).max(100),
  urgent: z.boolean(),
}), {
  read: (tx, id) => tx.select().from(relayGrants).where(eq(relayGrants.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(relayGrants).where(and(
    eq(relayGrants.householdId, source.householdId), eq(relayGrants.originHostId, source.sourceHostId),
  )).orderBy(asc(relayGrants.id)).limit(limit).all(),
  write: (tx, row) => {
    tx.insert(relayGrants).values(row).onConflictDoUpdate({ target: relayGrants.id, set: row }).run();
  },
  authorize(tx, source, row) {
    const message = checkSource(tx, source, row);
    const target = memberInHousehold(tx, row.targetMemberId, row.householdId);
    hostInHousehold(tx, row.targetHostId, row.householdId);
    assertReplicaWriter(message.originHostId === source.sourceHostId && row.sourceMemberId !== target.id
      && row.targetHostId === target.homeHostId && row.deletedAt === null && row.rev === 1 && validSourceDay(row));
    const original = tx.select({ id: relayGrants.id }).from(relayGrants)
      .where(eq(relayGrants.sourceMessageId, row.sourceMessageId)).get();
    assertReplicaIdentity(!original || original.id === row.id);
  },
  identity: (row) => [
    ...sourceIdentity(row), row.targetMemberId, row.targetHostId, row.sourceGeneration,
    row.sourceSeq, row.sourceDay, row.sourceTimeZone, row.urgent,
  ],
  fact: (row) => [row.hlc, row.updatedAt],
});

const fileSourceFields = {
  sha256: z.string().regex(SHA256_PATTERN),
  sourceMessageId: businessId.nullable(),
  sourceMessageRev: z.int().positive().nullable(),
};

function authorizeFileOwner(tx: ReplicationTx, source: ReplicationSource, row: typeof files.$inferSelect) {
  assertReplicaWriter(row.originHostId === source.sourceHostId && row.householdId === source.householdId);
  hostInHousehold(tx, source.sourceHostId, row.householdId);
  const owner = memberInHousehold(tx, row.ownerMemberId, row.householdId);
  const conversation = conversationInHousehold(tx, source, row.conversationId);
  // Attachments are authored by the member's home host, including in group chat.
  assertReplicaWriter(owner.homeHostId === source.sourceHostId
    && (conversation.kind === "group" || conversation.ownerMemberId === owner.id));
  if ((row.sourceMessageId === null) !== (row.sourceMessageRev === null)) {
    throw new ReplicationError("invalid_record", "附件消息 ID 与来源修订必须成对出现");
  }
  if (row.sourceMessageId !== null) {
    const message = tx.select().from(messages).where(eq(messages.id, row.sourceMessageId)).get();
    // A different native stream may supply the message. Both the blob and any
    // model description stay unreadable until the source is present and valid.
    assertReplicaWriter(!message || (message.conversationId === conversation.id && message.authorMemberId === owner.id));
  }
}

const fileReplica = defineReplicationAdapter("file", z.strictObject({
  ...businessFields,
  ...fileSourceFields,
  householdId: businessId,
  ownerMemberId: businessId,
  conversationId: businessId,
  byteSize: z.int().min(1).max(MAX_FILE_BYTES),
  fileName: fileNameSchema,
  mediaType: fileMediaTypeSchema,
  description: z.string().max(2000).nullable(),
}), {
  read: (tx, id) => tx.select().from(files).where(eq(files.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select().from(files).where(and(
    eq(files.householdId, source.householdId), eq(files.originHostId, source.sourceHostId),
  )).orderBy(asc(files.id)).limit(limit).all(),
  write: (tx, row) => { tx.insert(files).values(row).onConflictDoUpdate({ target: files.id, set: row }).run(); },
  authorize: authorizeFileOwner,
  identity: (row) => [row.householdId, row.ownerMemberId, row.conversationId, row.sha256, row.byteSize,
    row.sourceMessageId, row.sourceMessageRev],
});

const fileDescriptionReplica = defineReplicationAdapter("file_description", z.strictObject({
  ...businessFields,
  ...fileSourceFields,
  fileId: businessId,
  fileRev: z.int().positive(),
  modelId: fileDescriptionModelSchema,
  text: fileDescriptionTextSchema,
}), {
  read: (tx, id) => tx.select().from(fileDescriptions).where(eq(fileDescriptions.id, id)).get(),
  snapshotRows: (tx, source, limit) => tx.select({ row: fileDescriptions }).from(fileDescriptions)
    .innerJoin(files, eq(fileDescriptions.fileId, files.id)).where(and(
      eq(files.householdId, source.householdId), eq(fileDescriptions.originHostId, source.sourceHostId),
    )).orderBy(asc(fileDescriptions.id)).limit(limit).all().map(({ row }) => row),
  write: (tx, row) => {
    tx.insert(fileDescriptions).values(row).onConflictDoUpdate({ target: fileDescriptions.id, set: row }).run();
  },
  authorize(tx, source, row) {
    const file = requireReplicaDependency(
      tx.select().from(files).where(eq(files.id, row.fileId)).get(), "file", row.fileId,
    );
    authorizeFileOwner(tx, source, file);
    assertReplicaWriter(row.originHostId === file.originHostId);
    assertReplicaIdentity(row.sha256 === file.sha256 && row.sourceMessageId === file.sourceMessageId
      && row.sourceMessageRev === file.sourceMessageRev);
    if (row.fileRev > file.rev) {
      requireReplicaDependency(undefined, "file", row.fileId);
    }
    const existing = tx.select({ id: fileDescriptions.id }).from(fileDescriptions).where(and(
      eq(fileDescriptions.fileId, row.fileId), eq(fileDescriptions.fileRev, row.fileRev),
    )).get();
    assertReplicaIdentity(!existing || existing.id === row.id);
  },
  identity: (row) => [row.fileId, row.fileRev, row.sha256, row.sourceMessageId, row.sourceMessageRev],
  fact: (row) => [row.modelId, row.text, row.rev, row.hlc, row.updatedAt],
});

export const replicaAdapters = {
  household: householdReplica,
  host: hostReplica,
  member: memberReplica,
  conversation: conversationReplica,
  participant: participantReplica,
  message: messageReplica,
  ...knowledgeReplicas,
  ...pgImportReplicas,
  file: fileReplica,
  file_description: fileDescriptionReplica,
  relay_grant: relayGrantReplica,
  group_send_intent: groupSendIntentReplica,
  ...ticketReplicaAdapters,
  ...worldReplicas,
  cat_fact: catFactReplica,
};

export type NativeReplicaRecord = ReturnType<(typeof replicaAdapters)[keyof typeof replicaAdapters]["decode"]>;
