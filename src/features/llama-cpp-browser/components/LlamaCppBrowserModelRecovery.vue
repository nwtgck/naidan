<script setup lang="ts">
import { computed, useId } from 'vue';
import { DownloadIcon, Loader2Icon } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { lazyStrings } from '@/strings';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import type { MissingLlamaCppBrowserModelUi } from '@/features/llama-cpp-browser/composables/useMissingLlamaCppBrowserModel';
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';

const props = defineProps<{ state: MissingLlamaCppBrowserModelUi, appearance?: 'welcome' | 'compact' }>();
const router = useRouter();
const headingId = useId();
const modelId = computed(() => props.state.modelId.value ?? '');
// A missing reference may no longer resolve. Keep the complete name and file
// selector rather than guessing a catalog family or dropping its quantization.
const modelName = computed(() => modelId.value.replace(/^(?:temp|user|host|hf\.co)\//, ''));
const job = computed(() => {
  const candidate = props.state.job.value;
  return candidate?.status === 'complete' || candidate?.status === 'cancelled' ? undefined : candidate;
});
const size = computed(() => props.state.target.value?.selection.files.reduce((sum, file) => sum + file.size, 0));

function manageModels(): void {
  void router.replace({ query: { ...router.currentRoute.value.query, settings: 'llama-cpp-browser' } });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- Separate from the model-link hero. This is a non-modal, asynchronous
       recovery notice; the surrounding composer and existing draft stay put. -->
  <section v-if="state.visible.value" data-testid="model-recovery" :aria-labelledby="headingId" :tw-class="['w-full mx-auto pointer-events-auto text-left', appearance === 'compact' ? 'max-w-4xl rounded-xl border border-gray-200/80 dark:border-gray-700 bg-white/95 dark:bg-gray-900/95 px-3 py-2 shadow-sm space-y-1' : 'max-w-xl border-t border-gray-200 dark:border-gray-800 pt-4 space-y-3']">
    <div tw-class="flex items-start gap-3">
      <span tw-class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></span>
      <div tw-class="min-w-0 flex-1 space-y-1">
        <h3 :id="headingId" role="status" :tw-class="['font-medium text-gray-800 dark:text-gray-100', appearance === 'compact' ? 'text-xs' : 'text-sm']">{{ state.availability.value === 'unreadable' ? lazyStrings.LlamaCppBrowserModelRecovery__could_not_check_model_storage() : lazyStrings.LlamaCppBrowserModelRecovery__model_not_in_this_browser() }}</h3>
        <p data-testid="model-recovery-name" :title="modelId" tw-class="text-xs text-gray-500 dark:text-gray-400 break-all">{{ modelName }}</p>
        <p v-if="state.availability.value === 'missing' && appearance !== 'compact'" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelRecovery__keep_your_draft_while_preparing() }}</p>
      </div>
    </div>
    <template v-if="state.availability.value === 'missing'">
      <LlamaCppBrowserDownloadJob v-if="job" :job="job" :disabled="state.busy.value" appearance="welcome" :sources-visibility="appearance === 'compact' ? 'hidden' : 'visible'" @resume="state.download()" />
      <p v-else-if="state.operation.value !== 'idle' || (state.job.value?.status === 'complete' && state.verification.value === 'checking')" role="status" tw-class="flex items-center gap-2 min-h-11 text-xs text-gray-500 dark:text-gray-400">
        <Loader2Icon aria-hidden="true" tw-class="w-4 h-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.LlamaCppBrowserModelLaunch__checking_model() }}
      </p>
      <div v-else-if="state.canDownload.value" tw-class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <template v-if="state.target.value">
          <span v-if="size !== undefined" data-testid="model-recovery-size" tw-class="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{{ formatDownloadBytes({ bytes: size }) }}</span>
          <button data-testid="model-recovery-download" type="button" :disabled="state.verification.value === 'checking'" @click="state.download()" tw-class="min-h-11 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">{{ lazyStrings.LlamaCppBrowserModelRecovery__download() }}</button>
        </template>
        <button v-else data-testid="model-recovery-review" type="button" :disabled="state.verification.value === 'checking'" @click="state.review()" tw-class="min-h-11 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 rounded-md">{{ lazyStrings.LlamaCppBrowserModelRecovery__review_download() }}</button>
      </div>
    </template>
    <p v-if="state.failure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelRecovery__could_not_prepare_download() }}</p>
    <div tw-class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      <button data-testid="model-recovery-recheck" type="button" :disabled="state.verification.value === 'checking'" @click="state.retry()" tw-class="min-h-11 py-2 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 rounded-md disabled:opacity-50">{{ lazyStrings.LlamaCppBrowserModelRecovery__check_again() }}</button>
      <button data-testid="model-recovery-manage" type="button" @click="manageModels()" tw-class="min-h-11 py-2 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 rounded-md">{{ lazyStrings.LlamaCppBrowserModelRecovery__manage_models() }}</button>
    </div>
  </section>
</template>
