<script setup lang="ts">
import { ref, useId } from 'vue';
import { ChevronDownIcon, ShieldCheckIcon, CpuIcon, AppWindowIcon, DownloadIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const details = ref<HTMLDetailsElement>();
const summary = ref<HTMLElement>();
const explanationId = useId();

function closeExplanation(): void {
  if (!details.value?.open) return;
  details.value.open = false;
  summary.value?.focus();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- A native disclosure works with click, touch and keyboard; the explanation
       is never hover-only and stays in flow rather than covering the main action. -->
  <details ref="details" data-testid="model-launch-privacy" tw-class="group w-full" @keydown.esc.stop.prevent="closeExplanation()">
    <summary
      ref="summary"
      :aria-controls="explanationId"
      data-testid="model-launch-privacy-trigger"
      tw-class="list-none [&::-webkit-details-marker]:hidden mx-auto w-fit max-w-full min-h-11 flex items-center justify-center gap-2 rounded-full px-4 py-2 text-xs sm:text-sm font-medium text-blue-700 dark:text-blue-300 bg-blue-50/80 dark:bg-blue-500/10 border border-blue-100/70 dark:border-blue-500/15 hover:bg-blue-100/70 dark:hover:bg-blue-500/15 cursor-pointer transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500"
    >
      <ShieldCheckIcon aria-hidden="true" tw-class="w-4 h-4 shrink-0" />
      <span>{{ lazyStrings.LlamaCppBrowserModelLaunch__runs_privately_in_your_browser() }}</span>
      <ChevronDownIcon aria-hidden="true" tw-class="w-3.5 h-3.5 shrink-0 group-open:rotate-180 transition-transform duration-200 motion-reduce:transition-none" />
    </summary>
    <div :id="explanationId" data-testid="model-launch-privacy-explanation" class="privacy-explanation" tw-class="mt-5 mx-auto max-w-lg text-left text-xs sm:text-sm leading-relaxed text-gray-600 dark:text-gray-300">
      <ul tw-class="space-y-4">
        <li tw-class="flex items-start gap-3">
          <CpuIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <div>
            <p tw-class="font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__runs_on_your_device() }}</p>
            <p tw-class="mt-0.5">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__inference_in_this_browser() }}</p>
          </div>
        </li>
        <li tw-class="flex items-start gap-3">
          <AppWindowIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <div>
            <p tw-class="font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__no_apps_or_servers() }}</p>
            <p tw-class="mt-0.5">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__browser_not_cloud_or_native_server() }}</p>
          </div>
        </li>
        <li tw-class="flex items-start gap-3">
          <DownloadIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <div>
            <p tw-class="font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__model_files_from_hugging_face() }}</p>
            <p tw-class="mt-0.5">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__model_files_are_downloaded() }}</p>
          </div>
        </li>
      </ul>
      <p tw-class="mt-4 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__tools_and_other_connections() }}</p>
    </div>
  </details>
</template>

<style scoped>
/* A one-time disclosure transition, never a pulsing privacy/safety claim. Native
   details keeps the closed content out of the accessibility and focus trees. */
details[open] .privacy-explanation {
  animation: privacy-reveal 180ms ease-out;
}
@keyframes privacy-reveal {
  from { opacity: 0; transform: translateY(-0.25rem); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  details[open] .privacy-explanation { animation: none; }
}
</style>
