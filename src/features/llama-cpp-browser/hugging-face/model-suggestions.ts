/**
 * Bundled suggestions, NOT a mirror of a Hugging Face repository.
 *
 * Rendering/filtering these hints MUST NOT inspect repositories. Naidan permits
 * external access only after an explicit preview/download action (or the
 * separately documented llama-cpp-browser-model URL request). No model avatars,
 * remote fonts, preconnect, prefetch or background metadata refresh belong here.
 *
 * Approximate byte counts are rounded decimal source sizes, not GiB values.
 * They may drift as upstream files change. Identity never depends on size,
 * memory hints or a guessed filename; downloads use a resolved, pinned plan.
 * Memory tiers are editorial starting points, not runtime/VRAM guarantees.
 * Context length, browser backend and multimodal inputs affect actual usage.
 */
export type ModelSuggestion = {
  id: string,
  name: string,
  developer: string,
  repository: string,
  preferredQuantization: string,
  approximateModelBytes: number,
  approximateMultimodalBytes: number | undefined,
  suggestedMemoryGiB: number,
  suggestedMultimodalMemoryGiB: number | undefined,
};

// Array order intentionally keeps developers adjacent; no group model is needed.
// Source links are the repositories below (file lists reviewed 2026-09-22).
export const modelSuggestions: readonly ModelSuggestion[] = [
  // Prefer Google's Quantization-Aware Training (QAT) releases over generic
  // post-training Q4_K_M conversions. QAT describes the checkpoint's training,
  // not a GGUF quantization token: keep the file matcher at Q4_0 and show QAT
  // in the display name. Memory tiers remain conservative, independent of size.
  { id: 'gemma-4-e2b', name: 'Gemma 4 E2B it (QAT)', developer: 'Google', repository: 'google/gemma-4-E2B-it-qat-q4_0-gguf', preferredQuantization: 'Q4_0', approximateModelBytes: 3_350_000_000, approximateMultimodalBytes: 987_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 16 },
  { id: 'gemma-4-e4b', name: 'Gemma 4 E4B it (QAT)', developer: 'Google', repository: 'google/gemma-4-E4B-it-qat-q4_0-gguf', preferredQuantization: 'Q4_0', approximateModelBytes: 5_150_000_000, approximateMultimodalBytes: 992_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
  { id: 'gemma-4-26b', name: 'Gemma 4 26B-A4B it (QAT)', developer: 'Google', repository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf', preferredQuantization: 'Q4_0', approximateModelBytes: 14_400_000_000, approximateMultimodalBytes: 1_190_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
  { id: 'gpt-oss-20b', name: 'gpt-oss-20b', developer: 'OpenAI', repository: 'ggml-org/gpt-oss-20b-GGUF', preferredQuantization: 'MXFP4', approximateModelBytes: 12_100_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: undefined },
  { id: 'qwen-3-5-9b', name: 'Qwen3.5 9B', developer: 'Qwen', repository: 'lmstudio-community/Qwen3.5-9B-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 5_630_000_000, approximateMultimodalBytes: 922_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
  { id: 'qwen-3-6-35b', name: 'Qwen3.6 35B-A3B', developer: 'Qwen', repository: 'ggml-org/Qwen3.6-35B-A3B-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 20_400_000_000, approximateMultimodalBytes: 614_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
  { id: 'qwen-3-8-27b', name: 'Qwen3.8 27B', developer: 'Qwen', repository: 'ggml-org/Qwen3.8-27B-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 19_000_000_000, approximateMultimodalBytes: 629_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
  { id: 'lfm-2-5-230m', name: 'LFM2.5 230M', developer: 'Liquid AI', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 153_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
  { id: 'lfm-2-5-2-6b', name: 'LFM2.5 2.6B', developer: 'Liquid AI', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 1_670_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
  { id: 'muse-glimmer-30b', name: 'Muse-Glimmer 30B', developer: 'Meta', repository: 'meta-models/Muse-Glimmer-30B-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 16_800_000_000, approximateMultimodalBytes: 1_400_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
  { id: 'smollm2-135m', name: 'SmolLM2 135M Instruct', developer: 'Hugging Face', repository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', preferredQuantization: 'Q4_K_M', approximateModelBytes: 105_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
];
export type MultimodalDownload = 'off' | 'on';
export type SuggestedMemoryFilter = 'all' | 8 | 16 | 32;
export const suggestedMemoryFilters: readonly SuggestedMemoryFilter[] = ['all', 8, 16, 32];
export const moreGgufModelsUrl = 'https://huggingface.co/models?library=gguf';

export function matchesMemoryHint({ suggestion, memory, multimodal }: { suggestion: ModelSuggestion, memory: SuggestedMemoryFilter, multimodal: MultimodalDownload }): boolean {
  let required: number;
  switch (multimodal) {
  case 'off': required = suggestion.suggestedMemoryGiB; break;
  case 'on': required = suggestion.suggestedMultimodalMemoryGiB ?? suggestion.suggestedMemoryGiB; break;
  default: { const exhaustive: never = multimodal; throw new Error(String(exhaustive)); }
  }
  return memory === 'all' || required <= memory;
}

export const TEST_ONLY = {
};
