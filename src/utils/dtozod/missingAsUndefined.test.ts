import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from './missingAsUndefined';
import { missingAsUndefined as nativeMissing, resolveMissingAsUndefined as nativeResolve } from '@/utils/zod/missingAsUndefined';

describe('DTO missing-as-undefined compatibility', () => {
  it('aliases the existing runtime helpers with restricted return types', () => {
    expect(missingAsUndefined).toBe(nativeMissing);
    expect(resolveMissingAsUndefined).toBe(nativeResolve);
    const schema = resolveMissingAsUndefined(dtozod.object({
      name: missingAsUndefined(dtozod.string()),
      nested: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({ count: missingAsUndefined(dtozod.number()) }))),
    }));
    const native = nativeResolve(z.object({
      name: nativeMissing(z.string()),
      nested: nativeMissing(nativeResolve(z.object({ count: nativeMissing(z.number()) }))),
    }));
    expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<z.output<typeof native>>();
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<z.input<typeof native>>();
    expect(schema.parse({})).toEqual({ name: undefined, nested: undefined });
    expect(schema.parse({ nested: {} })).toEqual({ name: undefined, nested: { count: undefined } });
    expect(Object.hasOwn(schema.parse({}), 'name')).toBe(true);
  });

  it('preserves extension checks and the explicit shallow resolver contract', () => {
    const base = resolveMissingAsUndefined(dtozod.object({ name: missingAsUndefined(dtozod.string()) }));
    expect(base.extend({ count: dtozod.number() }).parse({ count: 1 })).toEqual({ name: undefined, count: 1 });
    expect(base.safeExtend({ name: missingAsUndefined(dtozod.literal('x')) }).parse({})).toEqual({ name: undefined });
    expect(() => base.pick({ name: true })).toThrow();
    expect(() => base.omit({ name: true })).toThrow();
    // This is an intentional existing helper contract, not a supported shortcut.
    const unresolved = dtozod.object({ name: missingAsUndefined(dtozod.string()) }).parse({});
    expect(typeof unresolved.name).toBe('symbol');
    const forbidden = () => {
      // @ts-expect-error A compatibility helper must not leak unrestricted Zod.
      base.refine(() => true);
      // @ts-expect-error Native schemas must not enter DTO helpers.
      missingAsUndefined(z.string());
      // @ts-expect-error Resolvers are only for object-output schemas.
      resolveMissingAsUndefined(dtozod.string());
    };
    expect(forbidden).toBeTypeOf('function');
  });
});
