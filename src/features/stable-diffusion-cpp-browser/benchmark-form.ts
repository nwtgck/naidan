import { ref, shallowRef } from 'vue';
import { createImageForm } from './form';
import type { Parameters, Progress } from './types';
import type { BenchmarkProtocol, BenchmarkRun, BenchmarkPlan, ParameterChange } from './benchmark/types';

/** Shared presentation state, also used by the unavailable standalone facade.
 * No schema/runtime imports, network access or model reads. */
export function createBenchmarkForm() {
  const common = ref<Parameters>({ ...createImageForm({ profile: 'webgpu-wasm32-asyncify' }).parameters.value,
    prompt: 'A small wooden cabin beside a quiet lake, mountains in the distance, soft morning light.', width: 512, height: 512, steps: 8, guidance: 6 });
  const preview = ref({ enabled: false, mode: 'vae' as 'vae' | 'projection', interval: 2, startStep: 1, maxEdge: 256 });
  const protocol = ref<BenchmarkProtocol>({ mode: 'cold-warm', repeats: 3, order: 'listed', cooldownSeconds: 2, timeoutSeconds: 0, keepImages: false });
  const strategy = ref<'shared' | 'model-defaults'>('model-defaults');
  const includePrompts = ref(false), notes = ref(''), selected = ref<string[]>([]);
  const overrides = ref<Record<string, Partial<Parameters>>>({});
  const state = ref<'idle' | 'running' | 'finished' | 'cancelled'>('idle'), exporting = ref(false), error = ref(''), feedback = ref('');
  const runs = shallowRef<BenchmarkRun[]>([]), plan = shallowRef<BenchmarkPlan>(), current = ref<string>(), progress = shallowRef<Progress>();
  function setCommon({ change }: { change: ParameterChange }): void {
    common.value = { ...common.value, [change.key]: change.value };
  }
  return { common, preview, protocol, strategy, includePrompts, notes, selected, overrides, state, exporting, error, feedback, runs, plan, current, progress, setCommon };
}
export const TEST_ONLY = {
};
