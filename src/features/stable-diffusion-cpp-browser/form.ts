import { ref, shallowRef } from 'vue';
import { defaultPreviewSettings } from './form-options';
import type { PreviewFrame, PreviewSettings, Artifact, Parameters, WeightResidency, ModelSlot, Progress } from './types';
import type { ImageLoraSelection } from './lora-form';
import { emptyImageInputs } from './image-input-form';

/** Shared visible form state, including the disabled standalone page. */
export function createImageForm({ profile: initialProfile }: { profile: Artifact['profile'] }) {
  const profile = ref(initialProfile);
  const debug = ref<'off' | 'on'>('off');
  const diagnosticText = ref('');
  const diagnosticStatus = ref('');
  const diagnosticFeedback = ref('');
  const layout = ref<'checkpoint' | 'components'>('checkpoint');
  const files = shallowRef<Partial<Record<ModelSlot, File>>>({});
  const loras = shallowRef<ImageLoraSelection[]>([]);
  const imageInputs = shallowRef(emptyImageInputs());
  const parameters = ref<Parameters>({ prompt: '', negativePrompt: '', width: 256, height: 256, steps: 20, guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5, vaeTiling: true, vaeTileSize: 32, flashAttention: false, bf16WeightType: 'f32', qwenVaePolicy: 'bounded', conditioningCacheSize: 0, modelArguments: '' });
  const retainModel = ref(true);
  const modelResident = ref(false);
  const preview = ref<PreviewSettings>({ ...defaultPreviewSettings });
  // Capture remains opt-in; keep incoming frames by default once enabled.
  const keepPreviews = ref(true);
  const maxPreviews = ref(16);
  const maxResults = ref(20);
  const previewError = ref('');
  const livePreview = shallowRef<(Omit<PreviewFrame, 'png'> & { url: string, id: number, elapsedMs: number })>();
  const previewSnapshots = shallowRef<(Omit<PreviewFrame, 'png'> & { url: string, id: number, elapsedMs: number })[]>([]);
  const weightResidency = ref<WeightResidency>('auto');
  // An empty number input leaves the optional native memory budget unset.
  const gpuBudgetMiB = ref<number | ''>('');
  const progress = shallowRef<Progress>();
  // Presentation belongs to the workspace, not a mounted result component.
  // A final image can succeed before its independent history save fails.
  const latestRun = shallowRef<{ width: number, height: number } & (
    { status: 'running' | 'succeeded' | 'cancelled' } | { status: 'failed', failure: string }
  )>();
  const failure = ref('');
  const invalid = ref(false);
  const cancelled = ref(false);
  const stopping = ref(false);
  const results = shallowRef<{ url: string, parameters: Parameters, modelVersion: string, uniformOutput: boolean, elapsedMs: number, id: number }[]>([]);
  return { retainModel, modelResident, preview, keepPreviews, maxPreviews, maxResults, previewError, livePreview, previewSnapshots, debug, diagnosticText, diagnosticStatus, diagnosticFeedback, profile, layout, files, loras, imageInputs, parameters, weightResidency, gpuBudgetMiB, progress, latestRun, failure, invalid, cancelled, stopping, results };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
