import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  missingAsUndefined,
  resolveMissingAsUndefined,
} from './missingAsUndefined';

describe('missingAsUndefined', () => {
  it('materializes a missing object key as undefined after resolution', () => {
    const schema = resolveMissingAsUndefined(z.object({
      a: missingAsUndefined(z.string()),
    }));

    const parsed = schema.parse({});

    expect(Object.hasOwn(parsed, 'a')).toBe(true);
    expect(parsed.a).toBeUndefined();
  });

  it('preserves explicit values', () => {
    const schema = resolveMissingAsUndefined(z.object({
      a: missingAsUndefined(z.string()),
    }));

    expect(schema.parse({ a: 'value' })).toEqual({ a: 'value' });
  });

  it('supports undefined-only DTO fields', () => {
    const schema = resolveMissingAsUndefined(z.object({
      a: missingAsUndefined(z.undefined()),
    }));

    const parsed = schema.parse({});

    expect(Object.hasOwn(parsed, 'a')).toBe(true);
    expect(parsed.a).toBeUndefined();
  });

  it('keeps public output types focused on the resolved undefined shape', () => {
    const rawSchema = z.object({
      a: missingAsUndefined(z.string()),
    });
    const resolvedSchema = resolveMissingAsUndefined(rawSchema);

    expectTypeOf<z.input<typeof rawSchema>>().toEqualTypeOf<{
      a?: string | undefined;
    }>();
    expectTypeOf<z.output<typeof rawSchema>>().toEqualTypeOf<{
      a: string | undefined;
    }>();
    expectTypeOf<z.output<typeof resolvedSchema>>().toEqualTypeOf<{
      a: string | undefined;
    }>();
  });

  it('resolves nested objects only when the nested schema is resolved explicitly', () => {
    const nestedSchema = resolveMissingAsUndefined(z.object({
      value: missingAsUndefined(z.string()),
    }));
    const schema = resolveMissingAsUndefined(z.object({
      nested: missingAsUndefined(nestedSchema),
    }));

    expect(schema.parse({})).toEqual({ nested: undefined });
    expect(schema.parse({ nested: {} })).toEqual({ nested: { value: undefined } });
  });

  it('keeps normalization when a resolved object schema is safely extended', () => {
    const baseSchema = resolveMissingAsUndefined(z.object({
      a: missingAsUndefined(z.string()),
    }));
    const schema = baseSchema.safeExtend({
      b: missingAsUndefined(z.boolean()),
    });

    expect(schema.parse({})).toEqual({ a: undefined, b: undefined });
  });

  it('supports local shape spreads for incompatible overrides', () => {
    const baseSchema = resolveMissingAsUndefined(z.object({
      name: missingAsUndefined(z.string()),
      size: z.number(),
    }));
    const schema = resolveMissingAsUndefined(z.object({
      ...baseSchema.shape,
      name: z.union([z.string(), z.null()]),
    }));

    expect(schema.parse({ name: null, size: 1 })).toEqual({ name: null, size: 1 });
  });
});
