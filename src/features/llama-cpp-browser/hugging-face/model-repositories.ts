export type ModelNaming =
  | Readonly<{ kind: 'base-model-aligned' }>
  | Readonly<{ kind: 'custom-variant', name: string }>;

export type HfRepositoryEntry = {
  hfRepository: string,
  modelNaming: ModelNaming,
};

// Keep repositories in name order, independently of the recommendation order.
// Removing a recommendation must not remove its published launch URLs. Retain
// older repositories when recommendations change. Each repository has one page;
// launch-time quantization selection is independent of this publication list.
// This is bundled data only; reading it must never inspect upstream repositories.
//
// Classify model naming by whether Naidan can reasonably present a model
// under its base model's name.
//
// - base-model-aligned:
//   The model retains enough of the base model's identity to be presented
//   under its name. Includes official GGUF releases and conversions or
//   quantizations intended to preserve the base model's characteristics
//   as closely as possible.
//
// - custom-variant:
//   Distinctive quantization, optimization, or other modifications make the
//   model worth identifying separately from its base model.
//   Provide an explicit display name, including the method or publisher
//   where appropriate.
//
// This is an editorial naming decision, not a guarantee of identical weights
// or complete equivalence to the base model.
// For borderline cases, consider whether using only the base model's name
// would mislead users.
export const hfRepositories = [
  { hfRepository: 'bartowski/Qwen3.8-Flash-Next-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'ggml-org/gpt-oss-20b-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'ggml-org/Qwen3.6-35B-A3B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'ggml-org/Qwen3.8-27B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'google/gemma-4-12B-it-qat-q4_0-gguf', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'google/gemma-4-E2B-it-qat-q4_0-gguf', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'google/gemma-4-E4B-it-qat-q4_0-gguf', modelNaming: { kind: 'base-model-aligned' } },
  {
    hfRepository: 'ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF',
    modelNaming: {
      kind: 'custom-variant',
      name: 'Qwen3.8-27B GSQ-RCO (ISTA DASLab)',
    },
  },
  { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'LiquidAI/LFM2.5-230M-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'LiquidAI/LFM3-1.7B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'LiquidAI/LFM3-VL-2B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'lmstudio-community/gemma-4-E2B-it-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'lmstudio-community/gemma-4-E4B-it-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'lmstudio-community/Qwen3.5-9B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'lmstudio-community/SmolLM2-135M-Instruct-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  { hfRepository: 'meta-models/Muse-Glimmer-30B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
  {
    hfRepository: 'unsloth/Qwen3.8-Flash-Next-GGUF',
    modelNaming: {
      kind: 'custom-variant',
      name: 'Qwen3.8-Flash-Next (Unsloth)',
    },
  },
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
