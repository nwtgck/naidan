<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { computed, ref, useId } from 'vue';
import { ChevronDownIcon, LibraryBigIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { preferredQuantizationHint, matchesMemoryHint, modelSuggestions, suggestedMemoryFilters, type ModelSuggestion, type SuggestedMemoryFilter } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import LlamaCppBrowserModelSuggestion from './LlamaCppBrowserModelSuggestion.vue';
const props = defineProps<{ models: LocalModel[], disabled: boolean, defaultModel: DefaultModelContext | undefined, defaultActionDisabled: boolean, suggestions?: readonly ModelSuggestion[], selectionAction?: 'default' | 'select', memoryFilter?: 'show' | 'hide', createChatGroup?: ({ model }: { model: LocalModel }) => Promise<void>, creatingChatGroupModelId?: string }>();
const emit = defineEmits<{ selectDefault: [model: LocalModel], select: [model: LocalModel], changed: [] }>();
const entries = computed(() => props.suggestions ?? modelSuggestions);
const id = useId();
// The catalog is an entry point for both new and returning users. Start open,
// independently of local-storage readiness, and leave subsequent folding to the
// user. This presentation state must never trigger repository discovery.
const open = ref(true);
const memory = ref<SuggestedMemoryFilter>('all');
const queue = getDownloadQueue();
const downloadDestination = useModelDownloadDestination({ blocked: () => props.disabled, changed: () => emit('changed') });
const { destination, unavailable: destinationUnavailable, revision: destinationRevision, failure: destinationFailure } = downloadDestination;
const activeCount = computed(() => queue.jobs.value.filter(job => job.source === 'suggestion' && jobIsBusy({ job }) && entries.value.some(entry => job.key.startsWith(`suggestion:${entry.id}:`))).length);

function toggle(): void {
  open.value = !open.value;
}

function visible({ suggestion }: { suggestion: ModelSuggestion }): boolean {
  // Memory chips are editorial text-model hints. Neither multimodal options
  // nor quantization choices should hide the row underneath the pointer.
  // Filter by the preferred text choice; other choices can require more memory.
  // Keep running/paused rows visible so filtering never hides cancellation.
  return props.memoryFilter === 'hide' || matchesMemoryHint({ quantization: preferredQuantizationHint({ suggestion }), memory: memory.value, multimodal: 'off' }) || queue.jobs.value.some(job => job.key.startsWith(`suggestion:${suggestion.id}:`) && (jobIsBusy({ job }) || job.status === 'paused'));
}

const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <!-- Privacy contract: the bundled list, filters, details and option changes
       never fetch external data. Only explicit preview/download/link actions do. -->
  <section tw-class="overflow-hidden rounded-xl border border-gray-200/70 bg-gray-50/40 dark:border-gray-800/80 dark:bg-gray-900/20" data-testid="llama-model-suggestions">
    <h3>
      <button type="button" :aria-expanded="open" :aria-controls="`${id}-content`" data-testid="llama-suggestions-toggle" :tw-class="['group flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-gray-700 transition-colors duration-200 hover:bg-gray-100/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 dark:hover:bg-gray-800/40 motion-reduce:transition-none', isSettingsTypography ? 'dark:text-gray-300' : 'dark:text-gray-200']" @click="toggle">
        <span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><LibraryBigIcon aria-hidden="true" tw-class="h-4 w-4" /></span>{{ lazyStrings.llamaCppBrowserDownloads__model_catalog() }}
        <span v-if="activeCount" :tw-class="['ml-auto font-medium text-blue-600 dark:text-blue-400', isSettingsTypography ? 'text-xs' : 'text-[10px]']">{{ lazyStrings.llamaCppBrowserDownloads__active_downloads({ count: activeCount }) }}</span>
        <ChevronDownIcon :tw-class="['w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none', { 'rotate-180': open, 'ml-auto': !activeCount }]" />
      </button>
    </h3>
    <!-- Remove inert when expanded: a serialized inert="false" is still inert. -->
    <div :id="`${id}-content`" class="suggestions-disclosure" :class="{ 'suggestions-disclosure-open': open }" :inert="open ? undefined : true" :aria-hidden="!open">
      <div class="suggestions-disclosure-inner">
        <div tw-class="px-4 pb-4 space-y-3">
          <p v-if="destinationFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
          <div tw-class="grid grid-cols-1 items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div v-if="memoryFilter !== 'hide'" role="group" :aria-label="lazyStrings.llamaCppBrowserDownloads__memory()" tw-class="flex items-center flex-wrap gap-1.5" data-testid="llama-suggestions-memory">
              <span tw-class="mr-1 text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__memory() }}</span>
              <button v-for="choice in suggestedMemoryFilters" :key="choice" type="button" :data-testid="`llama-suggestions-memory-${choice}`" :aria-pressed="memory === choice" :tw-class="[['rounded-md border px-2 py-1 font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 motion-reduce:transition-none', isSettingsTypography ? 'text-xs' : 'text-[11px]'], memory === choice ? 'border-blue-200/80 bg-blue-50/70 text-blue-600 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400' : 'border-gray-200/80 bg-white/70 text-gray-500 hover:bg-gray-100 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-400 dark:hover:bg-gray-800']" @click="memory = choice">{{ choice === 'all' ? lazyStrings.llamaCppBrowserDownloads__all() : `${choice} GiB` }}</button>
            </div>
            <LlamaCppBrowserDownloadDestination :view="downloadDestination.view" :disabled="disabled" />
          </div>
          <ul tw-class="max-h-[28rem] space-y-2 overflow-y-auto overscroll-contain pr-1" data-testid="llama-suggestions-list">
            <li v-for="suggestion in entries" v-show="visible({ suggestion })" :key="suggestion.id">
              <LlamaCppBrowserModelSuggestion :suggestion="suggestion" :models="models" :destination="destination" :destination-unavailable="destinationUnavailable" :destination-revision="destinationRevision" :authorize-destination="downloadDestination.authorize" :destination-label="downloadDestination.label" :disabled="disabled" :default-model="defaultModel" :default-action-disabled="defaultActionDisabled" :selection-action="selectionAction" :create-chat-group="createChatGroup" :creating-chat-group-model-id="creatingChatGroupModelId" @select-default="emit('selectDefault', $event)" @select="emit('select', $event)" />
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.suggestions-disclosure {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 220ms ease, opacity 180ms ease;
}
.suggestions-disclosure-open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.suggestions-disclosure-inner {
  min-height: 0;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .suggestions-disclosure {
    transition: none;
  }
}
</style>
