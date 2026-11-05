import type { ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

// Editorial Q4_K_M size/memory hints only, not download identities or runtime
// guarantees. Downloads resolve real files and byte counts on explicit action.
// The 0.8B / 31B sizes were supplied with the publisher's GGUF metadata; the
// intermediate sizes are rounded estimates, like the shared catalog's hints.
export const translationModelSuggestions: readonly ModelSuggestion[] = [
  { size: '0.8b', label: '0.8B', bytes: 573_000_000, memory: 4 },
  { size: '2b', label: '2B', bytes: 1_500_000_000, memory: 4 },
  { size: '8b', label: '8B', bytes: 5_000_000_000, memory: 16 },
  { size: '31b', label: '31B', bytes: 19_500_000_000, memory: 32 },
].map(({ size, label, bytes, memory }) => ({
  id: `plamo-3-translate-${size}`,
  name: `PLaMo 3 Translate ${label}`,
  developer: 'Preferred Networks',
  quantizationHints: [{
    id: 'q4_k_m',
    hfRepository: `pfnet/plamo-3-translate-${size}-GGUF`,
    preferredQuantization: 'Q4_K_M',
    checkpoint: 'standard',
    approximateModelBytes: bytes,
    approximateMultimodalBytes: undefined,
    suggestedMemoryGiB: memory,
    suggestedMultimodalMemoryGiB: undefined,
  }],
}));

export const TEST_ONLY = {
};
