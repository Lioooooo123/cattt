import { z } from "zod";

export const destinationIds = ['house', 'tree', 'bed', 'grass', 'pond', 'fence'] as const;
export const snapshotSchema = z.object({
  stateVersion: z.number().int().nonnegative(),
  sceneVersion: z.literal(4),
  destinationIds: z.array(z.enum(destinationIds)).min(1).max(6).refine((ids) => new Set(ids).size === ids.length),
  currentDestinationId: z.enum(destinationIds),
  targetDestinationId: z.enum(destinationIds),
  phase: z.enum(['idle', 'moving', 'approaching', 'interacting', 'exiting']),
  action: z.string().min(1).max(80),
  companionSeat: z.enum(destinationIds).optional(),
  activity: z.enum(['sit', 'rest', 'watch', 'groom', 'drink', 'tilt', 'happy', 'sulk', 'sad', 'chase', 'stretch', 'run', 'scratch', 'flower']).optional(),
  activityFallback: z.boolean().optional(),
  paused: z.boolean(),
  runnable: z.boolean(),
  // 院子的可观察事实，独立于设备在场与执行资格。
  mood: z.enum(['calm', 'happy', 'sulk', 'sad']).default('calm'),
  moodReason: z.string().max(60).default(''),
  dayPhase: z.enum(['dawn', 'day', 'dusk', 'evening', 'night']).default('day'),
  weather: z.enum(['clear', 'rain']).default('clear'),
  bowlFilledToday: z.boolean().default(false),
  lastDrinkAt: z.iso.datetime({ offset: true }).nullish(),
  placesToday: z.array(z.string().max(20)).max(40).default([]),
}).refine((s) => s.destinationIds.includes(s.currentDestinationId) && s.destinationIds.includes(s.targetDestinationId));
export type WorldSnapshot = z.infer<typeof snapshotSchema>;
export const actionStatuses = ['requested', 'accepted', 'running', 'arrived', 'rejected', 'interrupted', 'expired'] as const;
export type ActionStatus = typeof actionStatuses[number];
export const terminalStatuses: ActionStatus[] = ['arrived', 'rejected', 'interrupted', 'expired'];
export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  if (from === to) return true;
  if (terminalStatuses.includes(from)) return false;
  if (to === 'interrupted' || to === 'expired') return true;
  if (from === 'requested') return to === 'accepted' || to === 'rejected';
  if (from === 'accepted') return to === 'running' || to === 'arrived';
  return from === 'running' && to === 'arrived';
}

export const WORLD_PROTOCOL_VERSION = 2;
export const PRESENCE_MS = 12_000;
export const STREAM_MS = 3_000;
export const OBSERVATION_MS = 5_000;

export const appearance = z.enum(["orange", "cow", "black", "calico"]);
export const temperament = z.enum(["slow", "close", "quiet", "curious"]);
const trait = z.int().min(0).max(2);
export const traits = z.strictObject({
  energy: trait, initiative: trait, directness: trait, closeness: trait,
});
export type Traits = z.infer<typeof traits>;
export type Temperament = z.infer<typeof temperament>;
export const profileSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  appearance, temperament, traits,
});
export type Profile = z.infer<typeof profileSchema>;
export const defaultProfile: Profile = {
  name: "团子", appearance: "orange", temperament: "slow",
  traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 },
};
export const sessionIdentity = z.strictObject({ sessionId: z.uuidv7(), generation: z.uuidv7() });
export type SessionIdentity = z.infer<typeof sessionIdentity>;
export const baseRevision = z.string().regex(/^[0-9a-f-]{36}:[1-9]\d*$/);
export const putStateSchema = sessionIdentity.extend({ baseRevision, snapshot: snapshotSchema });
export const moveSchema = sessionIdentity.extend({
  requestId: z.uuid(), destinationId: z.enum(destinationIds), activity: z.literal("sit").optional(),
  stateVersion: z.int().nonnegative(),
});
export const ackSchema = sessionIdentity.extend({
  status: z.enum(["accepted", "running", "arrived", "rejected", "interrupted"]),
  snapshot: snapshotSchema, reason: z.string().max(80).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});

export class WorldError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: 400 | 401 | 404 | 409 = 409) {
    super(code);
  }
}
