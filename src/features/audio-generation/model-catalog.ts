import type { ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

// Reuse the original catalog's explicit-action download path. Rounded sizes were
// reviewed 2026-09-24 in these repositories; they are NOT artifact identities.
// Companions are mandatory for TTS. Memory tiers are only editorial hints and the
// audio page hides that filter rather than suggesting a per-model runtime limit.
export const audioModelCatalog: readonly ModelSuggestion[] = [
  {
    id: 'audio-qwen3-tts-0-6b', name: 'Qwen3-TTS 0.6B Base', developer: 'Qwen · mradermacher', companion: 'required',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 361_000_000, approximateMultimodalBytes: 401_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
      { id: 'q8_0', repository: 'mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 646_000_000, approximateMultimodalBytes: 401_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
    ],
  },
  {
    id: 'audio-qwen3-tts-1-7b', name: 'Qwen3-TTS 1.7B Base', developer: 'Qwen · ggml-org', companion: 'required',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 1_040_000_000, approximateMultimodalBytes: 446_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
      { id: 'q8_0', repository: 'ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 1_850_000_000, approximateMultimodalBytes: 446_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 8 },
    ],
  },
];
export const TEST_ONLY = {
};
