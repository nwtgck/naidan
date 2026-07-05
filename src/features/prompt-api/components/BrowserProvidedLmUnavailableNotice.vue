<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircleIcon, RotateCwIcon } from 'lucide-vue-next';

import { lazyStrings } from '@/strings';
import type { PromptApiRuntimeState } from '@/features/prompt-api/runtime';
import type { PromptApiError } from '@/features/prompt-api/errors';

type PromptApiBrowserFamily = 'chrome' | 'edge' | 'other';

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

function readUserAgentBrands(): readonly string[] {
  if (typeof navigator === 'undefined') return [];

  const userAgentData: unknown = Reflect.get(navigator, 'userAgentData');
  if (typeof userAgentData !== 'object' || userAgentData === null) return [];

  const brands: unknown = Reflect.get(userAgentData, 'brands');
  if (!Array.isArray(brands)) return [];

  return brands.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const brand: unknown = Reflect.get(entry, 'brand');
    return typeof brand === 'string' ? [brand] : [];
  });
}

function detectPromptApiBrowserFamily(): PromptApiBrowserFamily {
  const brands = readUserAgentBrands();
  if (brands.includes('Microsoft Edge')) return 'edge';
  if (brands.includes('Google Chrome')) return 'chrome';
  if (brands.length > 0) return 'other';

  if (typeof navigator === 'undefined') return 'other';
  const userAgent = navigator.userAgent;

  if (/\bEdg(?:A|iOS)?\//u.test(userAgent)) return 'edge';
  if (!/\bChrome\//u.test(userAgent)) return 'other';
  if (/\b(?:OPR|Vivaldi|YaBrowser)\//u.test(userAgent)) return 'other';
  if ('brave' in navigator) return 'other';
  return 'chrome';
}

const browserFamily = computed(detectPromptApiBrowserFamily);

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

        <template v-if="props.state.status === 'model_unavailable'">
          <p tw-class="mt-3 text-[11px] font-bold text-gray-700 dark:text-gray-200">
            {{ lazyStrings.PromptApiStatus__common_reasons_include() }}
          </p>

          <ul
            data-testid="prompt-api-common-reasons"
            tw-class="mt-1 list-disc pl-5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300"
          >
            <template v-if="browserFamily === 'chrome'">
              <li>{{ lazyStrings.PromptApiStatus__less_than_required_free_space_on_browser_profile_volume({ browser: 'Chrome', gigabytes: 22 }) }}</li>
              <li>{{ lazyStrings.PromptApiStatus__less_than_16_gb_ram_or_fewer_than_4_cpu_cores_for_cpu_inference() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__chrome_gpu_with_4_gb_vram_or_less() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__unsupported_operating_system_or_device() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__metered_or_unavailable_network_during_initial_download() }}</li>
            </template>

            <template v-else-if="browserFamily === 'edge'">
              <li>{{ lazyStrings.PromptApiStatus__less_than_required_free_space_on_browser_profile_volume({ browser: 'Edge', gigabytes: 20 }) }}</li>
              <li>{{ lazyStrings.PromptApiStatus__edge_gpu_with_less_than_5_5_gb_vram_for_phi_4_mini() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__unsupported_operating_system_or_device_performance_class() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__metered_or_unavailable_network_during_initial_download() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__required_edge_experimental_flags_are_not_enabled() }}</li>
            </template>

            <template v-else>
              <li>{{ lazyStrings.PromptApiStatus__model_download_may_require_more_free_space() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__operating_system_or_hardware_requirements_may_not_be_met() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__prompt_api_may_be_disabled_by_browser_settings_flags_or_policy() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__model_download_may_require_an_unmetered_network() }}</li>
            </template>
          </ul>

          <details
            data-testid="prompt-api-supported-browsers-details"
            tw-class="mt-3 border-t border-red-100 dark:border-red-900/30 pt-3"
          >
            <summary tw-class="cursor-pointer text-[11px] font-bold text-gray-700 dark:text-gray-300">
              {{ lazyStrings.PromptApiStatus__supported_browsers_and_requirements() }}
            </summary>
            <ul tw-class="mt-2 list-disc pl-5 text-[10px] leading-relaxed text-gray-600 dark:text-gray-400">
              <li>{{ lazyStrings.PromptApiStatus__chrome_148_or_later_desktop() }}</li>
              <li>{{ lazyStrings.PromptApiStatus__edge_canary_or_dev_138_or_later_with_prompt_api_flag() }}</li>
            </ul>
          </details>
        </template>

        <template v-else>
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
        </template>

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
