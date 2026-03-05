import { z } from 'zod';
import { zodToJsonSchema as _zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Converts a Zod schema to a JSON schema suitable for LLM tool definitions.
 * Strips the $schema field and handles environment-specific import issues.
 */
export function zodToJsonSchema({ schema }: { schema: z.ZodTypeAny }): unknown {
  try {
    // Handle potential bundler/environment wrapping of the import
    const fn = typeof _zodToJsonSchema === 'function'
      ? _zodToJsonSchema
      : (typeof (_zodToJsonSchema as any).default === 'function' ? (_zodToJsonSchema as any).default : null);

    if (typeof fn !== 'function') {
      throw new Error('zodToJsonSchema function not found in module');
    }

    // Force strict mode so LLM doesn't send hallucinated parameters
    const schemaToConvert = (schema as any)._def?.typeName === 'ZodObject'
      ? (schema as any).strict()
      : schema;

    const res = fn(schemaToConvert, { target: 'openApi3' }) as any;
    if (res && typeof res === 'object') {
      const { $schema, ...rest } = res;
      return rest;
    }
    return res;
  } catch (e) {
    console.error('zodToJsonSchema failed:', e);
    return {};
  }
}

