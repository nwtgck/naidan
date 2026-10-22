<script setup lang="ts">
import { computed } from 'vue';
import { PlayIcon, RefreshCcwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useModelLaunchChat';
import { browserModelRepositoryPresentation } from '@/components/browser-model-presentation';
import { modelLaunchPreparationStage } from '@/features/llama-cpp-browser/model-launch/presentation';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import BrowserModelPreparation from '@/components/BrowserModelPreparation.vue';
import LlamaCppBrowserDownloadSources from './LlamaCppBrowserDownloadSources.vue';
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';
import LlamaCppBrowserModelLoadProgress from './LlamaCppBrowserModelLoadProgress.vue';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';

const props = defineProps<{ state: ModelLaunchChatUi, routePath: string }>();
const target = computed(() => props.state.selectedTarget.value ?? props.state.launch.value?.target);
const repository = computed(() => target.value?.selection.repository ?? props.state.presentation.value?.repository ?? '');
const model = computed(() => browserModelRepositoryPresentation({ repository: repository.value, bytes: target.value?.selection.files.reduce((sum, file) => sum + file.size, 0) }));
const quantizations = computed(() => props.state.choices.value.length > 0
  ? props.state.choices.value.map(choice => ({ value: choice.primaryRelativePath, label: choice.label, detail: formatDownloadBytes({ bytes: choice.models.flatMap(model => model.files).reduce((sum, file) => sum + file.size, 0) }) }))
  : target.value === undefined ? [] : [{ value: target.value.mainFilePath, label: props.state.label.value, detail: model.value.bytes === undefined ? undefined : formatDownloadBytes({ bytes: model.value.bytes }) }]);
const displayedJob = computed(() => {
  const job = props.state.job.value;
  return job?.status === 'complete' || job?.status === 'cancelled' ? undefined : job;
});
const stage = computed(() => modelLaunchPreparationStage({ state: props.state }));
const observedProgress = computed(() => {
  const journal = props.state.observedDownload.value?.journal;
  return journal === undefined ? undefined : {
    phase: 'transferring' as const,
    processed: 0,
    completed: journal.bytes.reduce((sum, bytes) => sum + bytes, 0),
    total: journal.selection.files.reduce((sum, file) => sum + file.size, 0),
  };
});
const error = computed(() => props.state.runtimeUnavailable.value ? lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here()
  : stage.value === 'failed' || props.state.readiness.value === 'failed' ? lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() : undefined);

function start(): void {
  const state = props.state;
  if (state.needsRecovery.value) {
    void state.recover();
    return;
  }
  const restoration = state.restoration.value;
  switch (restoration) {
  case 'failed': state.retryRestoration();
    return;
  case 'idle': case 'checking': break;
  default: {
    const exhaustive: never = restoration;
    throw new Error(String(exhaustive));
  }
  }
  const readiness = state.readiness.value;
  switch (readiness) {
  case 'failed': void state.refresh();
    return;
  case 'ready': if (!state.selectionChanged.value) {
    state.retryWarmup();
    return;
  }
    break;
  case 'checking': case 'missing': break;
  default: {
    const exhaustive: never = readiness;
    throw new Error(String(exhaustive));
  }
  }
  void state.adoptAndDownload();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="state.visible.value" data-testid="model-launch-card" tw-class="w-full pointer-events-auto">
    <BrowserModelPreparation presentation="preparation" :model="model" :entry="state.homeOriginId.value === undefined ? 'model-url' : 'home'" :stage="stage" interaction="ready"
                             :variant="state.selectedPath.value" :quantization-options="quantizations" :start-status="state.busy.value || state.verification.value === 'checking' ? 'starting' : 'idle'"
                             :error="error" :selection-state="undefined" @start="start" @back="state.returnToHome()" @select-quantization="state.selectPath({ path: $event })">
      <template #quantization-actions>
        <button type="button" data-testid="model-launch-refresh-choices" :disabled="state.launch.value === undefined || state.busy.value || !state.isActive.value" :aria-label="lazyStrings.LlamaCppBrowserModelLaunch__refresh_choices()" :title="lazyStrings.LlamaCppBrowserModelLaunch__refresh_choices()" tw-class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-800 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="state.refreshChoices()"><RefreshCcwIcon aria-hidden="true" tw-class="h-3 w-3" /></button>
      </template>
      <template #progress>
        <LlamaCppBrowserDownloadJob v-if="displayedJob && state.readiness.value !== 'ready'" :job="displayedJob" :disabled="state.busy.value || state.verification.value === 'checking' || !state.isActive.value || state.runtimeUnavailable.value" appearance="welcome" sources-visibility="hidden" @resume="state.adoptAndDownload()" />
        <div v-else-if="state.observedDownload.value" data-testid="model-launch-observed-download" tw-class="space-y-1">
          <div tw-class="flex min-h-9 items-center justify-between gap-2">
            <span role="status" tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.llamaCppBrowserDownloads__paused() }}</span>
            <button type="button" data-testid="model-launch-resume-observed" :disabled="state.busy.value || state.verification.value === 'checking' || !state.isActive.value || state.runtimeUnavailable.value" tw-class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 transition-colors motion-reduce:transition-none disabled:opacity-50" @click="state.adoptAndDownload()"><PlayIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.llamaCppBrowserDownloads__resume() }}</button>
          </div>
          <LlamaCppBrowserDownloadProgress :progress="observedProgress" appearance="welcome" activity="inactive" />
        </div>
        <LlamaCppBrowserModelLoadProgress v-else-if="state.warmup.value === 'loading'" :progress="state.warmupProgress.value" />
        <p v-else role="status" data-testid="model-launch-checking" tw-class="min-h-14 flex items-center text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserModelPreparation__checking_model() }}</p>
        <button v-if="state.warmup.value === 'deferred'" type="button" tw-class="min-h-11 w-full rounded-xl px-4 text-sm text-blue-600 dark:text-blue-400" @click="state.retryWarmup()">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
      </template>
      <template #details>
        <LlamaCppBrowserDownloadSources v-if="displayedJob" :job="displayedJob" appearance="quiet" />
        <button v-if="state.readiness.value === 'failed'" type="button" data-testid="model-launch-check-retry" tw-class="min-h-11 w-full rounded-xl px-4 text-sm text-blue-600 dark:text-blue-400" @click="state.refresh()">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
        <p v-if="state.defaultWarning.value" role="status" tw-class="text-xs leading-relaxed text-amber-600 dark:text-amber-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__global_defaults_not_saved() }}</p>

      </template>
    </BrowserModelPreparation>
  </div>
</template>
