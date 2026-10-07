import { ref, shallowRef } from 'vue';
import { createImageForm } from '@/features/image-generation/form';
import type { ModelSlot, Parameters, Progress, ImageInputs } from './types';
import type { BenchmarkProtocol, BenchmarkRun, BenchmarkPlan, ParameterChange } from './benchmark/types';
import type { ImageLoraSelection } from './lora-form';

/** Shared presentation state, also used by the unavailable standalone facade.
 * No schema/runtime imports, network access or model reads. */
export function createBenchmarkForm() {
  const common = ref<Parameters>({ ...createImageForm({ profile: 'webgpu-wasm32-asyncify' }).parameters.value,
    prompt: 'A fluffy cat curled up asleep by a window in soft morning light. Small potted plants and warm wooden furnishings create a quiet, soothing scene. Gentle warm colors and soft shadows.', width: 512, height: 512, steps: 8, guidance: 6 });
  const preview = ref({ enabled: false, mode: 'vae' as 'vae' | 'projection', interval: 2, startStep: 1, maxEdge: 256 });
  const protocol = ref<BenchmarkProtocol>({ mode: 'fresh-each', repeats: 2, order: 'listed', cooldownSeconds: 2, timeoutSeconds: 0, keepImages: true });
  const strategy = ref<'shared' | 'model-defaults'>('model-defaults');
  const includePrompts = ref(false), notes = ref(''), selected = ref<string[]>([]);
  const includeInputImages = ref<'omit' | 'include'>('omit');
  const overrides = ref<Record<string, Partial<Parameters>>>({});
  const componentSelections = ref<Record<string, Partial<Record<ModelSlot, string>>>>({});
  const loras = shallowRef<Record<string, ImageLoraSelection[]>>({});
  const imageInputs = shallowRef<Record<string, ImageInputs>>({});
  const state = ref<'idle' | 'running' | 'finished' | 'cancelled'>('idle'), exporting = ref(false), error = ref(''), feedback = ref('');
  const runs = shallowRef<BenchmarkRun[]>([]), plan = shallowRef<BenchmarkPlan>(), current = ref<string>(), progress = shallowRef<Progress>();
  function setCommon({ change }: { change: ParameterChange }): void {
    common.value = { ...common.value, [change.key]: change.value };
  }
  return { common, preview, protocol, strategy, includePrompts, includeInputImages, notes, selected, overrides, componentSelections, loras, imageInputs, state, exporting, error, feedback, runs, plan, current, progress, setCommon };
}
export const TEST_ONLY = {
};
