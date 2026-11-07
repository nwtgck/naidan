export type HfRepositoryEntry = {
  hfRepository: string,
};

// Keep repositories in name order, independently of the recommendation order.
// Removing a recommendation must not remove its published launch URLs. Retain
// older repositories when recommendations change. Each repository has one page;
// launch-time quantization selection is independent of this publication list.
// This is bundled data only; reading it must never inspect upstream repositories.
export const hfRepositories = [
  { hfRepository: 'bartowski/Qwen3.8-Flash-Next-GGUF' },
  { hfRepository: 'ggml-org/gpt-oss-20b-GGUF' },
  { hfRepository: 'ggml-org/Qwen3.6-35B-A3B-GGUF' },
  { hfRepository: 'ggml-org/Qwen3.8-27B-GGUF' },
  { hfRepository: 'google/gemma-4-12B-it-qat-q4_0-gguf' },
  { hfRepository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf' },
  { hfRepository: 'google/gemma-4-E2B-it-qat-q4_0-gguf' },
  { hfRepository: 'google/gemma-4-E4B-it-qat-q4_0-gguf' },
  { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF' },
  { hfRepository: 'LiquidAI/LFM2.5-230M-GGUF' },
  { hfRepository: 'LiquidAI/LFM3-1.7B-GGUF' },
  { hfRepository: 'LiquidAI/LFM3-VL-2B-GGUF' },
  { hfRepository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF' },
  { hfRepository: 'lmstudio-community/gemma-4-E2B-it-GGUF' },
  { hfRepository: 'lmstudio-community/gemma-4-E4B-it-GGUF' },
  { hfRepository: 'lmstudio-community/Qwen3.5-9B-GGUF' },
  { hfRepository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF' },
  { hfRepository: 'meta-models/Muse-Glimmer-30B-GGUF' },
] as const satisfies readonly HfRepositoryEntry[];

export type HfRepositoryName = typeof hfRepositories[number]['hfRepository'];

// Docs shares only this type, not the application runtime or another registry.
export type ModelPageId = `hf.co/${HfRepositoryName}`;

export function getHfRepository({ hfRepository }: { hfRepository: HfRepositoryName }): typeof hfRepositories[number] {
  const entry = hfRepositories.find(entry => entry.hfRepository === hfRepository);
  if (!entry) {
    throw new Error(`Unregistered Hugging Face repository: ${hfRepository}`);
  }
  return entry;
}

export const TEST_ONLY = {
};
