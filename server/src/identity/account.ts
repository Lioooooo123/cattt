import { cats } from '../db/schema.ts';

export const accountJSON = (c: typeof cats.$inferSelect) => ({ id: c.id, name: c.name, appearance: c.appearance, temperament: c.temperament, traits: c.traits, created_at: c.createdAt });
