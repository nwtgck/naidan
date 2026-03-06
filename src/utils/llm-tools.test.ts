import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './llm-tools';

describe('zodToJsonSchema', () => {
  it('converts basic object schemas correctly', () => {
    const schema = z.object({
      name: z.string().describe('The name of the user'),
      age: z.number().optional().describe('The age of the user'),
    });

    const result = zodToJsonSchema({ schema }) as any;

    expect(result.type).toBe('object');
    expect(result.properties).toHaveProperty('name');
    expect(result.properties.name.type).toBe('string');
    expect(result.properties.name.description).toBe('The name of the user');
    expect(result.properties).toHaveProperty('age');
    expect(result.properties.age.type).toBe('number');
    expect(result.required).toContain('name');
    expect(result.required).not.toContain('age');
  });

  it('enforces strict mode (additionalProperties: false)', () => {
    const schema = z.object({
      id: z.string(),
    });

    const result = zodToJsonSchema({ schema }) as any;
    expect(result.additionalProperties).toBe(false);
  });

  it('handles nested objects', () => {
    const schema = z.object({
      metadata: z.object({
        source: z.string(),
      }),
    });

    const result = zodToJsonSchema({ schema }) as any;
    expect(result.properties.metadata.type).toBe('object');
    expect(result.properties.metadata.properties.source.type).toBe('string');
  });

  it('strips meta fields like $schema', () => {
    const schema = z.object({ foo: z.string() });
    const result = zodToJsonSchema({ schema }) as any;

    expect(result).not.toHaveProperty('$schema');
  });

  it('handles array types', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const result = zodToJsonSchema({ schema }) as any;
    expect(result.properties.tags.type).toBe('array');
    expect(result.properties.tags.items.type).toBe('string');
  });

  it('handles enum types (Literal Union)', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive']),
    });

    const result = zodToJsonSchema({ schema }) as any;
    expect(result.properties.status.enum).toEqual(['active', 'inactive']);
  });
});
