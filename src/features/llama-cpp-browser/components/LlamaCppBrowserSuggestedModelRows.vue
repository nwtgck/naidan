<script setup lang="ts">
import type { DownloadDestination } from '@/01-models/download';
import { lazyStrings } from '@/strings';
import { computed, ref } from 'vue';
import { SearchIcon } from 'lucide-vue-next';
import ModelSelectorRepositoryRow from '@/components/ModelSelectorRepositoryRow.vue';
import type { RepositoryModelDownloadRequest } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import ModelSelectorVariantDownload from '@/components/ModelSelectorVariantDownload.vue';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { modelSuggestions, type ModelSuggestion } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

const props = defineProps<{
  disabled: boolean,
  expandedRepository?: { repository: string },
  immediateSelection?: boolean,
  downloadDisabled: boolean,
  destinationLabel: ({ destination }: { destination: DownloadDestination }) => string,
  refreshInventory?: () => Promise<void>,
  describeCandidate({ candidate }: { candidate: ModelSuggestion }): { quantization: string, bytes: number, selected: boolean, download: RepositoryModelDownloadRequest | undefined, status: string | undefined },
}>();
const emit = defineEmits<{ select: [id: string, source: 'result'], choose: [id: string] }>();
const root = ref<HTMLElement>();
const query = ref('');
const candidates = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/);
  return modelSuggestions
    .filter(model => words.every(word => (model.name + ' ' + model.developer).toLowerCase().includes(word)))
    .map(candidate => ({ ...candidate, ...props.describeCandidate({ candidate }) }));
});

function focusOrigin({ repository }: { repository: string }): void {
  const row = Array.from(root.value?.querySelectorAll<HTMLButtonElement>('[data-repository]') ?? []).find(button => button.dataset.repository === repository);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView?.({ block: 'nearest' });
}

defineExpose({ focusOrigin, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section ref="root" tw-class="space-y-2">
    <div tw-class="sticky top-0 z-10 bg-[var(--model-selector-panel-background,var(--color-white))] pt-4 pb-2 dark:bg-[var(--model-selector-panel-background,var(--color-gray-900))]">
      <div tw-class="relative">
        <SearchIcon aria-hidden="true" tw-class="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input v-model="query" type="search" autocomplete="off" :aria-label="lazyStrings.LlamaCppBrowserSuggestedModelRows__filter()" :placeholder="lazyStrings.LlamaCppBrowserSuggestedModelRows__placeholder()" tw-class="h-9 w-full rounded-lg border border-gray-200 bg-white pe-2 ps-8 text-xs text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-300" />
      </div>
    </div>
    <ul v-if="candidates.length" tw-class="divide-y divide-gray-100 dark:divide-gray-800">
      <ModelSelectorRepositoryRow v-for="candidate in candidates" :key="candidate.id" :row-id="candidate.id" :disabled="disabled" :expanded="expandedRepository?.repository === candidate.id" :choose-label="immediateSelection ? candidate.name : undefined" :checked="candidate.selected && immediateSelection === true" :download-status="candidate.status" test-id="chat-model-suggestion" @toggle="emit('select', candidate.id, 'result')" @choose="emit('choose', candidate.id)">
        <span tw-class="block break-words font-medium">{{ candidate.name }}</span>
        <span tw-class="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-gray-500 dark:text-gray-400"><span>{{ candidate.developer }}</span><span tw-class="tabular-nums">{{ lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes: candidate.bytes }) }) }}</span><span>{{ candidate.quantization }}</span></span>
        <template v-if="immediateSelection && candidate.download" #actions>
          <ModelSelectorVariantDownload :destination-label="destinationLabel" :request="candidate.download" :label="candidate.name + ' ' + candidate.quantization" :disabled="downloadDisabled" :refresh-inventory="refreshInventory" />
        </template>
        <template #configuration><slot name="repository" /></template>
      </ModelSelectorRepositoryRow>
    </ul>
    <p v-else tw-class="px-1 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelector__no_models_found() }}</p>
  </section>
</template>
