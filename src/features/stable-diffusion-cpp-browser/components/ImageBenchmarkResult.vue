<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import type { BenchmarkRunRecord } from '@/features/stable-diffusion-cpp-browser/benchmark/types';

const props = defineProps<{ runId: string, png: Blob | undefined, imageStatus: BenchmarkRunRecord['image']['status'] }>();
const open = ref(false), url = ref<string>();
function release(): void {
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = undefined;
}
watch([open, () => props.png], ([expanded, png]) => {
  release();
  // Retention itself does not decode or copy pixels for display. The browser
  // image decoder is invoked only after the user opens the details.
  if (expanded && png) url.value = URL.createObjectURL(png);
});
onScopeDispose(release);
const unavailable = computed(() => {
  switch (props.imageStatus) {
  case 'not-requested': return lazyStrings.ImageBenchmarkResult__image_not_retained();
  case 'budget-exceeded': return lazyStrings.ImageBenchmarkResult__image_memory_limit_reached();
  case 'no-output': case 'retained': return lazyStrings.ImageBenchmarkResult__no_image();
  default: { const exhaustive: never = props.imageStatus; throw new Error(String(exhaustive)); }
  }
});
function toggle({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) open.value = event.target.open;
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <details data-testid="benchmark-result-details" @toggle="toggle({ event: $event })" tw-class="mt-2 text-xs">
    <summary tw-class="cursor-pointer text-purple-600 dark:text-purple-400">{{ lazyStrings.ImageBenchmarkResult__generated_image() }}</summary>
    <div v-if="open" tw-class="mt-2 space-y-2">
      <template v-if="url">
        <img :src="url" :alt="lazyStrings.ImageBenchmarkResult__generated_image()" data-testid="benchmark-result-image" tw-class="max-w-full w-80 h-auto rounded-lg border border-gray-200 dark:border-gray-700" />
        <a :href="url" :download="`naidan-image-${runId}.png`" tw-class="inline-block text-purple-600 dark:text-purple-400 underline">{{ lazyStrings.stableDiffusionCppBrowser__download_png() }}</a>
      </template>
      <p v-else data-testid="benchmark-result-image-unavailable" tw-class="text-gray-500 dark:text-gray-400">{{ unavailable }}</p>
    </div>
  </details>
</template>
