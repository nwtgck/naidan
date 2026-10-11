export type HfRepositoryEntry = {
  hfRepository: string,
  sitemapQuantizations: readonly [string, ...string[]],
};

// Keep repositories in name order, independently of the recommendation order.
// Removing a recommendation must not remove its published launch URLs. Retain
// older repositories and sitemap quantizations when recommendations change.
// This is bundled data only; reading it must never inspect upstream repositories.
export const hfRepositories = [
  { hfRepository: 'ggml-org/gpt-oss-20b-GGUF', sitemapQuantizations: ['MXFP4'] },
  { hfRepository: 'ggml-org/Qwen3.6-35B-A3B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'ggml-org/Qwen3.8-27B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf', sitemapQuantizations: ['Q4_0'] },
  { hfRepository: 'google/gemma-4-E2B-it-qat-q4_0-gguf', sitemapQuantizations: ['Q4_0'] },
  { hfRepository: 'google/gemma-4-E4B-it-qat-q4_0-gguf', sitemapQuantizations: ['Q4_0'] },
  { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'LiquidAI/LFM2.5-230M-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'lmstudio-community/gemma-4-E2B-it-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'lmstudio-community/gemma-4-E4B-it-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'lmstudio-community/Qwen3.5-9B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', sitemapQuantizations: ['Q4_K_M'] },
  { hfRepository: 'meta-models/Muse-Glimmer-30B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
] as const satisfies readonly HfRepositoryEntry[];

export type HfRepositoryName = typeof hfRepositories[number]['hfRepository'];

export function getHfRepository({ hfRepository }: { hfRepository: HfRepositoryName }): typeof hfRepositories[number] {
  const entry = hfRepositories.find(entry => entry.hfRepository === hfRepository);
  if (!entry) throw new Error(`Unregistered Hugging Face repository: ${hfRepository}`);
  return entry;
}

export const TEST_ONLY = {
};
