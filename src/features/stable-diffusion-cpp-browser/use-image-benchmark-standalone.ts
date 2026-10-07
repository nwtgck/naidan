import { computed } from 'vue';
import { createBenchmarkForm } from './benchmark-form';
import type { ImageBenchmarkView } from './benchmark-view';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
export function useImageBenchmark({ generation: _generation }: { generation: ImageGenerationView }): ImageBenchmarkView {
  const form = createBenchmarkForm();
  return { ...form, available: computed(() => false), targets: computed(() => []), busy: computed(() => false), canStart: computed(() => false), plannedRuns: computed(() => 0),
    async start() {}, stop() {}, clear() {}, async download() {}, select() {}, toggle() {}, effective: () => form.common.value, change() {}, inherit() {}, chooseComponent() {}, chooseLoras() {}, chooseImageInputs() {},
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}
export const TEST_ONLY = {
};
