import { describe, expect, it } from 'vitest';
import { inspectModelGraphGguf, readModelGraphArchitecture } from './gguf';
import { metadataGguf } from './gguf-metadata.test-support';

function inspect({ bytes }: { bytes: Uint8Array }) {
  const source = {
    size: bytes.length,
    read: ({ offset, destination }: { offset: number; destination: Uint8Array }) => {
      const count = Math.min(destination.length, bytes.length - offset);
      destination.set(bytes.subarray(offset, offset + count));
      return count;
    },
  };
  return { inspect: () => inspectModelGraphGguf({ source, signal: undefined }), architecture: () => readModelGraphArchitecture({ source, signal: undefined }) };
}

describe('bounded graph metadata arrays', () => {
  it('retains model arrays without duplicating tokenizer payloads', () => {
    const parsed = inspect({
      bytes: metadataGguf({
        items: [
          { key: 'fixture.flags', type: 7, values: [true, false, true] }, { key: 'fixture.limits', type: 6, values: [1.5, 2.5] },
          { key: 'fixture.names', type: 8, values: ['local', 'global'] }, { key: 'fixture.heads', type: 4, values: [8, 16] },
        ],
      }),
    }).inspect();
    expect(parsed.inventory.metadata.get('fixture.flags')).toEqual([true, false, true]);
    expect(parsed.inventory.metadata.get('fixture.limits')).toEqual([1.5, 2.5]);
    expect(parsed.inventory.metadata.get('fixture.names')).toEqual(['local', 'global']);
    expect(parsed.inventory.metadata.get('fixture.heads')).toEqual([8, 16]);
    expect(parsed.inventory.metadata.has('tokenizer.ggml.tokens')).toBe(false);
    expect(parsed.inventory.vocabularySize).toBe(2);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite metadata %s', number => {
    expect(() => inspect({ bytes: metadataGguf({ items: [{ key: 'fixture.invalid', type: 6, values: [number] }] }) }).inspect()).toThrow('Non-finite');
  });

  it('checks array budgets before reading or retaining their element values', () => {
    const fixture = inspect({ bytes: metadataGguf({ items: [{ key: 'fixture.excessive', type: 4, values: [], count: 65537 }] }) });
    expect(fixture.architecture()).toBe('array-fixture'); // Native-only routing does not impose graph array support.
    expect(fixture.inspect).toThrow('budget');
  });

  it('limits aggregate retained array elements across metadata keys', () => {
    const fixture = inspect({
      bytes: metadataGguf({
        items: [
          { key: 'fixture.first', type: 7, values: Array.from({ length: 40000 }, () => true) },
          { key: 'fixture.second', type: 7, values: [], count: 30000 },
        ],
      }),
    });
    expect(fixture.inspect).toThrow('budget');
  });

  it.each([9, 13, 0xffffffff])('rejects empty arrays with invalid element tag %s', type => {
    expect(() => inspect({ bytes: metadataGguf({ items: [{ key: 'fixture.bad', type, values: [] }] }) }).inspect()).toThrow('array type');
  });
});

export const TEST_ONLY = {
};
