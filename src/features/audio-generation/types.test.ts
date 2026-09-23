import { describe, expect, it } from 'vitest';
import { audioGenerationInputSchema, audioGenerationResultSchema, defaultAudioParameters, MAX_REFERENCE_BYTES } from './types';
import { workerAudioCallSchema } from '@/features/llama-cpp-browser/worker/types';
import { audioResult } from './test-utils/wav';

function input() {
  return { ...defaultAudioParameters(), model: 'user/voice', text: 'こんにちは', reference: undefined, debug: 'off', options: { profile: 'auto' } };
}
describe('audio request boundaries', () => {
  it('accepts explicit defaults without borrowing chat request fields', () => {
    expect(audioGenerationInputSchema.parse(input()).contextTokens).toBe(4096);
    expect(audioGenerationInputSchema.safeParse({ ...input(), messages: [] }).success).toBe(false);
  });
  it.each(['', '  \n\t', 'a\0b', 'x'.repeat(8193)])('rejects invalid text', text => {
    expect(audioGenerationInputSchema.safeParse({ ...input(), text }).success).toBe(false);
  });
  it.each([
    { model: '../../voice' }, { maxFrames: 0 }, { maxFrames: 2049 }, { contextTokens: 0 },
    { contextTokens: 2147483648 }, { temperature: NaN }, { topP: 0 }, { topK: 0 }, { seed: -1 },
    { seed: 4294967296 }, { language: 'xx' }, { audioBackend: 'cuda' },
  ])('rejects invalid or unsupported parameters: %o', change => {
    expect(audioGenerationInputSchema.safeParse({ ...input(), ...change }).success).toBe(false);
  });
  it.each([8193, 16384, 32768])('accepts a requested context of %i and leaves the actual model cap to the worker', contextTokens => {
    expect(audioGenerationInputSchema.parse({ ...input(), contextTokens }).contextTokens).toBe(contextTokens);
  });
  it('accepts model-native automatic language as an explicit request', () => {
    expect(audioGenerationInputSchema.parse({ ...input(), language: 'auto' }).language).toBe('auto');
  });
  it('checks reference byte limits before crossing the worker boundary', () => {
    expect(audioGenerationInputSchema.safeParse({ ...input(), reference: new Blob([]) }).success).toBe(false);
    expect(audioGenerationInputSchema.safeParse({ ...input(), reference: new Blob([new Uint8Array(MAX_REFERENCE_BYTES + 1)]) }).success).toBe(false);
    expect(audioGenerationInputSchema.safeParse({ ...input(), reference: new Blob(['valid size; codec validation is native']) }).success).toBe(true);
  });
  it('requires a concrete profile and a bounded generation ID for the RPC', () => {
    const request = { ...input(), options: { profile: 'cpu-wasm32' }, generationId: 1 };
    expect(workerAudioCallSchema.safeParse(request).success).toBe(true);
    expect(workerAudioCallSchema.safeParse({ ...request, options: { profile: 'auto' } }).success).toBe(false);
    expect(workerAudioCallSchema.safeParse({ ...request, generationId: 0 }).success).toBe(false);
  });
  it('bounds the output metadata and refuses foreign result objects', () => {
    const result = audioResult(); expect(audioGenerationResultSchema.parse(result)).toEqual(result);
    expect(audioGenerationResultSchema.safeParse({ ...result, samples: Infinity }).success).toBe(false);
    expect(audioGenerationResultSchema.safeParse({ ...result, wav: [] }).success).toBe(false);
    expect(audioGenerationResultSchema.safeParse({ ...result, finishReason: 'length' }).success).toBe(false);
  });
});
