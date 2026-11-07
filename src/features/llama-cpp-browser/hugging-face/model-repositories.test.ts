import { describe, expect, it } from 'vitest';
import { getHfRepository, hfRepositories } from './model-repositories';
import { modelSuggestions, preferredQuantizationHint } from './model-suggestions';

describe('shared Hugging Face repositories', () => {
  it('keeps unique repositories in case-insensitive name order', () => {
    const names = hfRepositories.map(entry => entry.hfRepository.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    for (const entry of hfRepositories) {
      expect(entry.hfRepository).toMatch(/^[^/:]+\/[^/:]+$/);
    }
  });

  it('includes the requested Gemma 4 and LFM3 repositories in the published catalog', () => {
    for (const hfRepository of [
      'google/gemma-4-12B-it-qat-q4_0-gguf',
      'LiquidAI/LFM3-1.7B-GGUF',
      'LiquidAI/LFM3-VL-2B-GGUF',
    ] as const) {
      expect(getHfRepository({ hfRepository })).toEqual({ hfRepository });
    }
  });

  it('keeps the recommendation order independent of repository name order', () => {
    expect(modelSuggestions.map(suggestion => suggestion.id)).toEqual([
      'gemma-4-e2b',
      'gemma-4-e4b',
      'gemma-4-26b',
      'gpt-oss-20b',
      'qwen-3-5-9b',
      'qwen-3-6-35b',
      'qwen-3-8-27b',
      'qwen-3-8-flash-next',
      'lfm-2-5-230m',
      'lfm-2-5-2-6b',
      'muse-glimmer-30b',
      'smollm2-135m',
    ]);
    const names = new Set<string>(hfRepositories.map(entry => entry.hfRepository));
    for (const suggestion of modelSuggestions) {
      for (const choice of suggestion.quantizationHints) {
        expect(names.has(choice.hfRepository)).toBe(true);
      }
    }
  });

  it('includes every currently preferred launch without restricting the registry to recommendations', () => {
    for (const suggestion of modelSuggestions) {
      const choice = preferredQuantizationHint({ suggestion });
      const entry = hfRepositories.find(entry => entry.hfRepository === choice.hfRepository);
      expect(entry?.hfRepository).toBe(choice.hfRepository);
    }
    expect(getHfRepository({ hfRepository: 'lmstudio-community/gemma-4-E2B-it-GGUF' })).toMatchObject({
      hfRepository: 'lmstudio-community/gemma-4-E2B-it-GGUF',
    });
  });
});
