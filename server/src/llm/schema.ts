import { z } from 'zod';
import type { InputSchema } from './types.ts';

export function jsonSchema(schema: InputSchema): Record<string, unknown> {
  return schema instanceof z.ZodType ? z.toJSONSchema(schema) : schema;
}
