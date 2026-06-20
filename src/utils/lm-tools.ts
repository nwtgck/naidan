import { z } from 'zod';

/**
 * Converts a Zod object schema to a strictly validated JSON schema for LM tools.
 * Enforces '.strict()' to ensure the LM rejects hallucinated parameters.
 * Directly utilizes Zod v4's native toJSONSchema capability.
 */
export function zodToJsonSchema({ schema }: { schema: z.ZodObject<z.ZodRawShape> }): unknown {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema.strict());
  return jsonSchema;
}
