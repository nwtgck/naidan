<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronDownIcon, LibraryBigIcon, ExternalLinkIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { matchesMemoryHint, modelSuggestions, moreGgufModelsUrl, suggestedMemoryFilters, type ModelSuggestion, type SuggestedMemoryFilter } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import LlamaCppBrowserModelSuggestion from './LlamaCppBrowserModelSuggestion.vue';
defineProps<{ models: LocalModel[], disabled: boolean, defaultModel: DefaultModelContext | undefined, defaultActionDisabled: boolean }>();
const emit = defineEmits<{ selectDefault: [model: LocalModel] }>();
const id = useId();
// The catalog is an entry point for both new and returning users. Start open,
// independently of local-storage readiness, and leave subsequent folding to the
// user. This presentation state must never trigger repository discovery.
const open = ref(true);
const memory = ref<SuggestedMemoryFilter>('all');
const queue = getDownloadQueue();
const activeCount = computed(() => queue.jobs.value.filter(job => job.source === 'suggestion' && jobIsBusy({ job })).length);
function toggle(): void {
  open.value = !open.value;
}
function visible({ suggestion }: { suggestion: ModelSuggestion }): boolean {
  // Memory chips are editorial text-model hints. Multimodal options must not
  // make the row disappear underneath the pointer; they can require more memory.
  // Keep running/paused rows visible so filtering never hides cancellation.
  return matchesMemoryHint({ suggestion, memory: memory.value, multimodal: 'off' }) || queue.jobs.value.some(job => job.key.startsWith(`suggestion:${suggestion.id}:`) && (jobIsBusy({ job }) || job.status === 'paused'));
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <!-- Privacy contract: the bundled list, filters, details and option changes
       never fetch external data. Only explicit preview/download/link actions do. -->
  <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 overflow-hidden" data-testid="llama-model-suggestions">
    <h3>
      <button type="button" :aria-expanded="open" :aria-controls="`${id}-content`" data-testid="llama-suggestions-toggle" tw-class="flex w-full items-center gap-2 px-4 py-3.5 text-sm font-bold text-gray-800 dark:text-white text-left hover:bg-gray-100/50 dark:hover:bg-gray-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-500 transition-colors" @click="toggle">
        <LibraryBigIcon tw-class="w-4 h-4 text-purple-500 shrink-0" />{{ lazyStrings.llamaCppBrowserDownloads__model_catalog() }}
        <span v-if="activeCount" tw-class="ml-auto text-[10px] font-medium text-purple-600 dark:text-purple-400">{{ lazyStrings.llamaCppBrowserDownloads__active_downloads({ count: activeCount }) }}</span>
        <ChevronDownIcon :tw-class="['w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none', { 'rotate-180': open, 'ml-auto': !activeCount }]" />
      </button>
    </h3>
    <!-- Remove inert when expanded: a serialized inert="false" is still inert. -->
    <div :id="`${id}-content`" class="suggestions-disclosure" :class="{ 'suggestions-disclosure-open': open }" :inert="open ? undefined : true" :aria-hidden="!open">
      <div class="suggestions-disclosure-inner">
        <div tw-class="px-4 pb-4 space-y-3">
          <div role="group" :aria-label="lazyStrings.llamaCppBrowserDownloads__memory()" tw-class="flex items-center flex-wrap gap-1.5" data-testid="llama-suggestions-memory">
            <span tw-class="mr-1 text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__memory() }}</span>
            <button v-for="choice in suggestedMemoryFilters" :key="choice" type="button" :data-testid="`llama-suggestions-memory-${choice}`" :aria-pressed="memory === choice" :tw-class="['px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500', memory === choice ? 'border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/40 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']" @click="memory = choice">{{ choice === 'all' ? lazyStrings.llamaCppBrowserDownloads__all() : `${choice} GiB` }}</button>
          </div>
          <ul tw-class="max-h-[28rem] overflow-y-auto overscroll-contain divide-y divide-gray-100 dark:divide-gray-800 pr-1" data-testid="llama-suggestions-list">
            <li v-for="suggestion in modelSuggestions" v-show="visible({ suggestion })" :key="suggestion.id">
              <LlamaCppBrowserModelSuggestion :suggestion="suggestion" :models="models" :disabled="disabled" :default-model="defaultModel" :default-action-disabled="defaultActionDisabled" @select-default="emit('selectDefault', $event)" />
            </li>
          </ul>
          <div tw-class="flex justify-end"><a :href="moreGgufModelsUrl" target="_blank" rel="noopener noreferrer" data-testid="llama-suggestions-find-more" tw-class="inline-flex items-center gap-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 hover:underline underline-offset-2">{{ lazyStrings.llamaCppBrowserDownloads__find_more() }}<ExternalLinkIcon tw-class="w-3 h-3" /></a></div>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.suggestions-disclosure { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 220ms ease, opacity 180ms ease; }
.suggestions-disclosure-open { grid-template-rows: 1fr; opacity: 1; }
.suggestions-disclosure-inner { min-height: 0; overflow: hidden; }
@media (prefers-reduced-motion: reduce) { .suggestions-disclosure { transition: none; } }
</style>
