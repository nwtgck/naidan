<script setup lang="ts">
import { computed } from 'vue';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { localModelDisplayName } from './browser-model-presentation';
import { CheckIcon, HardDriveIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ErrorCode, LocalModel, Progress } from '@/features/llama-cpp-browser/types';

const props = defineProps<{
  state: {
    phase: 'offered' | 'saving' | 'finalizing' | 'saved' | 'failed',
    model: LocalModel,
    sourceModel: LocalModel,
    progress: Progress | undefined,
    error: ErrorCode | undefined,
  },
}>();
const emit = defineEmits<{ save: [], dismiss: [], retry: [], cancel: [] }>();
const percentage = computed(() => {
  const progress = props.state.progress;
  return progress && progress.total > 0 ? Math.floor(Math.min(1, Math.max(0, progress.completed / progress.total)) * 100) : undefined;
});
const size = computed(() => formatDownloadBytes({ bytes: props.state.model.size }));
const modelName = computed(() => localModelDisplayName({ model: props.state.sourceModel }));
const status = computed(() => {
  const phase = props.state.phase;
  switch (phase) {
  case 'offered': return lazyStrings.TemporaryModelSaveNotice__save_this_model_in_your_browser();
  case 'saving': return lazyStrings.TemporaryModelSaveNotice__saving_in_your_browser();
  case 'finalizing': return lazyStrings.TemporaryModelSaveNotice__finishing_model_settings();
  case 'saved': return lazyStrings.TemporaryModelSaveNotice__saved_in_your_browser();
  case 'failed': return lazyStrings.TemporaryModelSaveNotice__could_not_save_model();
  default: {
    const exhaustive: never = phase;
    return exhaustive;
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section class="temporary-model-notice" data-testid="temporary-model-notice" :aria-label="lazyStrings.TemporaryModelSaveNotice__model_storage()" tw-class="rounded-xl border border-gray-200/80 bg-white/95 px-3 py-3 text-left shadow-sm dark:border-gray-700 dark:bg-gray-900/95 sm:px-4">
    <div tw-class="flex items-start gap-2.5">
      <span tw-class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"><CheckIcon v-if="state.phase === 'saved'" aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" /><HardDriveIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" /></span>
      <div tw-class="min-w-0 flex-1 space-y-1.5">
        <div tw-class="flex flex-wrap items-baseline gap-x-3 gap-y-1"><p role="status" tw-class="text-xs font-medium text-gray-800 dark:text-gray-100">{{ status }}</p><p :title="state.model.modelId" tw-class="flex min-w-0 max-w-full items-baseline gap-2 text-[10px] text-gray-500 dark:text-gray-400"><span tw-class="truncate">{{ modelName }}</span><span tw-class="shrink-0 tabular-nums">{{ size }}</span></p></div>
        <div v-if="state.phase === 'offered'" tw-class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.TemporaryModelSaveNotice__available_after_page_reload() }}</p><div tw-class="flex shrink-0 items-center gap-3"><button type="button" data-testid="temporary-model-skip" tw-class="min-h-8 rounded-md text-[11px] text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-100" @click="emit('dismiss')">{{ lazyStrings.TemporaryModelSaveNotice__use_until_page_reload() }}</button><button type="button" data-testid="temporary-model-save" tw-class="min-h-8 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500" @click="emit('save')">{{ lazyStrings.TemporaryModelSaveNotice__save_in_browser() }}</button></div></div>
        <template v-else-if="state.phase === 'saving' || state.phase === 'finalizing'">
          <div tw-class="flex items-center gap-3 pt-1"><div role="progressbar" :aria-label="lazyStrings.TemporaryModelSaveNotice__saving_to_browser()" :aria-valuenow="percentage" :aria-valuemin="percentage === undefined ? undefined : 0" :aria-valuemax="percentage === undefined ? undefined : 100" tw-class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"><div :class="{ 'indeterminate': percentage === undefined }" :style="{ width: percentage === undefined ? '28%' : `${percentage}%` }" tw-class="h-full rounded-full bg-blue-600 transition-[width] duration-300 motion-reduce:transition-none dark:bg-blue-400" /></div><span v-if="percentage !== undefined" tw-class="text-[10px] tabular-nums text-gray-500 dark:text-gray-400">{{ percentage }}%</span></div>
          <div tw-class="flex items-center justify-between gap-3"><p tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.TemporaryModelSaveNotice__keep_chatting_while_saving() }}</p><button v-if="state.phase === 'saving'" type="button" data-testid="temporary-model-cancel" tw-class="min-h-8 shrink-0 rounded-lg px-2 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="emit('cancel')">{{ lazyStrings.SHARED__cancel() }}</button></div>
        </template>
        <div v-else-if="state.phase === 'failed'" role="alert" tw-class="flex items-center justify-between gap-3"><p tw-class="text-[11px] text-red-600 dark:text-red-400">{{ lazyStrings.TemporaryModelSaveNotice__could_not_save_model() }}</p><button type="button" data-testid="temporary-model-retry" tw-class="min-h-8 shrink-0 rounded-lg px-3 text-[11px] font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10 focus-visible:outline-2 focus-visible:outline-blue-500" @click="emit('retry')">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button></div>
        <p v-else tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.TemporaryModelSaveNotice__saved_model_available_after_page_reload() }}</p>
      </div>
      <button type="button" data-testid="temporary-model-dismiss" :aria-label="lazyStrings.TemporaryModelSaveNotice__close_save_notice()" tw-class="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-200" @click="emit('dismiss')"><XIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
    </div>
  </section>
</template>

<style scoped>
.temporary-model-notice {
  animation: temporary-model-notice-appear 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes temporary-model-notice-appear {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.indeterminate {
  animation: save-indeterminate 1.5s ease-in-out infinite alternate;
}
@keyframes save-indeterminate {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(250%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .temporary-model-notice, .indeterminate {
    animation: none;
  }
}
</style>
