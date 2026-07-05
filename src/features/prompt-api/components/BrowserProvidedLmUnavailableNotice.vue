<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircleIcon, RotateCwIcon } from 'lucide-vue-next';

import { lazyStrings } from '@/strings';
import type { PromptApiRuntimeState } from '@/features/prompt-api/runtime';
import type { PromptApiError } from '@/features/prompt-api/errors';

type UnavailableState = Extract<
  PromptApiRuntimeState,
  { status: 'api_unavailable' | 'model_unavailable' | 'error' }
>;

const props = defineProps<{
  state: UnavailableState,
}>();

const emit = defineEmits<{
  (event: 'retry'): void,
}>();

function formatPromptApiError({ error }: { error: PromptApiError | undefined }): string | undefined {
  if (error === undefined) return undefined;

  const cause = error.cause;
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (cause !== undefined) {
    return String(cause);
  }
  return `${error.name}: ${error.message}`;
}

const technicalDetail = computed(() => {
  const state = props.state;
  switch (state.status) {
  case 'api_unavailable':
    return formatPromptApiError({ error: state.error })
      ?? 'LanguageModel API was not detected. globalThis.LanguageModel is missing or does not expose the required availability() and create() methods.';
  case 'model_unavailable':
    return formatPromptApiError({ error: state.error })
      ?? 'LanguageModel.availability() returned "unavailable".';
  case 'error':
    return formatPromptApiError({ error: state.error })
      ?? `${state.error.name}: ${state.error.message}`;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});


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
  <div
    data-testid="browser-provided-lm-unavailable-notice"
    role="status"
    tw-class="rounded-2xl border border-red-100 dark:border-red-900/40 bg-red-50/70 dark:bg-red-950/20 px-4 py-4"
  >
    <div tw-class="flex items-start gap-3">
      <AlertCircleIcon tw-class="mt-0.5 w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />

      <div tw-class="min-w-0 flex-1">
        <p
          v-if="props.state.status === 'api_unavailable'"
          tw-class="text-xs font-bold text-red-700 dark:text-red-300"
        >{{ lazyStrings.PromptApiStatus__browser_provided_language_models_are_not_available_in_this_browser() }}</p>
        <p
          v-else-if="props.state.status === 'model_unavailable'"
          tw-class="text-xs font-bold text-red-700 dark:text-red-300"
        >{{ lazyStrings.PromptApiStatus__browser_provided_model_is_not_available_on_this_device() }}</p>
        <p
          v-else-if="props.state.phase === 'availability'"
          tw-class="text-xs font-bold text-red-700 dark:text-red-300"
        >{{ lazyStrings.PromptApiStatus__could_not_check_browser_provided_model_availability() }}</p>
        <p
          v-else
          tw-class="text-xs font-bold text-red-700 dark:text-red-300"
        >{{ lazyStrings.PromptApiStatus__model_preparation_failed() }}</p>

        <p
          v-if="props.state.status === 'api_unavailable'"
          tw-class="mt-1 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300"
        >{{ lazyStrings.PromptApiStatus__language_model_api_was_not_detected() }}</p>
        <p
          v-else-if="props.state.status === 'model_unavailable'"
          tw-class="mt-1 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300"
        >{{ lazyStrings.PromptApiStatus__browser_reported_model_unavailable() }}</p>
        <p
          v-else-if="props.state.phase === 'availability'"
          tw-class="mt-1 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300"
        >{{ lazyStrings.PromptApiStatus__browser_returned_an_error_while_checking_availability() }}</p>
        <p
          v-else
          tw-class="mt-1 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300"
        >{{ lazyStrings.PromptApiStatus__browser_returned_an_error_while_preparing_model() }}</p>

        <p tw-class="mt-3 text-[11px] font-bold text-gray-700 dark:text-gray-200">
          {{ lazyStrings.PromptApiStatus__supported_browsers() }}
        </p>
        <ul tw-class="mt-1 list-disc pl-5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300">
          <li>{{ lazyStrings.PromptApiStatus__chrome_148_or_later_desktop() }}</li>
          <li>{{ lazyStrings.PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag() }}</li>
        </ul>

        <details tw-class="mt-3 border-t border-red-100 dark:border-red-900/30 pt-3">
          <summary tw-class="cursor-pointer text-[11px] font-bold text-gray-700 dark:text-gray-300">
            {{ lazyStrings.PromptApiStatus__if_unavailable_in_a_supported_browser() }}
          </summary>
          <ul tw-class="mt-2 list-disc pl-5 text-[10px] leading-relaxed text-gray-600 dark:text-gray-400">
            <li>{{ lazyStrings.PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy() }}</li>
            <li>{{ lazyStrings.PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met() }}</li>
            <li>{{ lazyStrings.PromptApiStatus__model_download_may_require_more_free_space() }}</li>
            <li>{{ lazyStrings.PromptApiStatus__model_download_may_require_an_unmetered_network() }}</li>
          </ul>
        </details>

        <details
          :open="props.state.status === 'error'"
          tw-class="mt-3 border-t border-red-100 dark:border-red-900/30 pt-3"
        >
          <summary tw-class="cursor-pointer text-[11px] font-bold text-gray-700 dark:text-gray-300">
            {{ lazyStrings.PromptApiStatus__technical_details() }}
          </summary>
          <pre
            data-testid="prompt-api-technical-detail"
            tw-class="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-950 px-3 py-2 text-[10px] leading-relaxed text-gray-200"
          >{{ technicalDetail }}</pre>
        </details>

        <button
          v-if="props.state.status === 'error'"
          type="button"
          data-testid="prompt-api-retry-button"
          @click="emit('retry')"
          tw-class="mt-3 inline-flex items-center gap-1 rounded-lg border border-red-200 dark:border-red-800 px-3 py-2 text-[10px] font-bold text-red-700 dark:text-red-300 hover:bg-red-100/60 dark:hover:bg-red-950/30 transition-colors"
        >
          <RotateCwIcon tw-class="w-3 h-3" />
          {{ lazyStrings.PromptApiStatus__try_again() }}
        </button>
      </div>
    </div>
  </div>
</template>
