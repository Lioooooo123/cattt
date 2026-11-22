import { z } from "zod";
import type { BehaviorParams } from "./behavior.ts";
import { ackSchema, baseRevision, moveSchema, profileSchema, sessionIdentity, snapshotSchema } from "./protocol.ts";
import type { WorldSnapshot } from "./protocol.ts";

const fields = snapshotSchema.shape;
const observation = z.codec(z.strictObject({
  state_version: fields.stateVersion,
  scene_version: fields.sceneVersion,
  destination_ids: fields.destinationIds,
  current_destination_id: fields.currentDestinationId,
  target_destination_id: fields.targetDestinationId,
  phase: fields.phase,
  action: fields.action,
  companion_seat: fields.companionSeat,
  activity: fields.activity,
  activity_fallback: fields.activityFallback,
  paused: fields.paused,
  runnable: fields.runnable,
  mood: fields.mood,
  mood_reason: fields.moodReason,
  day_phase: fields.dayPhase,
  weather: fields.weather,
  bowl_filled_today: fields.bowlFilledToday,
  last_drink_at: fields.lastDrinkAt,
  places_today: fields.placesToday,
}), snapshotSchema, {
  decode: (dto) => ({
    stateVersion: dto.state_version,
    sceneVersion: dto.scene_version,
    destinationIds: dto.destination_ids,
    currentDestinationId: dto.current_destination_id,
    targetDestinationId: dto.target_destination_id,
    phase: dto.phase,
    action: dto.action,
    ...(dto.companion_seat !== undefined && { companionSeat: dto.companion_seat }),
    ...(dto.activity !== undefined && { activity: dto.activity }),
    ...(dto.activity_fallback !== undefined && { activityFallback: dto.activity_fallback }),
    paused: dto.paused,
    runnable: dto.runnable,
    mood: dto.mood,
    moodReason: dto.mood_reason,
    dayPhase: dto.day_phase,
    weather: dto.weather,
    bowlFilledToday: dto.bowl_filled_today,
    ...(dto.last_drink_at !== undefined && { lastDrinkAt: dto.last_drink_at }),
    placesToday: dto.places_today,
  }),
  encode(input) {
    const snapshot = snapshotSchema.parse(input);
    return {
      state_version: snapshot.stateVersion,
      scene_version: snapshot.sceneVersion,
      destination_ids: snapshot.destinationIds,
      current_destination_id: snapshot.currentDestinationId,
      target_destination_id: snapshot.targetDestinationId,
      phase: snapshot.phase,
      action: snapshot.action,
      companion_seat: snapshot.companionSeat,
      activity: snapshot.activity,
      activity_fallback: snapshot.activityFallback,
      paused: snapshot.paused,
      runnable: snapshot.runnable,
      mood: snapshot.mood,
      mood_reason: snapshot.moodReason,
      day_phase: snapshot.dayPhase,
      weather: snapshot.weather,
      bowl_filled_today: snapshot.bowlFilledToday,
      last_drink_at: snapshot.lastDrinkAt,
      places_today: snapshot.placesToday,
    };
  },
});

export function projectSnapshot(snapshot: WorldSnapshot | null) {
  return snapshot ? observation.encode(snapshot) : null;
}

export function projectBehavior(params: BehaviorParams | null) {
  return params && {
    idle_scale: params.idleScale, home_idle_scale: params.homeIdleScale,
    sleep_weight: params.sleepWeight, look_weight: params.lookWeight, tilt_share: params.tiltShare,
    groom_weight: params.groomWeight, place_weights: params.placeWeights, comes_to_door: params.comesToDoor,
    mood_scale: params.moodScale, drink_delay: params.drinkDelay, diary_sentences: params.diarySentences,
  };
}

const session = z.strictObject({
  session_id: sessionIdentity.shape.sessionId,
  generation: sessionIdentity.shape.generation,
});
export const sessionQuery = session.transform(({ session_id, generation }) => ({ sessionId: session_id, generation }));

export const stateRequest = session.extend({ base_revision: baseRevision, snapshot: observation }).transform((value) => ({
  sessionId: value.session_id, generation: value.generation, baseRevision: value.base_revision, snapshot: value.snapshot,
}));

export const profileRequest = profileSchema.extend({ base_revision: baseRevision });

export const actionRequest = session.extend({
  request_id: moveSchema.shape.requestId,
  destination_id: moveSchema.shape.destinationId,
  state_version: moveSchema.shape.stateVersion,
  activity: moveSchema.shape.activity,
}).transform((value) => ({
  sessionId: value.session_id, generation: value.generation, requestId: value.request_id,
  destinationId: value.destination_id, stateVersion: value.state_version, activity: value.activity,
}));

export const ackRequest = session.extend({
  status: ackSchema.shape.status,
  snapshot: observation,
  reason: ackSchema.shape.reason,
  occurred_at: ackSchema.shape.occurredAt,
}).transform((value) => ({
  sessionId: value.session_id, generation: value.generation, status: value.status,
  snapshot: value.snapshot, reason: value.reason, occurredAt: value.occurred_at,
}));
