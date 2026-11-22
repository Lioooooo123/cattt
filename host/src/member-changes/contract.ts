import type { projectFile, projectFileDescription } from "../files/projections.ts";
import type { projectBoundary, projectDiaryEntry, projectMemory } from "../member-resources/projections.ts";

import type { readActorMailbox } from "../store/mailbox.ts";
import type { projectWorld } from "../store/world-state.ts";
import type { ticketView } from "../store/tickets.ts";

type Live<T> = Extract<T, { deleted_at: null }>;

export interface MemberChangeValues {
  memory: Live<ReturnType<typeof projectMemory>>;
  boundary: Live<ReturnType<typeof projectBoundary>>;
  diary: Live<ReturnType<typeof projectDiaryEntry>>;
  file: ReturnType<typeof projectFile>;
  file_description: ReturnType<typeof projectFileDescription> & { revision: number };
  ticket: ReturnType<typeof ticketView> & { revision: number };
  mailbox_letter: ReturnType<typeof readActorMailbox>[number];
  world: NonNullable<ReturnType<typeof projectWorld>>;
}

export type MemberChangeKind = keyof MemberChangeValues;

export type MemberProjection = {
  [Kind in MemberChangeKind]: { kind: Kind; value: MemberChangeValues[Kind] };
}[MemberChangeKind];

export type MemberChange = { id: string; sequence: number } & (
  | ({ op: "upsert" } & MemberProjection)
  | { op: "delete"; kind: MemberChangeKind }
);

export interface MemberChangePage {
  generation: string;
  reset: false;
  changes: MemberChange[];
  has_more: boolean;
  next: string;
}
