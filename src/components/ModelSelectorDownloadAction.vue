<script setup lang="ts">
import { useId } from 'vue';
import { lazyStrings } from '@/strings';
import { CheckIcon, DownloadIcon, SquareIcon } from 'lucide-vue-next';

defineProps<{
  label: string,
  state: 'available' | 'active' | 'complete',
  activeLabel?: string,
  destinationLabel?: string,
  percent?: number,
  action?: 'resume' | 'retry',
  disabled: boolean,
}>();
const destinationId = useId();
const emit = defineEmits<{ download: [], stop: [] }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex min-h-8 shrink-0 items-center gap-1">
    <span v-if="state === 'active'" tw-class="flex shrink-0 flex-col text-right text-[10px] leading-3 tabular-nums text-blue-600 dark:text-blue-400">
      <span>{{ activeLabel }}</span>
      <span v-if="percent !== undefined" role="progressbar" :aria-label="lazyStrings.ModelSelectorDownloadAction__progress_for_model({ model: label })" :aria-valuenow="percent" tw-class="flex flex-col items-end gap-0.5">
        {{ percent }}%
        <span aria-hidden="true" tw-class="h-0.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <span :style="{ width: percent + '%' }" tw-class="block h-full rounded-full bg-blue-500 transition-[width] duration-200 motion-reduce:transition-none" />
        </span>
      </span>
    </span>
    <button v-if="state === 'active'" type="button" :aria-label="lazyStrings.ModelSelectorDownloadAction__stop_for_model({ model: label })" :title="lazyStrings.ModelSelectorDownloadAction__stop()" data-testid="model-selector-variant-stop" tw-class="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700" @click="emit('stop')"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
    <span v-else-if="state === 'complete'" role="img" :aria-label="lazyStrings.ModelSelectorDownloadAction__complete()" :title="lazyStrings.ModelSelectorDownloadAction__complete()" tw-class="grid h-8 w-8 place-items-center text-gray-500"><CheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></span>
    <div v-else tw-class="flex min-w-0 items-center gap-0.5">
      <span v-if="destinationLabel !== undefined" :id="destinationId" :title="destinationLabel" data-testid="model-selector-download-destination" tw-class="max-w-20 truncate text-[10px] text-gray-500 dark:text-gray-400"><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserDownloadDestination__download_to() }}{{ ' ' }}</span>{{ destinationLabel }}</span>
      <button type="button" :disabled="disabled" :aria-describedby="destinationLabel === undefined ? undefined : destinationId" :aria-label="lazyStrings.ModelSelectorDownloadAction__download_model({ model: label })" :title="action === 'resume' ? lazyStrings.ModelSelectorDownloadAction__resume() : action === 'retry' ? lazyStrings.ModelSelectorDownloadAction__retry() : lazyStrings.ModelSelectorDownloadAction__download()" data-testid="model-selector-variant-download" tw-class="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:hover:bg-gray-700" @click="emit('download')"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
    </div>
  </div>
</template>
