import type { BlobStorage } from "../files/blobs.ts";
import { projectFile, projectFileDescription } from "../files/projections.ts";
import type { Actor } from "../identity/index.ts";
import { projectBoundary, projectDiaryEntry, projectMemory } from "../member-resources/projections.ts";
import { listSharedDiaryEntries } from "../store/diary.ts";
import { getVisibleFileDescription } from "../store/file-descriptions.ts";
import { listAvailableFilesForActor } from "../store/files.ts";
import type { StoreDb } from "../store/index.ts";
import { listAvailableBoundaries, listAvailableMemories } from "../store/knowledge.ts";
import { readActorMailbox } from "../store/mailbox.ts";
import { readActorTickets, ticketView } from "../store/tickets.ts";
import { projectWorld } from "../store/world-state.ts";
import type { MemberChangeKind, MemberProjection } from "./contract.ts";

type Reader = Pick<StoreDb, "select">;

export type MemberProjectionReader = (db: Reader, actor: Actor) => Iterable<MemberProjection>;

const supportedKinds = {
  memory: true,
  boundary: true,
  diary: true,
  file: true,
  file_description: true,
  ticket: true,
  mailbox_letter: true,
  world: true,
} satisfies Record<MemberChangeKind, true>;

export function isMemberChangeKind(kind: string): kind is MemberChangeKind {
  return Object.hasOwn(supportedKinds, kind);
}

function* knowledge(db: Reader, actor: Actor): Iterable<MemberProjection> {
  const { householdId, memberId } = actor;
  for (const row of listAvailableMemories(db, { householdId })) {
    const value = projectMemory(db, actor, row);
    if (value?.deleted_at === null) {
      yield { kind: "memory", value };
    }
  }
  for (const row of listAvailableBoundaries(db, { householdId, subjectMemberId: memberId })) {
    const value = projectBoundary(db, actor, row);
    if (value?.deleted_at === null) {
      yield { kind: "boundary", value };
    }
  }
  for (const row of listSharedDiaryEntries(db, householdId)) {
    const value = projectDiaryEntry(db, actor, row);
    if (value?.deleted_at === null) {
      yield { kind: "diary", value };
    }
  }
}

function* ticketsAndMailbox(db: Reader, actor: Actor): Iterable<MemberProjection> {
  for (const row of readActorTickets(db, actor, "all")) {
    yield { kind: "ticket", value: { ...ticketView(row), revision: row.rev } };
  }
  for (const value of readActorMailbox(db, actor)) {
    yield { kind: "mailbox_letter", value };
  }
}

export function memberProjectionReaders(storage: BlobStorage): readonly MemberProjectionReader[] {
  return [knowledge, ticketsAndMailbox, function* (db, actor) {
    const world = projectWorld(db, actor.householdId);
    if (world) yield { kind: "world", value: world };
  }, function* (db, actor) {
    for (const row of listAvailableFilesForActor(db, actor)) {
      yield { kind: "file", value: projectFile(db, storage, row) };
      const description = getVisibleFileDescription(db, row);
      if (description) {
        yield { kind: "file_description", value: { ...projectFileDescription(description), revision: description.rev } };
      }
    }
  }];
}
