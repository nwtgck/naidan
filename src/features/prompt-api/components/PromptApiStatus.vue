<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import {
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
} from 'lucide-vue-next';

import { lazyStrings } from '@/strings';
import {
  acquirePromptApiRuntimeMonitoring,
  preparePromptApi,
  promptApiRuntimeState,
  refreshPromptApiAvailability,
  type PromptApiRuntimeState,
} from '@/features/prompt-api/runtime';

import BrowserProvidedLmUnavailableNotice from './BrowserProvidedLmUnavailableNotice.vue';

const props = defineProps<{
  showReady?: boolean,
}>();

let releaseMonitoring: (() => void) | undefined;

onMounted(() => {
  releaseMonitoring = acquirePromptApiRuntimeMonitoring();
});

onBeforeUnmount(() => {
  releaseMonitoring?.();
});

const progressPercent = computed(() => {
  const state = promptApiRuntimeState.value;
  return state.status === 'downloading' && state.progress !== undefined
    ? Math.round(state.progress * 100)
    : undefined;
});

const unavailableState = computed<Extract<
  PromptApiRuntimeState,
  { status: 'api_unavailable' | 'model_unavailable' | 'error' }
> | undefined>(() => {
  const state = promptApiRuntimeState.value;
  switch (state.status) {
  case 'api_unavailable':
  case 'model_unavailable':
  case 'error':
    return state;
  case 'unchecked':
  case 'checking':
  case 'downloadable':
  case 'downloading':
  case 'preparing':
  case 'ready':
    return undefined;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});

async function prepare(): Promise<void> {
  try {
    await preparePromptApi({ signal: undefined });
  } catch {
    // The runtime state contains the normalized error shown by this component.
  }
}

async function retry(): Promise<void> {
  await refreshPromptApiAvailability({ showCheckingState: 'yes' });
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      progressPercent,
    },
  }) || {}),
});
</script>

<template>
  <div
    v-if="unavailableState || promptApiRuntimeState.status !== 'ready' || props.showReady === true"
    :tw-class="{ 'md:col-span-2': unavailableState !== undefined }"
  >
    <BrowserProvidedLmUnavailableNotice
      v-if="unavailableState"
      :state="unavailableState"
      @retry="retry"
    />

    <div
      v-else
      data-testid="prompt-api-status"
      tw-class="rounded-2xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/20 px-4 py-3"
    >
      <p tw-class="mb-2 text-[11px] text-gray-600 dark:text-gray-300">
        {{ lazyStrings.SHARED__uses_a_language_model_provided_and_managed_by_the_browser() }}
      </p>
      <div tw-class="flex flex-wrap items-center gap-3">
        <Loader2Icon
          v-if="promptApiRuntimeState.status === 'unchecked' || promptApiRuntimeState.status === 'checking' || promptApiRuntimeState.status === 'preparing'"
          tw-class="w-4 h-4 text-blue-600 animate-spin shrink-0"
        />
        <DownloadIcon
          v-else-if="promptApiRuntimeState.status === 'downloadable' || promptApiRuntimeState.status === 'downloading'"
          tw-class="w-4 h-4 text-blue-600 shrink-0"
        />
        <CheckCircle2Icon
          v-else-if="promptApiRuntimeState.status === 'ready'"
          tw-class="w-4 h-4 text-emerald-600 shrink-0"
        />

        <div tw-class="min-w-0 flex-1">
          <p
            v-if="promptApiRuntimeState.status === 'unchecked' || promptApiRuntimeState.status === 'checking'"
            tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"
          >{{ lazyStrings.PromptApiStatus__checking_browser_provided_language_model_availability() }}</p>
          <p
            v-else-if="promptApiRuntimeState.status === 'downloadable'"
            tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"
          >{{ lazyStrings.PromptApiStatus__prepare_browser_provided_model() }}</p>
          <p
            v-else-if="promptApiRuntimeState.status === 'downloading' && progressPercent !== undefined"
            tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"
          >{{ lazyStrings.PromptApiStatus__downloading_browser_provided_model_progress({ progress: progressPercent }) }}</p>
          <p
            v-else-if="promptApiRuntimeState.status === 'downloading'"
            tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"
          >{{ lazyStrings.PromptApiStatus__downloading_browser_provided_model() }}</p>
          <p
            v-else-if="promptApiRuntimeState.status === 'preparing'"
            tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"
          >{{ lazyStrings.PromptApiStatus__preparing_browser_provided_model() }}</p>
          <p
            v-else-if="promptApiRuntimeState.status === 'ready'"
            tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"
          >{{ lazyStrings.PromptApiStatus__browser_provided_model_is_ready() }}</p>
        </div>

        <button
          v-if="promptApiRuntimeState.status === 'downloadable'"
          type="button"
          data-testid="prompt-api-prepare-button"
          @click="prepare"
          tw-class="shrink-0 rounded-lg bg-blue-600 px-3 py-2 text-[10px] font-bold text-white hover:bg-blue-700 transition-colors"
        >{{ lazyStrings.PromptApiStatus__prepare_browser_provided_model() }}</button>
      </div>

      <div
        v-if="promptApiRuntimeState.status === 'downloading' && progressPercent !== undefined"
        tw-class="mt-3 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/50"
      >
        <div
          tw-class="h-full bg-blue-600 transition-all"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
    </div>
  </div>
</template>
