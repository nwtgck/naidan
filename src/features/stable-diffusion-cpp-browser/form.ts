import { ref, shallowRef } from 'vue';
import type { Artifact, Parameters, WeightResidency, ModelSlot, Progress } from './types';

/** Shared visible form state, including the disabled standalone page. */
export function createImageForm({ profile: initialProfile }: { profile: Artifact['profile'] }) {
  const profile = ref(initialProfile);
  const debug = ref<'off' | 'on'>('off');
  const diagnosticText = ref('');
  const diagnosticStatus = ref('');
  const diagnosticFeedback = ref('');
  const layout = ref<'checkpoint' | 'components'>('checkpoint');
  const files = shallowRef<Partial<Record<ModelSlot, File>>>({});
  const parameters = ref<Parameters>({ prompt: '', negativePrompt: '', width: 256, height: 256, steps: 20, guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5, vaeTiling: true, vaeTileSize: 32, flashAttention: false, conditioningCacheSize: 0, modelArguments: '' });
  const weightResidency = ref<WeightResidency>('auto');
  // An empty number input leaves the optional native memory budget unset.
  const gpuBudgetMiB = ref<number | ''>('');
  const progress = shallowRef<Progress>();
  const failure = ref('');
  const invalid = ref(false);
  const cancelled = ref(false);
  const results = shallowRef<{ url: string, parameters: Parameters, modelVersion: string, id: number }[]>([]);
  return { debug, diagnosticText, diagnosticStatus, diagnosticFeedback, profile, layout, files, parameters, weightResidency, gpuBudgetMiB, progress, failure, invalid, cancelled, results };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
