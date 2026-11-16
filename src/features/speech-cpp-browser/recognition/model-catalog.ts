import type { ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

// speech.cpp-format single-file conversions, without a projector or voice file.
// Bundled hints never fetch metadata; explicit downloads resolve a pinned plan.
// Memory hints are starting points, not measured browser/VRAM requirements.
export const speechRecognitionModelCatalog: readonly ModelSuggestion[] = [
  {
    id: 'speech-qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B',
    developer: 'Qwen',
    quantizationHints: [{ id: 'q8_0', hfRepository: 'sakasegawa/Qwen3-ASR-0.6B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 842_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined }],
  },
  {
    id: 'speech-qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B',
    developer: 'Qwen',
    quantizationHints: [{ id: 'q8_0', hfRepository: 'sakasegawa/Qwen3-ASR-1.7B-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 2_177_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: undefined }],
  },
  {
    id: 'speech-reazonspeech-v2',
    name: 'ReazonSpeech v2',
    developer: 'Reazon Human Interaction Lab',
    quantizationHints: [{ id: 'q8_0', hfRepository: 'sakasegawa/reazonspeech-nemo-v2-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 661_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined }],
  },
  {
    id: 'speech-parakeet-ja',
    name: 'Parakeet TDT-CTC 0.6B Japanese',
    developer: 'NVIDIA',
    quantizationHints: [{ id: 'q8_0', hfRepository: 'sakasegawa/parakeet-tdt_ctc-0.6b-ja-GGUF', preferredQuantization: 'Q8_0', checkpoint: 'standard', approximateModelBytes: 662_000_000, approximateMultimodalBytes: undefined, suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: undefined }],
  },
];

export const TEST_ONLY = {
};
