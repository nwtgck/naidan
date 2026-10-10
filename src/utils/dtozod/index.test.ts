import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as dtozod from '@/utils/dtozod';

describe('DTO-only native Zod aliases', () => {
  it('uses the original factory functions and exposes no top-level escape hatch', () => {
    expect(dtozod.object).toBe(z.object);
    expect(dtozod.string).toBe(z.string);
    expect(dtozod.number).toBe(z.number);
    expect(dtozod.boolean).toBe(z.boolean);
    expect(dtozod.enum).toBe(z.enum);
    expect(dtozod.literal).toBe(z.literal);
    expect(dtozod.undefined).toBe(z.undefined);
    expect(dtozod.unknown).toBe(z.unknown);
    expect(dtozod.never).toBe(z.never);
    expect(dtozod.array).toBe(z.array);
    expect(dtozod.union).toBe(z.union);
    expect(dtozod.discriminatedUnion).toBe(z.discriminatedUnion);
    expect(dtozod.tuple).toBe(z.tuple);
    expect(dtozod.record).toBe(z.record);
    expect(Object.keys(dtozod).sort()).toEqual([
      'TEST_ONLY', 'array', 'boolean', 'discriminatedUnion', 'enum', 'literal',
      'never', 'number', 'object', 'record', 'string', 'tuple', 'undefined', 'union', 'unknown',
    ].sort());
    // The runtime object is native: this is deliberately NOT runtime isolation.
    expect(Reflect.get(dtozod.string(), 'refine')).toBeTypeOf('function');
  });

  it('exposes only the explicit schema and object method allowlists', () => {
    const leaf = dtozod.string();
    const object = dtozod.object({ name: leaf });
    type SchemaKeys = '_zod' | 'parse' | 'safeParse' | 'optional' | 'exactOptional' | 'nullable' | 'array' | 'default';
    expectTypeOf<Extract<keyof typeof leaf, string>>().toEqualTypeOf<SchemaKeys>();
    expectTypeOf<Extract<keyof typeof object, string>>().toEqualTypeOf<SchemaKeys | 'shape' | 'extend' | 'safeExtend' | 'pick' | 'omit'>();
    const array = object.array();
    const union = dtozod.union([object]);
    expectTypeOf<Extract<keyof typeof array, string>>().toEqualTypeOf<SchemaKeys | 'element'>();
    expectTypeOf<Extract<keyof typeof union, string>>().toEqualTypeOf<SchemaKeys | 'options'>();
  });

  it('keeps structural output/input inference and strips future fields on downgrade', () => {
    const schema = dtozod.object({
      name: dtozod.string(),
      count: dtozod.number().optional().default(0),
      role: dtozod.enum(['user', 'assistant']),
    });
    expectTypeOf<dtozod.output<typeof schema>>().toEqualTypeOf<{
      name: string, count: number, role: 'user' | 'assistant',
    }>();
    expectTypeOf<dtozod.input<typeof schema>>().toEqualTypeOf<{
      name: string, count?: number | undefined, role: 'user' | 'assistant',
    }>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<dtozod.infer<typeof schema>>();
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<dtozod.input<typeof schema>>();
    const loaded = schema.parse({ name: '', role: 'user', future: { arbitrary: true } });
    expect(loaded).toEqual({ name: '', count: 0, role: 'user' });
    expect(schema.parse(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded);
    expect(schema.safeParse({ name: 123, role: 'user' }).success).toBe(false);
    expect(schema.safeParse({ name: '', role: 'future' }).success).toBe(false);
  });

  it('matches native optionality, defaults, record, tuple and selection semantics', () => {
    const optional = dtozod.object({ field: dtozod.string().nullable().optional() });
    const nativeOptional = z.object({ field: z.string().nullable().optional() });
    expectTypeOf<z.output<typeof optional>>().toEqualTypeOf<z.output<typeof nativeOptional>>();
    expectTypeOf<z.input<typeof optional>>().toEqualTypeOf<z.input<typeof nativeOptional>>();
    const tuple = dtozod.tuple([dtozod.string(), dtozod.number().optional()]);
    const nativeTuple = z.tuple([z.string(), z.number().optional()]);
    expectTypeOf<z.output<typeof tuple>>().toEqualTypeOf<z.output<typeof nativeTuple>>();
    expectTypeOf<z.input<typeof tuple>>().toEqualTypeOf<z.input<typeof nativeTuple>>();
    const record = dtozod.record(dtozod.enum(['x', 'y']), dtozod.number().default(0));
    const nativeRecord = z.record(z.enum(['x', 'y']), z.number().default(0));
    expectTypeOf<z.output<typeof record>>().toEqualTypeOf<z.output<typeof nativeRecord>>();
    expectTypeOf<z.input<typeof record>>().toEqualTypeOf<z.input<typeof nativeRecord>>();
    for (const value of [{}, { x: 3 }, { x: 2, y: 4 }, { x: 'bad' }]) {
      expect(record.safeParse(value).success).toBe(nativeRecord.safeParse(value).success);
    }
    const object = dtozod.object({ x: dtozod.string(), y: dtozod.number() });
    const selected = object.pick({ x: true });
    const omitted = object.omit({ y: true });
    expectTypeOf<z.output<typeof selected>>().toEqualTypeOf<{ x: string }>();
    expectTypeOf<z.output<typeof omitted>>().toEqualTypeOf<{ x: string }>();
    expect(selected.parse({ x: 'kept', y: 2 })).toEqual({ x: 'kept' });
    expect(omitted.parse({ x: 'kept', y: 2 })).toEqual({ x: 'kept' });
    const narrowed = object.safeExtend({ x: dtozod.literal('specific') });
    expectTypeOf<z.output<typeof narrowed>>().toEqualTypeOf<{ x: 'specific', y: number }>();
  });

  it('keeps missing versus explicitly undefined keys distinct', () => {
    const schema = dtozod.object({ parts: dtozod.never().exactOptional(), text: dtozod.string() });
    expect(schema.parse({ text: 'legacy' })).toEqual({ text: 'legacy' });
    expect(schema.safeParse({ text: 'legacy', parts: undefined }).success).toBe(false);
    expect(schema.safeParse({ text: 'legacy', parts: [] }).success).toBe(false);
    const fallback = dtozod.number().optional().default(() => 42);
    expectTypeOf<z.output<typeof fallback>>().toEqualTypeOf<number>();
    expect(fallback.parse(undefined)).toBe(42);
    expect(dtozod.object({ value: dtozod.unknown() }).safeParse({}).success).toBe(false);
    expect(dtozod.object({ value: dtozod.unknown() }).parse({ value: undefined })).toEqual({ value: undefined });
  });

  it('retains native union, array and discriminated-union output types', () => {
    const first = dtozod.object({ kind: dtozod.literal('a'), name: dtozod.string() });
    const second = dtozod.object({ kind: dtozod.literal('b'), count: dtozod.number() });
    const union = dtozod.union([first, second]);
    const discriminated = dtozod.discriminatedUnion('kind', [first, second]);
    expectTypeOf<z.output<typeof discriminated>>().toEqualTypeOf<z.output<typeof union>>();
    expectTypeOf<z.output<ReturnType<typeof union.array>>>().toEqualTypeOf<z.output<typeof union>[]>();
    expect(discriminated.parse({ kind: 'b', count: -1.5, future: 3 })).toEqual({ kind: 'b', count: -1.5 });
    expect(union.options[0]).toBe(first);
    expect(dtozod.array(first).element).toBe(first);
  });

  it('rejects forbidden chains and native-schema injection at compile time', () => {
    // Compile-only adversarial examples: never call this function at runtime.
    const forbidden = () => {
      const schema = dtozod.object({ name: dtozod.string() });
      // @ts-expect-error No domain refinement.
      schema.refine(() => true);
      // @ts-expect-error No cross-field refinement.
      schema.superRefine(() => {});
      // @ts-expect-error No check escape hatch.
      schema.check(() => {});
      // @ts-expect-error No strict downgrade rejection.
      schema.strict();
      // @ts-expect-error No unknown-key behavior switches.
      schema.catchall(dtozod.unknown());
      // @ts-expect-error No raw schema access.
      schema.unwrap();
      // @ts-expect-error No internal executable slots.
      void schema._zod.def;
      // @ts-expect-error No runtime metadata mutations.
      schema._zod = {};
      // @ts-expect-error Structural accessors also return restricted types.
      schema.shape.name.min(1);
      // @ts-expect-error Composition cannot reintroduce native methods.
      schema.optional().refine(() => true);
      // @ts-expect-error No domain-specific numeric restrictions.
      dtozod.number().int();
      // @ts-expect-error No arbitrary transforms.
      dtozod.string().transform(value => value);
      // @ts-expect-error No top-level strict construction.
      dtozod.strictObject({});
      // @ts-expect-error No unrestricted factories.
      dtozod.custom();
      // @ts-expect-error No unsafe any output.
      dtozod.any();
      // @ts-expect-error No general native-schema adapter.
      dtozod.fromZod(z.string());
      // @ts-expect-error Do not claim an undefined result is a number.
      dtozod.number().optional().default(undefined);
      // @ts-expect-error Do not accept an undefined default callback result.
      dtozod.number().optional().default(() => undefined);
      // @ts-expect-error The string factory may not assert an arbitrary subtype.
      dtozod.string<'admin'>();
      // @ts-expect-error Native Zod must not enter a DTO object.
      dtozod.object({ name: z.string().min(1) });
      // @ts-expect-error Native array elements are not DTO schemas.
      dtozod.array(z.string());
      // @ts-expect-error Native union members are not DTO schemas.
      dtozod.union([dtozod.string(), z.number()]);
      // @ts-expect-error Native tuple elements are not DTO schemas.
      dtozod.tuple([z.string()]);
      // @ts-expect-error Native record values are not DTO schemas.
      dtozod.record(dtozod.string(), z.string());
      // @ts-expect-error Native record keys are not DTO schemas.
      dtozod.record(z.string(), dtozod.string());
      // @ts-expect-error Record keys must be property keys.
      dtozod.record(dtozod.boolean(), dtozod.string());
      // @ts-expect-error No native schemas through extend.
      schema.extend({ name: z.string() });
      // @ts-expect-error Safe extension must not import native schema constraints.
      schema.safeExtend({ name: z.string().min(1) });
      // @ts-expect-error Safe extension cannot change the field's type.
      schema.safeExtend({ name: dtozod.number() });
      // @ts-expect-error Selection cannot introduce undeclared keys.
      schema.pick({ missing: true });
      // @ts-expect-error Omission cannot refer to undeclared keys.
      schema.omit({ missing: true });
      // @ts-expect-error Array elements must remain restricted.
      schema.array().element.transform(() => 0);
      // @ts-expect-error Union options must remain restricted.
      dtozod.union([schema]).options[0].strict();
      // @ts-expect-error Discriminated unions require discriminable members.
      dtozod.discriminatedUnion('kind', [dtozod.string()]);
      // @ts-expect-error Discriminators must exist in the member's shape.
      dtozod.discriminatedUnion('missing', [dtozod.object({ kind: dtozod.literal('a') })]);
    };
    expect(forbidden).toBeTypeOf('function');
  });
});
