import type { ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

// Published Liquid AI companion filenames and rounded byte counts for the
// offline catalog. Resolve the selected files against one revision on download.
const audioCompanions = [
  { path: 'mmproj-LFM3-Audio-2B-Q4_K_M.gguf', size: 172_000_000 },
  { path: 'mmproj-LFM3-Audio-2B-Q8_0.gguf', size: 304_000_000 },
  { path: 'mmproj-LFM3-Audio-2B-BF16.gguf', size: 571_000_000 },
] as const;
const omniCompanions = [
  { path: 'mmproj-LFM3-Omni-2B-Q4_K_M.gguf', size: 292_000_000 },
  { path: 'mmproj-LFM3-Omni-2B-Q8_0.gguf', size: 507_000_000 },
  { path: 'mmproj-LFM3-Omni-2B-BF16.gguf', size: 950_000_000 },
] as const;

export const liveModelCatalog: readonly [ModelSuggestion, ...ModelSuggestion[]] = [
  {
    id: 'live-lfm3-audio-2b',
    name: 'LFM3-Audio-2B',
    developer: 'Liquid AI',
    companion: 'required',
    quantizationHints: [
      { id: 'q4_k_m', hfRepository: 'LiquidAI/LFM3-Audio-2B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 1_100_000_000, approximateMultimodalBytes: 304_000_000, companionFiles: audioCompanions, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
      { id: 'q8_0', hfRepository: 'LiquidAI/LFM3-Audio-2B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 1_850_000_000, approximateMultimodalBytes: 304_000_000, companionFiles: audioCompanions, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
    ],
  },
  {
    id: 'live-lfm3-omni-2b',
    name: 'LFM3-Omni-2B',
    developer: 'Liquid AI',
    companion: 'required',
    quantizationHints: [
      { id: 'q4_k_m', hfRepository: 'LiquidAI/LFM3-Omni-2B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 1_100_000_000, approximateMultimodalBytes: 507_000_000, companionFiles: omniCompanions, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
      { id: 'q8_0', hfRepository: 'LiquidAI/LFM3-Omni-2B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 1_850_000_000, approximateMultimodalBytes: 507_000_000, companionFiles: omniCompanions, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
    ],
  },
];

export const TEST_ONLY = {
};
