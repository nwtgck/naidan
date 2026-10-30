import { describe, expect, it } from 'vitest';
import { liveModelCatalog } from './model-catalog';
import { preferredQuantizationHint } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

describe('explicit live conversation model catalog', () => {
  it('uses official Audio and Omni repositories with mandatory companions', () => {
    expect(liveModelCatalog.map(model => model.name)).toEqual(['LFM3-Audio-2B', 'LFM3-Omni-2B']);
    for (const suggestion of liveModelCatalog) {
      expect(suggestion.companion).toBe('required');
      expect(preferredQuantizationHint({ suggestion }).preferredQuantization).toBe('Q4_K_M');
      for (const hint of suggestion.quantizationHints) {
        expect(hint.hfRepository).toBe(`LiquidAI/${suggestion.name}-GGUF`);
        expect(hint.approximateMultimodalBytes).toBeGreaterThan(0);
      }
    }
  });
});
