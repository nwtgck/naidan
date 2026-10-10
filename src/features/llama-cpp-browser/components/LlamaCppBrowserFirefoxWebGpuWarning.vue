<script setup lang="ts">
import { useId } from 'vue';
import { InfoIcon, ChevronDownIcon, ExternalLinkIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const headingId = useId();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section data-testid="firefox-webgpu-warning" :aria-labelledby="headingId" tw-class="w-full max-w-xl mx-auto pointer-events-auto text-left border-t border-gray-200 dark:border-gray-800 pt-4">
    <!-- Like model recovery, this is supplemental welcome content, not an error
         card. Keep one flat surface and reserve color for actionable links. -->
    <div tw-class="flex items-start gap-3">
      <InfoIcon aria-hidden="true" tw-class="w-4 h-4 mt-1 shrink-0 text-gray-500 dark:text-gray-400" />
      <div tw-class="min-w-0 flex-1">
        <h3 :id="headingId" data-testid="firefox-webgpu-recommendation" tw-class="text-sm font-medium leading-relaxed text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserFirefoxWebGpuWarning__recommend_chromium_for_faster_performance() }}</h3>
        <p data-testid="firefox-webgpu-reason" tw-class="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserFirefoxWebGpuWarning__firefox_webgpu_can_slow_model_execution() }}</p>
        <!-- Retain the native disclosure and keyboard focus treatment used by
             image settings, without turning supporting sources into a card. -->
        <details data-testid="firefox-webgpu-details" tw-class="group mt-1 text-xs text-gray-500 dark:text-gray-400">
          <summary data-testid="firefox-webgpu-details-summary" tw-class="flex w-fit max-w-full min-h-11 items-center gap-1.5 rounded-md py-2 font-medium cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:text-gray-800 dark:hover:text-gray-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
            {{ lazyStrings.LlamaCppBrowserFirefoxWebGpuWarning__technical_details() }}
            <ChevronDownIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none group-open:rotate-180" />
          </summary>
          <div data-testid="firefox-webgpu-details-content" tw-class="pt-1 space-y-3 leading-relaxed">
            <p>{{ lazyStrings.LlamaCppBrowserFirefoxWebGpuWarning__mozilla_bug_reports_in_english() }}</p>
            <ul tw-class="space-y-3">
              <li tw-class="min-w-0 space-y-1">
                <a href="https://bugzilla.mozilla.org/show_bug.cgi?id=1870699" target="_blank" rel="noopener noreferrer" data-testid="firefox-webgpu-polling-link" tw-class="inline-flex max-w-full items-start gap-1.5 text-blue-600 dark:text-blue-400 underline underline-offset-4 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                  <span tw-class="min-w-0 [overflow-wrap:anywhere]">Bug 1870699 — Don't poll WebGPU from a timer</span>
                  <ExternalLinkIcon aria-hidden="true" tw-class="w-3 h-3 mt-0.5 shrink-0" />
                </a>
                <p>{{ lazyStrings.LlamaCppBrowserFirefoxWebGpuWarning__gpu_completion_timer_polling() }}</p>
              </li>
              <li tw-class="min-w-0 space-y-1">
                <a href="https://bugzilla.mozilla.org/show_bug.cgi?id=1900273" target="_blank" rel="noopener noreferrer" data-testid="firefox-webgpu-readback-link" tw-class="inline-flex max-w-full items-start gap-1.5 text-blue-600 dark:text-blue-400 underline underline-offset-4 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">
                  <span tw-class="min-w-0 [overflow-wrap:anywhere]">Bug 1900273 — await mapAsync slow</span>
                  <ExternalLinkIcon aria-hidden="true" tw-class="w-3 h-3 mt-0.5 shrink-0" />
                </a>
                <p>{{ lazyStrings.LlamaCppBrowserFirefoxWebGpuWarning__gpu_readback_latency_report() }}</p>
              </li>
            </ul>
          </div>
        </details>
      </div>
    </div>
  </section>
</template>
