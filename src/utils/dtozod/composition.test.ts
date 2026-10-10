import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as dtozod from './index';

// Generic combinations must keep native optional-key and default behavior,
// not just the output of standalone primitive parse calls.
const dto = dtozod.object({
  optional: dtozod.number().optional(),
  nullable: dtozod.number().nullable(),
  optionalNullable: dtozod.number().optional().nullable(),
  nullableOptional: dtozod.number().nullable().optional(),
  defaultOptional: dtozod.number().default(3).optional(),
  optionalDefault: dtozod.number().optional().default(3),
  exactDefault: dtozod.number().exactOptional().default(3),
  defaultExact: dtozod.number().default(3).exactOptional(),
  nullDefault: dtozod.number().nullable().default(null),
  callback: dtozod.number().optional().default(() => 3),
  absent: dtozod.never().exactOptional(),
  unionOptional: dtozod.union([dtozod.number(), dtozod.undefined()]),
  array: dtozod.array(dtozod.number().optional()),
  tuple: dtozod.tuple([dtozod.number().optional(), dtozod.string().nullable()]),
});
const native = z.object({
  optional: z.number().optional(),
  nullable: z.number().nullable(),
  optionalNullable: z.number().optional().nullable(),
  nullableOptional: z.number().nullable().optional(),
  defaultOptional: z.number().default(3).optional(),
  optionalDefault: z.number().optional().default(3),
  exactDefault: z.number().exactOptional().default(3),
  defaultExact: z.number().default(3).exactOptional(),
  nullDefault: z.number().nullable().default(null),
  callback: z.number().optional().default(() => 3),
  absent: z.never().exactOptional(),
  unionOptional: z.union([z.number(), z.undefined()]),
  array: z.array(z.number().optional()),
  tuple: z.tuple([z.number().optional(), z.string().nullable()]),
});
const base = { nullable: null, optionalNullable: null, array: [undefined, -1.5], tuple: [undefined, null] };

describe('native combinator parity', () => {
  it('preserves both input and output, including exact optional keys', () => {
    expectTypeOf<z.input<typeof dto>>().toEqualTypeOf<z.input<typeof native>>();
    expectTypeOf<z.output<typeof dto>>().toEqualTypeOf<z.output<typeof native>>();
    expectTypeOf<dtozod.input<typeof dto>>().toEqualTypeOf<z.input<typeof native>>();
    expectTypeOf<dtozod.output<typeof dto>>().toEqualTypeOf<z.output<typeof native>>();
  });

  it.each([
    base,
    { ...base, optional: -5.5 },
    { ...base, optional: undefined, unionOptional: undefined, future: 'extension' },
    { ...base, absent: undefined },
    { ...base, absent: 1 },
    { ...base, nullable: undefined },
    { ...base, defaultExact: undefined },
    { ...base, exactDefault: undefined },
    { ...base, array: [NaN] },
    { ...base, tuple: [1, null, 'extra'] },
  ])('matches native parsing for %j', input => {
    const parsed = dto.safeParse(input);
    const reference = native.safeParse(input);
    expect(parsed.success).toBe(reference.success);
    if (parsed.success && reference.success) {
      expect(parsed.data).toEqual(reference.data);
      expect(Object.keys(parsed.data)).toEqual(Object.keys(reference.data));
    } else if (!parsed.success && !reference.success) {
      expect(parsed.error.issues).toEqual(reference.error.issues);
    }
  });
});
