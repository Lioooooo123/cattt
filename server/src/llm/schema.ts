import { z } from 'zod';
import type { InputSchema } from './types.ts';

export function jsonSchema(schema: InputSchema): Record<string, unknown> {
  return schema instanceof z.ZodType ? z.toJSONSchema(schema, {
    target: 'draft-7', io: 'input', reused: 'inline',
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === 'object' && (jsonSchema.additionalProperties == null || typeof jsonSchema.additionalProperties === 'boolean'))
        jsonSchema.additionalProperties = false;
    },
  }) : schema;
}
