<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { ChevronDownIcon } from 'lucide-vue-next';
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
  <details data-testid="benchmark-result-details" @toggle="toggle({ event: $event })" tw-class="group mt-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 text-xs">
    <summary tw-class="flex min-h-10 items-center justify-between gap-2 cursor-pointer list-none rounded-xl px-3 py-2 font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">{{ lazyStrings.ImageBenchmarkResult__generated_image() }}<ChevronDownIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" /></summary>
    <div v-if="open" tw-class="space-y-2 border-t border-gray-100 dark:border-gray-800 p-3">
      <template v-if="url">
        <img :src="url" :alt="lazyStrings.ImageBenchmarkResult__generated_image()" data-testid="benchmark-result-image" tw-class="max-w-full w-80 h-auto rounded-lg border border-gray-200 dark:border-gray-700" />
        <a :href="url" :download="`naidan-image-${runId}.png`" tw-class="inline-flex min-h-9 items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 font-medium text-blue-600 dark:text-blue-400 transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.stableDiffusionCppBrowser__download_png() }}</a>
      </template>
      <p v-else data-testid="benchmark-result-image-unavailable" tw-class="text-gray-500 dark:text-gray-400">{{ unavailable }}</p>
    </div>
  </details>
</template>
