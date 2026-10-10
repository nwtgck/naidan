import { describe, expect, it } from 'vitest';
import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
import { optionalExperimentalFieldSchemaDto } from './experimental-field';
import { EndpointSchemaDto } from '@/00-storage/00-dto/dto';

const schema = optionalExperimentalFieldSchemaDto({
  schema: resolveMissingAsUndefined(dtozod.object({
    known: missingAsUndefined(dtozod.number()),
  })),
});

describe('intentional experimental field recovery', () => {
  it('keeps absent fields absent and isolates unreadable known and future fields', () => {
    expect(schema.parse(undefined)).toBeUndefined();
    const parsed = schema.parse({ known: 'not-a-number', future: 3 })!;
    expect(Object.hasOwn(parsed, 'known')).toBe(true);
    expect(parsed.known).toBeUndefined();
    expect(parsed.unreadable).toEqual({ known: 'not-a-number', future: 3 });
    expect(Object.getOwnPropertyDescriptor(parsed, 'unreadable')).toMatchObject({ enumerable: false, writable: false });
    expect(JSON.stringify(parsed)).toBe('{}');
    expect(schema.parse({ known: -1.5 })?.known).toBe(-1.5);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('isolates the unrecognized own key %s without reading object-prototype members as schemas', key => {
    const raw = JSON.parse(JSON.stringify({ known: 3, [key]: { marker: true } }));
    const parsed = schema.parse(raw)!;
    expect(parsed.known).toBe(3);
    expect(Object.hasOwn(parsed.unreadable!, key)).toBe(true);
    expect(parsed.unreadable?.[key]).toEqual({ marker: true });
    expect(Object.prototype).not.toHaveProperty('marker');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it.each([
    { known: 'future', future: { preserved: true } },
    'future-root',
    ['future-array'],
    { known: undefined, future: false },
  ])('preserves nested unreadable evidence while parsing the enclosing object: %j', input => {
    const outer = optionalExperimentalFieldSchemaDto({
      schema: resolveMissingAsUndefined(dtozod.object({
        nested: missingAsUndefined(schema),
        readable: missingAsUndefined(dtozod.string()),
      })),
    });
    const expected = schema.parse(input)!;
    const raw = { nested: input, readable: 'kept' };
    const before = JSON.stringify(raw);
    const actual = outer.parse(raw)!;
    expect(actual.readable).toBe('kept');
    expect(actual.nested).toEqual(expected);
    expect(actual.nested?.unreadable).toEqual(expected.unreadable);
    expect(Object.getOwnPropertyDescriptor(actual.nested!, 'unreadable')).toMatchObject({ enumerable: false, writable: false });
    expect(JSON.stringify(actual.nested)).not.toContain('unreadable');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('preserves unknown endpoint identity inside a recovered group', () => {
    const outer = optionalExperimentalFieldSchemaDto({
      schema: resolveMissingAsUndefined(dtozod.object({ endpoint: missingAsUndefined(EndpointSchemaDto) })),
    });
    const endpoint = { type: 'experimental_type', experimental: { endpoint: { type: 'future_remote', ref: 'id' } } };
    const parsed = outer.parse({ endpoint })!;
    if (parsed.endpoint?.type !== 'experimental_type') throw new Error('Expected the experimental endpoint envelope');
    expect(parsed.endpoint.experimental?.endpoint).toBeUndefined();
    expect(parsed.endpoint.experimental?.unreadable).toEqual({ endpoint: { type: 'future_remote', ref: 'id' } });
  });

  it('preserves recovery metadata through arrays and multiple nested compatibility groups', () => {
    const middle = optionalExperimentalFieldSchemaDto({
      schema: resolveMissingAsUndefined(dtozod.object({ nested: missingAsUndefined(schema) })),
    });
    const outer = optionalExperimentalFieldSchemaDto({
      schema: resolveMissingAsUndefined(dtozod.object({ items: missingAsUndefined(dtozod.array(middle)) })),
    });
    const dangerous = JSON.parse('{"known":3,"__proto__":{"marker":true},"unreadable":{"forged":true}}');
    const parsed = outer.parse({ items: [{ nested: dangerous }, { nested: null }] });
    const first = parsed?.items?.[0]?.nested;
    expect(first?.known).toBe(3);
    expect(first?.unreadable).toEqual({ ['__proto__']: { marker: true }, unreadable: { forged: true } });
    expect(Object.hasOwn(first!.unreadable!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(first!)).toBe(Object.prototype);
    expect(parsed?.items?.[1]?.nested?.unreadable).toEqual({ _root: null });
    expect(Object.prototype).not.toHaveProperty('marker');
  });
});
