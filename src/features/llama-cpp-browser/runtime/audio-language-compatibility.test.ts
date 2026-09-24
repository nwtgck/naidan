import { describe, expect, it } from 'vitest';
import { audioGenerationInputSchema, audioLanguageSchema, defaultAudioParameters } from '@/features/audio-generation/types';
import { workerAudioCallSchema } from '@/features/llama-cpp-browser/worker/types';

// Contract tests replace downstream schema-capability negotiation. Accepting a
// legacy artifact's extra exports must not bring back unsupported input modes.
describe('upstream-only audio language contract', () => {
  it.each(audioLanguageSchema.options)('accepts the upstream language choice %s', language => {
    const input = { ...defaultAudioParameters(), model: 'user/voice', text: 'Hello', debug: 'off', language, options: { profile: 'cpu-wasm32' } };
    expect(audioGenerationInputSchema.safeParse(input).success).toBe(true);
    expect(workerAudioCallSchema.safeParse({ ...input, generationId: 1 }).success).toBe(true);
  });
  it.each(['auto', 'Auto', 'automatic', '', undefined, null, {}])('rejects rather than guesses retired or malformed language %j', language => {
    const input = { ...defaultAudioParameters(), model: 'user/voice', text: 'Hello', debug: 'off', language, options: { profile: 'cpu-wasm32' } };
    expect(audioLanguageSchema.safeParse(language).success).toBe(false);
    expect(audioGenerationInputSchema.safeParse(input).success).toBe(false);
    expect(workerAudioCallSchema.safeParse({ ...input, generationId: 1 }).success).toBe(false);
  });
});
