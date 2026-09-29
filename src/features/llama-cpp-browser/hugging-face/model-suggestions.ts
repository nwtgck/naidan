/**
 * Bundled suggestions, NOT a mirror of a Hugging Face repository.
 *
 * Rendering/filtering/selecting these hints MUST NOT inspect repositories. Naidan permits
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
export type SuggestedQuantization = {
  // A bundled choice, not a discovered artifact ID. The source is explicit per
  // choice: switching quantizations never guesses or searches for a repository.
  id: string,
  repository: string,
  preferredQuantization: string,
  checkpoint: 'qat' | 'standard',
  approximateModelBytes: number,
  approximateMultimodalBytes: number | undefined,
  suggestedMemoryGiB: number,
  suggestedMultimodalMemoryGiB: number | undefined,
};
export type ModelSuggestion = {
  // Some pipelines require a companion even for text-only inputs (e.g. TTS).
  // Its presence is resolved on an explicit download, never by mounting a row.
  companion?: 'required',
  id: string,
  name: string,
  developer: string,
  quantizationHints: readonly [SuggestedQuantization, ...SuggestedQuantization[]],
};

// Array order intentionally keeps developers adjacent; no group model is needed.
// Sources are the explicit repositories below. Sizes/options are bundled hints,
// reviewed 2026-09-22, NOT promises that current main contains those artifacts.
// Resolve only the selected source after an explicit preview/download action.
export const modelSuggestions: readonly ModelSuggestion[] = [
  // QAT (Quantization-Aware Training) describes the checkpoint, not a GGUF
  // tensor type. Keep the matcher at Q4_0 and label only that choice as QAT.
  // Non-QAT choices explicitly use LM Studio Community; their projectors must
  // come from that same selected repository, never from the Google QAT source.
  {
    id: 'gemma-4-e2b', name: 'Gemma 4 E2B it', developer: 'Google',
    quantizationHints: [
      { id: 'qat-q4_0', repository: 'google/gemma-4-E2B-it-qat-q4_0-gguf', preferredQuantization: 'Q4_0', checkpoint: 'qat', approximateModelBytes: 3_350_000_000, approximateMultimodalBytes: 987_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q4_k_m', repository: 'lmstudio-community/gemma-4-E2B-it-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 3_430_000_000, approximateMultimodalBytes: 987_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q6_k', repository: 'lmstudio-community/gemma-4-E2B-it-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 3_850_000_000, approximateMultimodalBytes: 987_000_000, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q8_0', repository: 'lmstudio-community/gemma-4-E2B-it-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 4_970_000_000, approximateMultimodalBytes: 987_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
    ],
  },
  {
    id: 'gemma-4-e4b', name: 'Gemma 4 E4B it', developer: 'Google',
    quantizationHints: [
      { id: 'qat-q4_0', repository: 'google/gemma-4-E4B-it-qat-q4_0-gguf', preferredQuantization: 'Q4_0', checkpoint: 'qat', approximateModelBytes: 5_150_000_000, approximateMultimodalBytes: 992_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q4_k_m', repository: 'lmstudio-community/gemma-4-E4B-it-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 5_340_000_000, approximateMultimodalBytes: 992_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q6_k', repository: 'lmstudio-community/gemma-4-E4B-it-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 6_220_000_000, approximateMultimodalBytes: 992_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q8_0', repository: 'lmstudio-community/gemma-4-E4B-it-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 8_030_000_000, approximateMultimodalBytes: 992_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
    ],
  },
  {
    id: 'gemma-4-26b', name: 'Gemma 4 26B-A4B it', developer: 'Google',
    quantizationHints: [
      { id: 'qat-q4_0', repository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf', preferredQuantization: 'Q4_0', checkpoint: 'qat', approximateModelBytes: 14_400_000_000, approximateMultimodalBytes: 1_190_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
      { id: 'q4_k_m', repository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 16_800_000_000, approximateMultimodalBytes: 1_190_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
      { id: 'q6_k', repository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 22_600_000_000, approximateMultimodalBytes: 1_190_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
      { id: 'q8_0', repository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 26_900_000_000, approximateMultimodalBytes: 1_190_000_000, suggestedMemoryGiB: 64, suggestedMultimodalMemoryGiB: 64 },
    ],
  },
  // The Q8_0/BF16 files here are auxiliary drafter weights, not main choices.
  {
    id: 'gpt-oss-20b', name: 'gpt-oss-20b', developer: 'OpenAI',
    quantizationHints: [
      { id: 'mxfp4', repository: 'ggml-org/gpt-oss-20b-GGUF', preferredQuantization: 'MXFP4', checkpoint: 'standard', approximateModelBytes: 12_100_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: undefined },
    ],
  },
  {
    id: 'qwen-3-5-9b', name: 'Qwen3.5 9B', developer: 'Qwen',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'lmstudio-community/Qwen3.5-9B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 5_630_000_000, approximateMultimodalBytes: 922_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q6_k', repository: 'lmstudio-community/Qwen3.5-9B-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 7_360_000_000, approximateMultimodalBytes: 922_000_000, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16 },
      { id: 'q8_0', repository: 'lmstudio-community/Qwen3.5-9B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 9_530_000_000, approximateMultimodalBytes: 922_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
    ],
  },
  {
    id: 'qwen-3-6-35b', name: 'Qwen3.6 35B-A3B', developer: 'Qwen',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'ggml-org/Qwen3.6-35B-A3B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 20_400_000_000, approximateMultimodalBytes: 614_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
      { id: 'q8_0', repository: 'ggml-org/Qwen3.6-35B-A3B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 36_900_000_000, approximateMultimodalBytes: 614_000_000, suggestedMemoryGiB: 64, suggestedMultimodalMemoryGiB: 64 },
      { id: 'bf16', repository: 'ggml-org/Qwen3.6-35B-A3B-GGUF', preferredQuantization: 'BF16', checkpoint: 'standard', approximateModelBytes: 69_400_000_000, approximateMultimodalBytes: 614_000_000, suggestedMemoryGiB: 128, suggestedMultimodalMemoryGiB: 128 },
    ],
  },
  {
    id: 'qwen-3-8-27b', name: 'Qwen3.8 27B', developer: 'Qwen',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'ggml-org/Qwen3.8-27B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 19_000_000_000, approximateMultimodalBytes: 629_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
      { id: 'q8_0', repository: 'ggml-org/Qwen3.8-27B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 28_600_000_000, approximateMultimodalBytes: 629_000_000, suggestedMemoryGiB: 64, suggestedMultimodalMemoryGiB: 64 },
      { id: 'bf16', repository: 'ggml-org/Qwen3.8-27B-GGUF', preferredQuantization: 'BF16', checkpoint: 'standard', approximateModelBytes: 53_800_000_000, approximateMultimodalBytes: 629_000_000, suggestedMemoryGiB: 128, suggestedMultimodalMemoryGiB: 128 },
    ],
  },
  {
    id: 'lfm-2-5-230m', name: 'LFM2.5 230M', developer: 'Liquid AI',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 153_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q4_0', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'Q4_0', checkpoint: 'standard', approximateModelBytes: 149_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q5_k_m', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'Q5_K_M', checkpoint: 'standard', approximateModelBytes: 172_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q6_k', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 191_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q8_0', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 247_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'f16', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'F16', checkpoint: 'standard', approximateModelBytes: 462_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'bf16', repository: 'LiquidAI/LFM2.5-230M-GGUF', preferredQuantization: 'BF16', checkpoint: 'standard', approximateModelBytes: 462_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
    ],
  },
  {
    id: 'lfm-2-5-2-6b', name: 'LFM2.5 2.6B', developer: 'Liquid AI',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 1_670_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q4_0', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'Q4_0', checkpoint: 'standard', approximateModelBytes: 1_590_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q5_k_m', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'Q5_K_M', checkpoint: 'standard', approximateModelBytes: 1_940_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q6_k', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 2_220_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q8_0', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 2_870_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'f16', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'F16', checkpoint: 'standard', approximateModelBytes: 5_400_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: undefined },
      { id: 'bf16', repository: 'LiquidAI/LFM2.5-2.6B-GGUF', preferredQuantization: 'BF16', checkpoint: 'standard', approximateModelBytes: 5_400_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: undefined },
    ],
  },
  // Match full tokens, including XL; KQuant filename modifiers are not tokens.
  {
    id: 'muse-glimmer-30b', name: 'Muse-Glimmer 30B', developer: 'Meta',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'meta-models/Muse-Glimmer-30B-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 16_800_000_000, approximateMultimodalBytes: 1_400_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
      { id: 'q4_k_xl', repository: 'meta-models/Muse-Glimmer-30B-GGUF', preferredQuantization: 'Q4_K_XL', checkpoint: 'standard', approximateModelBytes: 19_700_000_000, approximateMultimodalBytes: 1_400_000_000, suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32 },
    ],
  },
  {
    id: 'smollm2-135m', name: 'SmolLM2 135M Instruct', developer: 'Hugging Face',
    quantizationHints: [
      { id: 'q4_k_m', repository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', preferredQuantization: 'Q4_K_M', checkpoint: 'standard', approximateModelBytes: 105_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q3_k_l', repository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', preferredQuantization: 'Q3_K_L', checkpoint: 'standard', approximateModelBytes: 97_500_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q6_k', repository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', preferredQuantization: 'Q6_K', checkpoint: 'standard', approximateModelBytes: 138_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
      { id: 'q8_0', repository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 145_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined },
    ],
  },
];
export type MultimodalDownload = 'off' | 'on';
export type SuggestedMemoryFilter = 'all' | 8 | 16 | 32;
export const suggestedMemoryFilters: readonly SuggestedMemoryFilter[] = ['all', 8, 16, 32];
export const moreGgufModelsUrl = 'https://huggingface.co/models?library=gguf';

export function preferredQuantizationHint({ suggestion }: { suggestion: ModelSuggestion }): SuggestedQuantization {
  // Static policy only. Missing upstream artifacts never authorize a fallback to
  // the next source: explicit selection wins over this initial preference.
  return suggestion.quantizationHints.find(choice => choice.checkpoint === 'qat')
    ?? suggestion.quantizationHints.find(choice => choice.preferredQuantization === 'Q4_K_M')
    ?? suggestion.quantizationHints[0];
}

export function suggestedQuantizationLabel({ quantization }: { quantization: SuggestedQuantization }): string {
  switch (quantization.checkpoint) {
  case 'qat': return `${quantization.preferredQuantization} (QAT)`;
  case 'standard': return quantization.preferredQuantization;
  default: { const exhaustive: never = quantization.checkpoint; throw new Error(String(exhaustive)); }
  }
}

export function suggestionDownloadKey({ suggestionId, quantization, multimodal }: { suggestionId: string, quantization: SuggestedQuantization, multimodal: MultimodalDownload }): string {
  // This key is only an in-memory user intent. Actual storage identity remains
  // the resolved repository/revision/files, independent of hints and labels.
  return `suggestion:${suggestionId}:${encodeURIComponent(quantization.repository.toLowerCase())}:${quantization.id}:${multimodal}`;
}

export function matchesMemoryHint({ quantization, memory, multimodal }: { quantization: SuggestedQuantization, memory: SuggestedMemoryFilter, multimodal: MultimodalDownload }): boolean {
  let required: number;
  switch (multimodal) {
  case 'off': required = quantization.suggestedMemoryGiB; break;
  case 'on': required = quantization.suggestedMultimodalMemoryGiB ?? quantization.suggestedMemoryGiB; break;
  default: { const exhaustive: never = multimodal; throw new Error(String(exhaustive)); }
  }
  return memory === 'all' || required <= memory;
}

export const TEST_ONLY = {
};
