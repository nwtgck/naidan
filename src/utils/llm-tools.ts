import { z } from 'zod';

/**
 * Converts a Zod object schema to a strictly validated JSON schema for LLM tools.
 * Enforces '.strict()' to ensure the LLM rejects hallucinated parameters.
 * Directly utilizes Zod v4's native toJSONSchema capability.
 */
export function zodToJsonSchema({ schema }: { schema: z.ZodObject<z.ZodRawShape> }): unknown {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema.strict());
  return jsonSchema;
}
