import { expect, it } from 'vitest';
import { assertBf16ConversionFitsMemory, bf16ConversionMemory } from './bf16-conversion-memory';

const elements = 151936n * 5120n;

it('computes the H3 embedding read/conversion lower bound exactly for the selected precision', () => {
  expect(bf16ConversionMemory({ elements, target: 'f32' })).toEqual({ sourceBytes: 1555824640n, destinationBytes: 3111649280n, simultaneousBytes: 4667473920n });
  expect(bf16ConversionMemory({ elements, target: 'f16' })).toEqual({ sourceBytes: 1555824640n, destinationBytes: 1555824640n, simultaneousBytes: 3111649280n });
});

it('rejects the required F32 embedding conversion against the Wasm32 cap without using file size or host RAM', () => {
  expect(() => assertBf16ConversionFitsMemory({ tensorName: 'model.embed_tokens.weight', elements, target: 'f32', maximumMemoryBytes: 2n ** 32n })).toThrow('source read buffer (1555824640 bytes) and destination (3111649280 bytes) require at least 4667473920 bytes together');
  expect(() => assertBf16ConversionFitsMemory({ tensorName: 'model.embed_tokens.weight', elements, target: 'f32', maximumMemoryBytes: 2n ** 32n })).toThrow('Wasm memory cap of 4294967296 bytes');
  expect(() => assertBf16ConversionFitsMemory({ tensorName: 'model.embed_tokens.weight', elements, target: 'f16', maximumMemoryBytes: 2n ** 32n })).not.toThrow();
  expect(() => assertBf16ConversionFitsMemory({ tensorName: 'model.embed_tokens.weight', elements, target: 'f32', maximumMemoryBytes: 16n * 1024n ** 3n })).not.toThrow();
});

it('treats the cap as an exact boundary and does not lose precision above the JavaScript integer range', () => {
  const large = 2n ** 53n + 1n;
  const { simultaneousBytes } = bf16ConversionMemory({ elements: large, target: 'f32' });
  expect(simultaneousBytes).toBe(54043195528445958n);
  expect(() => assertBf16ConversionFitsMemory({ tensorName: 'required.weight', elements: large, target: 'f32', maximumMemoryBytes: simultaneousBytes })).not.toThrow();
  expect(() => assertBf16ConversionFitsMemory({ tensorName: 'required.weight', elements: large, target: 'f32', maximumMemoryBytes: simultaneousBytes - 1n })).toThrow('cannot be converted');
});

export const TEST_ONLY = {
};
