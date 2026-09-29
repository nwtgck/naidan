<script setup lang="ts">
import { computed, useId } from 'vue';
import { ArrowRightIcon, Loader2Icon, MessageCircleIcon, HardDriveIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useSettings } from '@/composables/useSettings';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import type { ModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useModelLaunchChat';
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';
import LlamaCppBrowserModelLaunchPrivacy from './LlamaCppBrowserModelLaunchPrivacy.vue';
import LlamaCppBrowserModelLaunchHeading from './LlamaCppBrowserModelLaunchHeading.vue';
import LlamaCppBrowserModelLoadProgress from './LlamaCppBrowserModelLoadProgress.vue';

const props = defineProps<{ state: ModelLaunchChatUi }>();
const { settings } = useSettings();
const headingId = useId();
const target = computed(() => props.state.selectedTarget.value);
const repository = computed(() => target.value?.selection.repository ?? props.state.launch.value?.target.selection.repository ?? props.state.presentation?.value?.repository ?? '');
const size = computed(() => target.value?.selection.files.reduce((sum, file) => sum + file.size, 0));
const displayedJob = computed(() => {
  const job = props.state.job.value;
  return job?.status === 'complete' || job?.status === 'cancelled' ? undefined : job;
});
const waitingForFiles = computed(() => props.state.readiness.value === 'checking'
  || props.state.operation.value === 'adopting'
  || (props.state.job.value?.status === 'complete' && props.state.readiness.value !== 'ready' && props.state.verification.value === 'checking'));

function selectVariant({ event }: { event: Event }): void {
  if (event.target instanceof HTMLSelectElement) props.state.selectPath({ path: event.target.value });
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- This is part of WelcomeScreen, not another modal or a large boxed panel.
       Controls are deliberately flat; only the primary action uses Naidan blue. -->
  <section v-if="state.visible.value" :aria-labelledby="repository ? headingId : undefined" data-testid="model-launch-card" tw-class="w-full max-w-xl mx-auto space-y-6 sm:space-y-7 pointer-events-auto">
    <LlamaCppBrowserModelLaunchPrivacy />
    <LlamaCppBrowserModelLaunchHeading :repository="repository" :heading-id="headingId" />

    <div data-testid="model-launch-controls" tw-class="w-full max-w-lg mx-auto text-left space-y-3">
      <template v-if="!state.launch.value">
        <p v-if="state.restoration.value === 'checking'" role="status" tw-class="min-h-14 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2Icon aria-hidden="true" tw-class="w-4 h-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.LlamaCppBrowserModelLaunch__restoring_model() }}
        </p>
        <template v-else>
          <p role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p>
          <button data-testid="model-launch-restore-retry" type="button" @click="state.retryRestoration()" tw-class="w-full min-h-14 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
        </template>
      </template>
      <template v-else>
        <div tw-class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <label v-if="state.launch.value.requestedVariant === undefined" tw-class="flex items-center gap-1 min-w-0">
            <span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserModelLaunch__quantization() }}</span>
            <select data-testid="model-launch-quantization" :value="state.selectedPath.value" :disabled="state.busy.value || !state.isActive.value" @change="selectVariant({ event: $event })" tw-class="max-w-full min-w-0 min-h-11 rounded-md border-0 bg-transparent px-2 py-2 text-xs font-normal text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-800 dark:hover:text-gray-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 disabled:cursor-default">
              <option v-if="!state.choices.value.some(choice => choice.id === state.selectedPath.value)" :value="state.selectedPath.value">{{ state.label.value }}</option>
              <option v-for="choice in state.choices.value" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
            </select>
          </label>
          <span v-else data-testid="model-launch-fixed-quantization" tw-class="inline-flex min-h-11 items-center text-xs font-normal text-gray-500 dark:text-gray-400">{{ state.label.value }}</span>
          <span v-if="size !== undefined" data-testid="model-launch-size" tw-class="inline-flex items-center gap-1.5 text-gray-500 dark:text-gray-400 tabular-nums">
            <HardDriveIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />{{ formatDownloadBytes({ bytes: size }) }}
          </span>
        </div>

        <!-- Mutually exclusive action states prevent an extra Start button while
             downloading or verifying. Revalidation never advertises a new transfer. -->
        <div tw-class="min-h-14">
          <p v-if="!state.isActive.value && !state.needsRecovery.value" role="status" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__chat_settings_changed() }}</p>
          <template v-else-if="state.needsRecovery.value">
            <button data-testid="model-launch-recover" type="button" :disabled="state.busy.value" @click="state.recover()" tw-class="w-full min-h-14 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
          </template>
          <LlamaCppBrowserDownloadJob
            v-else-if="displayedJob && (state.readiness.value !== 'ready' || state.selectionChanged.value)"
            :key="displayedJob.id"
            :job="displayedJob"
            :disabled="state.busy.value || state.verification.value === 'checking' || !state.isActive.value || state.runtimeUnavailable.value"
            appearance="welcome"
            @resume="state.adoptAndDownload()"
          />
          <p v-else-if="state.runtimeUnavailable.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here() }}</p>
          <p v-else-if="waitingForFiles" role="status" data-testid="model-launch-checking" tw-class="min-h-14 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2Icon aria-hidden="true" tw-class="w-4 h-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.LlamaCppBrowserModelLaunch__checking_local_files() }}
          </p>
          <template v-else-if="state.readiness.value === 'failed'">
            <p role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p>
            <button data-testid="model-launch-check-retry" type="button" :disabled="state.busy.value" @click="state.refresh()" tw-class="w-full min-h-14 mt-3 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
          </template>
          <template v-else-if="state.readiness.value === 'ready' && !state.selectionChanged.value">
            <LlamaCppBrowserModelLoadProgress v-if="state.warmup.value === 'loading'" :progress="state.warmupProgress.value" />
            <p v-else role="status" data-testid="model-launch-ready" tw-class="min-h-14 flex items-center justify-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              <MessageCircleIcon aria-hidden="true" tw-class="w-4 h-4 text-blue-600 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserModelLaunch__ready_when_you_are() }}
            </p>
          </template>
          <button
            v-else-if="target"
            type="button"
            data-testid="model-launch-download"
            :disabled="state.busy.value || state.verification.value === 'checking'"
            @click="state.adoptAndDownload()"
            tw-class="w-full min-h-14 flex items-center justify-center gap-3 px-5 py-4 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-sm sm:text-base font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:cursor-wait"
          >
            <span>{{ state.hasPausedDownload.value ? lazyStrings.llamaCppBrowserDownloads__resume() : lazyStrings.LlamaCppBrowserModelLaunch__start_with_this_model() }}</span>
            <ArrowRightIcon aria-hidden="true" tw-class="w-4 h-4 shrink-0" />
          </button>
        </div>
        <p v-if="state.error.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p>
        <p v-if="state.warmup.value === 'failed'" role="status" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__prepare_on_send() }}</p>
        <p v-if="state.defaultWarning.value" role="status" tw-class="text-xs leading-relaxed text-amber-600 dark:text-amber-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__global_defaults_not_saved() }}</p>
        <div v-if="state.launch.value.requestedVariant === undefined" tw-class="flex justify-center">
          <button type="button" :disabled="state.busy.value || !state.isActive.value" @click="state.refreshChoices()" tw-class="min-h-11 px-3 text-xs text-gray-500 dark:text-gray-400 underline underline-offset-4 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 rounded-lg">{{ lazyStrings.LlamaCppBrowserModelLaunch__refresh_choices() }}</button>
        </div>
      </template>
    </div>
    <p v-if="settings.storageType === 'memory'" tw-class="text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.WelcomeScreen__data_is_cleared_on_reload() }}</p>
  </section>
</template>
