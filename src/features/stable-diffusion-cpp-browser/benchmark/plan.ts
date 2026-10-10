import { protocolSchema, MAX_BENCHMARK_RUNS } from './types';
import type { BenchmarkPlan } from './types';
import { requestSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { Parameters, Artifact, PreviewSettings, WeightResidency, ImageInputs } from '@/features/stable-diffusion-cpp-browser/types';
import { emptyImageInputs } from '@/features/image-generation/image-input-form';
import type { ImageBenchmarkTarget } from '@/features/stable-diffusion-cpp-browser/library-view';
import { recommendationForSelection } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { imageLoraRequests, type ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';

export function benchmarkParameters({ common, target, strategy, overrides }: {
  common: Parameters, target: ImageBenchmarkTarget, strategy: 'shared' | 'model-defaults', overrides: Partial<Parameters>,
}): { parameters: Parameters, preset: string | undefined } {
  // Keep dimensions, step count, prompt and seed common by default. Only the
  // model-specific sampling/CFG contract varies, visibly and in exported JSON.
  let modelValues: Partial<Parameters> = {}, preset: string | undefined;
  switch (strategy) {
  case 'model-defaults': {
    const recommended = recommendationForSelection({ model: target.facts });
    if (recommended) {
      const { guidance, sampler, scheduler, modelArguments } = recommended.parameters;
      // The Qwen Turbo partial hint must not impose an unsupported scheduler
      // or overwrite user-supplied sampling settings during comparison runs.
      modelValues = recommended.recommendedFieldsOnly
        ? (recommended.recommendedFields?.includes('guidance') ? { guidance } : {})
        : { guidance, sampler, scheduler, modelArguments: common.modelArguments || modelArguments };
      preset = recommended.id;
    }
    break;
  }
  case 'shared': break;
  default: { const exhaustive: never = strategy; throw new Error(String(exhaustive)); }
  }
  return { parameters: { ...common, ...modelValues, ...overrides }, preset };
}

export function createBenchmarkPlan({ id, createdAt, appVersion, notes, protocol, targets, common, overrides, loras, imageInputs, strategy, artifact, baseUrl, preview, weightResidency, gpuBudgetMiB }: {
  id: string, createdAt: string, appVersion: string, notes: string, protocol: unknown,
  targets: ImageBenchmarkTarget[], common: Parameters, overrides: Readonly<Record<string, Partial<Parameters>>>,
  loras: Readonly<Record<string, readonly ImageLoraSelection[]>>,
  imageInputs: Readonly<Record<string, ImageInputs>>,
  strategy: 'shared' | 'model-defaults', artifact: Artifact, baseUrl: string, preview: PreviewSettings,
  weightResidency: WeightResidency, gpuBudgetMiB: number | undefined,
}): BenchmarkPlan {
  const settings = protocolSchema.parse(protocol);
  if (!targets.length || targets.length * settings.repeats > MAX_BENCHMARK_RUNS) throw new Error('Select models and keep the plan within 100 runs');
  if (notes.length > 2048) throw new Error('Environment notes exceed 2048 characters');
  if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error('Duplicate benchmark target');
  const ordered = (() => {
    switch (settings.order) {
    case 'reverse': return [...targets].reverse();
    case 'listed': return [...targets];
    default: { const exhaustive: never = settings.order; throw new Error(String(exhaustive)); }
    }
  })();
  const models = ordered.map(target => {
    if (!target.models || target.issue || target.missing.length) throw new Error(`Incomplete model: ${target.label}`);
    const changes = { ...overrides[target.id] };
    const resolved = benchmarkParameters({ common, target, strategy, overrides: changes });
    const request = requestSchema.parse({ artifact, baseUrl, models: target.models, loras: imageLoraRequests({ selections: loras[target.id] ?? [] }), imageInputs: imageInputs[target.id] ?? emptyImageInputs(), parameters: resolved.parameters, debug: 'on', preview, weightResidency, gpuBudgetMiB });
    // -1 would resolve to different random seeds; never silently substitute one.
    if (request.parameters.seed === '-1') throw new Error('Benchmark requires an explicit, non-random seed');
    return { target: { ...target, facts: { ...target.facts, evidence: [...target.facts.evidence] }, components: structuredClone(target.components), missing: [...target.missing], models: request.models }, request, overrides: changes, preset: resolved.preset };
  });
  // All requests are validated and detached before creating/releasing any worker.
  return { id, createdAt, appVersion, notes, protocol: settings, models };
}

export const TEST_ONLY = {
};
