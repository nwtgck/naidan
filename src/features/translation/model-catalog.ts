import type { ModelSuggestion, SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

// Rounded decimal sizes from the corresponding pfnet GGUF model cards.
// The first configuration is the publisher's standard Q4_K_M choice.
export const translationModelSuggestions: readonly ModelSuggestion[] = [
  { size: '0.8b', label: '0.8B', standardBytes: 570_000_000, q4Bytes: 550_000_000, q3Bytes: 490_000_000, q2Bytes: 410_000_000, memory: 4 },
  { size: '2b', label: '2B', standardBytes: 1_810_000_000, q4Bytes: 1_700_000_000, q3Bytes: 1_500_000_000, q2Bytes: 1_230_000_000, memory: 4 },
  { size: '8b', label: '8B', standardBytes: 5_280_000_000, q4Bytes: undefined, q3Bytes: 4_310_000_000, q2Bytes: 3_450_000_000, memory: 16 },
  { size: '31b', label: '31B', standardBytes: 19_530_000_000, q4Bytes: undefined, q3Bytes: 15_860_000_000, q2Bytes: 12_610_000_000, memory: 32 },
].map(({ size, label, standardBytes, q4Bytes, q3Bytes, q2Bytes, memory }) => {
  const id = `plamo-3-translate-${size}`;
  function hint({ quantization, bytes }: { quantization: string, bytes: number }): SuggestedQuantization {
    return {
      id: quantization.toLowerCase(),
      hfRepository: `pfnet/${id}-GGUF`,
      preferredQuantization: quantization,
      checkpoint: 'standard',
      approximateModelBytes: bytes,
      approximateMultimodalBytes: undefined,
      suggestedMemoryGiB: memory,
      suggestedMultimodalMemoryGiB: undefined,
    };
  }
  return {
    id,
    name: `PLaMo 3 Translate ${label}`,
    developer: 'Preferred Networks',
    quantizationHints: [
      hint({ quantization: 'Q4_K_M', bytes: standardBytes }),
      ...(q4Bytes === undefined ? [] : [hint({ quantization: 'Q4_0', bytes: q4Bytes })]),
      hint({ quantization: 'Q3_K_M', bytes: q3Bytes }),
      hint({ quantization: 'Q2_K', bytes: q2Bytes }),
    ],
  };
});

export const defaultTranslationModel = translationModelSuggestions[0]!.quantizationHints[0];

export const TEST_ONLY = {
};
