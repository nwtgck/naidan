import type { ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

// Official LiquidAI repositories. Rounded byte counts are presentation hints,
// not artifact identities or memory guarantees. Reuse the audio page's explicit
// download flow: resolve a pinned model + mandatory companion only on request.
export const liveModelCatalog: readonly ModelSuggestion[] = [
  {
    id: 'live-lfm3-audio-2b',
    name: 'LFM3-Audio-2B',
    developer: 'Liquid AI',
    companion: 'required',
    quantizationHints: [
      { id: 'q4_k_m', hfRepository: 'LiquidAI/LFM3-Audio-2B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 1_100_000_000, approximateMultimodalBytes: 338_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
      { id: 'q8_0', hfRepository: 'LiquidAI/LFM3-Audio-2B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 1_900_000_000, approximateMultimodalBytes: 338_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
    ],
  },
  {
    id: 'live-lfm3-omni-2b',
    name: 'LFM3-Omni-2B',
    developer: 'Liquid AI',
    companion: 'required',
    quantizationHints: [
      { id: 'q4_k_m', hfRepository: 'LiquidAI/LFM3-Omni-2B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 1_100_000_000, approximateMultimodalBytes: 541_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
      { id: 'q8_0', hfRepository: 'LiquidAI/LFM3-Omni-2B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 1_900_000_000, approximateMultimodalBytes: 541_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
    ],
  },
];

export const TEST_ONLY = {
};
