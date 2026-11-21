import type { ModelSuggestion, SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

export type SpeechRecognitionQuantization = SuggestedQuantization & { fileName: string };
export type SpeechRecognitionModelSuggestion = Omit<ModelSuggestion, 'quantizationHints'> & {
  quantizationHints: readonly [SpeechRecognitionQuantization, ...SpeechRecognitionQuantization[]],
};

type SpeechQuantizationFile = readonly [variant: 'Q4_K' | 'Q5_K' | 'Q6_K' | 'Q8_0' | 'F16', bytes: number];

function recognitionQuantizations({ repository, fileNamePrefix, memoryGiB, files }: {
  repository: string, fileNamePrefix: string, memoryGiB: number, files: readonly [SpeechQuantizationFile, ...SpeechQuantizationFile[]],
}): SpeechRecognitionModelSuggestion['quantizationHints'] {
  const [first, ...rest] = files;
  function toHint({ file }: { file: SpeechQuantizationFile }): SpeechRecognitionQuantization {
    const [preferredQuantization, approximateModelBytes] = file;
    return {
      id: preferredQuantization.toLowerCase(),
      fileName: `${fileNamePrefix}-${preferredQuantization}.gguf`,
      hfRepository: repository,
      preferredQuantization,
      checkpoint: 'standard',
      approximateModelBytes,
      approximateMultimodalBytes: undefined,
      suggestedMemoryGiB: memoryGiB,
      suggestedMultimodalMemoryGiB: undefined,
    };
  }
  return [toHint({ file: first }), ...rest.map(file => toHint({ file }))];
}

// The source model cards list these speech.cpp single-file conversions. Keep
// Q8_0 first to preserve the default. Downloads still resolve verified files
// from a repository revision.
export const speechRecognitionModelCatalog: readonly SpeechRecognitionModelSuggestion[] = [
  {
    id: 'speech-qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B',
    developer: 'Qwen',
    quantizationHints: recognitionQuantizations({
      repository: 'sakasegawa/Qwen3-ASR-0.6B-GGUF',
      fileNamePrefix: 'Qwen3-ASR-0.6B',
      memoryGiB: 8,
      files: [['Q8_0', 841_502_336], ['Q6_K', 681_496_704], ['Q5_K', 593_751_680], ['Q4_K', 511_168_128]],
    }),
  },
  {
    id: 'speech-qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B',
    developer: 'Qwen',
    quantizationHints: recognitionQuantizations({
      repository: 'sakasegawa/Qwen3-ASR-1.7B-GGUF',
      fileNamePrefix: 'Qwen3-ASR-1.7B',
      memoryGiB: 16,
      files: [['Q8_0', 2_176_109_216], ['Q6_K', 1_683_632_800], ['Q5_K', 1_413_565_088], ['Q4_K', 1_159_383_712]],
    }),
  },
  {
    id: 'speech-reazonspeech-v2',
    name: 'ReazonSpeech v2',
    developer: 'Reazon Human Interaction Lab',
    quantizationHints: recognitionQuantizations({
      repository: 'sakasegawa/reazonspeech-nemo-v2-GGUF',
      fileNamePrefix: 'reazonspeech-nemo-619M-v2',
      memoryGiB: 8,
      files: [['Q8_0', 660_910_656], ['Q6_K', 513_808_960], ['Q5_K', 433_140_288], ['Q4_K', 357_216_832], ['F16', 1_240_465_696]],
    }),
  },
  {
    id: 'speech-parakeet-ja',
    name: 'Parakeet TDT-CTC 0.6B Japanese',
    developer: 'NVIDIA',
    quantizationHints: recognitionQuantizations({
      repository: 'sakasegawa/parakeet-tdt_ctc-0.6b-ja-GGUF',
      fileNamePrefix: 'parakeet-tdt_ctc-0.6B-ja',
      memoryGiB: 8,
      files: [['Q8_0', 661_012_416], ['Q6_K', 513_910_720], ['Q5_K', 433_242_048], ['Q4_K', 357_318_592], ['F16', 1_240_656_832]],
    }),
  },
];

export const TEST_ONLY = {
};
