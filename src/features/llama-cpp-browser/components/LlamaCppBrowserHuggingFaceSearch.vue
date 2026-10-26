<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { ArrowRightIcon, ChevronDownIcon, ClockIcon, CpuIcon, DownloadIcon, ExternalLinkIcon, HeartIcon, LayersIcon, Loader2Icon, RefreshCwIcon, SearchIcon, SlidersHorizontalIcon, TrendingUpIcon, WorkflowIcon } from 'lucide-vue-next';
import { createSearchParameterFilter, searchModels, type ModelSearchResult } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { formatSearchUpdated } from '@/features/llama-cpp-browser/hugging-face/search-updated';
import { repositoryUrlPath } from '@/features/llama-cpp-browser/hugging-face/types';
import { currentLocale, lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';

const props = defineProps<{ disabled: boolean, repositoryInput: string, scrollOwner: 'results' | 'parent' }>();
const emit = defineEmits<{ select: [repository: string], busy: [value: boolean] }>();
const id = useId();
const query = ref('');
const filtersOpen = ref(false);
const minimumBillions = ref('');
const maximumBillions = ref('');
const filterError = ref(false);
const resultNumParameters = ref<string>();
const resultQuery = ref('');
const results = shallowRef<ModelSearchResult[]>([]);
const status = ref<'idle' | 'searching' | 'ready' | 'failed' | 'loading-more' | 'more-failed'>('idle');
const active = shallowRef<AbortController>();
const nextCursor = ref<string>();
const visitedCursors = new Set<string>();
const latestBatchStartId = ref<string>();
const displayResults = computed(() => {
  const now = Date.now();
  return results.value.map(result => ({ ...result, updated: result.lastModified === undefined ? undefined : formatSearchUpdated({ lastModified: result.lastModified, now, locale: currentLocale.value }) }));
});
let disposed = false;
const parameterFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const draftNumParameters = computed(() => {
  try {
    return createSearchParameterFilter({ minimumBillions: minimumBillions.value, maximumBillions: maximumBillions.value });
  } catch {
    return undefined;
  }
});
const draftParameterSummary = computed(() => parameterSummary({ filter: draftNumParameters.value }));
const parameterPresets = computed(() => [
  { minimumBillions: '', maximumBillions: '1', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__up_to_parameters({ count: '1' }) },
  { minimumBillions: '1', maximumBillions: '4', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters_between({ minimum: '1', maximum: '4' }) },
  { minimumBillions: '4', maximumBillions: '8', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters_between({ minimum: '4', maximum: '8' }) },
  { minimumBillions: '8', maximumBillions: '16', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters_between({ minimum: '8', maximum: '16' }) },
  { minimumBillions: '16', maximumBillions: '32', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters_between({ minimum: '16', maximum: '32' }) },
  { minimumBillions: '32', maximumBillions: '70', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters_between({ minimum: '32', maximum: '70' }) },
  { minimumBillions: '70', maximumBillions: '128', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters_between({ minimum: '70', maximum: '128' }) },
  { minimumBillions: '128', maximumBillions: '', label: lazyStrings.LlamaCppBrowserHuggingFaceSearch__at_least_parameters({ count: '128' }) },
]);

function setParameterPreset({ minimumBillions: minimum, maximumBillions: maximum }: { minimumBillions: string, maximumBillions: string }): void {
  minimumBillions.value = minimum;
  maximumBillions.value = maximum;
}

function parameterSummary({ filter }: { filter: string | undefined }): string | undefined {
  const minimum = filter?.match(/min:([^B]+)B/)?.[1];
  const maximum = filter?.match(/max:([^B]+)B/)?.[1];
  if (minimum !== undefined && maximum !== undefined) {
    return `${minimum}–${maximum}B`;
  }
  return minimum !== undefined ? `≥${minimum}B` : maximum !== undefined ? `≤${maximum}B` : undefined;
}

function parameterCount({ model }: { model: ModelSearchResult }): number | undefined {
  return model.gguf?.total ?? model.safetensors?.total;
}

function formatParameterCount({ model }: { model: ModelSearchResult }): string | undefined {
  const count = parameterCount({ model });
  return count === undefined ? undefined : parameterFormatter.format(count);
}

function reset(): void {
  const previous = active.value;
  active.value = undefined;
  previous?.abort();
  results.value = [];
  resultQuery.value = '';
  nextCursor.value = undefined;
  visitedCursors.clear();
  latestBatchStartId.value = undefined;
  resultNumParameters.value = undefined;
  filterError.value = false;
  status.value = 'idle';
}

function cancelPending(): void {
  if (active.value) {
    switch (status.value) {
    case 'loading-more':
      cancelMore();
      break;
    case 'idle': case 'searching': case 'ready': case 'failed': case 'more-failed':
      reset();
      break;
    default: {
      const exhaustive: never = status.value;
      throw new Error(String(exhaustive));
    }
    }
  }
}

watch([query, minimumBillions, maximumBillions], () => {
  filterError.value = false;
  cancelPending();
}, { flush: 'sync' });
watch([() => props.repositoryInput, () => props.disabled], cancelPending, { flush: 'sync' });
watch(active, controller => emit('busy', controller !== undefined), { immediate: true, flush: 'sync' });

async function submit(): Promise<void> {
  if (props.disabled || disposed || (active.value && status.value !== 'loading-more')) {
    return;
  }
  let submittedNumParameters: string | undefined;
  try {
    submittedNumParameters = createSearchParameterFilter({ minimumBillions: minimumBillions.value, maximumBillions: maximumBillions.value });
  } catch {
    filterError.value = true;
    return;
  }
  reset();
  const controller = new AbortController();
  active.value = controller;
  results.value = [];
  status.value = 'searching';
  const submittedQuery = query.value;
  const isCurrent = () => active.value === controller && !controller.signal.aborted && !disposed;
  try {
    const found = await searchModels({ query: submittedQuery, cursor: undefined, numParameters: submittedNumParameters, signal: controller.signal });
    if (isCurrent()) {
      results.value = found.results;
      resultQuery.value = submittedQuery.trim();
      resultNumParameters.value = submittedNumParameters;
      nextCursor.value = found.nextCursor;
      status.value = 'ready';
    }
  } catch {
    if (isCurrent()) {
      status.value = 'failed';
    }
  } finally {
    if (isCurrent()) {
      active.value = undefined;
    }
  }
}

function cancelMore(): void {
  const previous = active.value;
  active.value = undefined;
  previous?.abort();
  status.value = 'ready';
}

async function loadMore(): Promise<void> {
  const cursor = nextCursor.value;
  if (props.disabled || disposed || active.value || cursor === undefined) {
    return;
  }
  const controller = new AbortController();
  active.value = controller;
  status.value = 'loading-more';
  const isCurrent = () => active.value === controller && !controller.signal.aborted && !disposed;
  try {
    const page = await searchModels({ query: resultQuery.value, cursor, numParameters: resultNumParameters.value, signal: controller.signal });
    if (isCurrent()) {
      const previousIds = new Set(results.value.map(result => result.id));
      const firstNewId = page.results.find(result => !previousIds.has(result.id))?.id;
      if (firstNewId !== undefined) {
        latestBatchStartId.value = firstNewId;
      }
      results.value = [...new Map([...results.value, ...page.results].map(result => [result.id, result])).values()];
      visitedCursors.add(cursor);
      nextCursor.value = page.nextCursor !== undefined && !visitedCursors.has(page.nextCursor) ? page.nextCursor : undefined;
      status.value = 'ready';
    }
  } catch {
    if (isCurrent()) {
      status.value = 'more-failed';
    }
  } finally {
    if (isCurrent()) {
      active.value = undefined;
    }
  }
}

function select({ repository }: { repository: string }): void {
  if (props.disabled || active.value || disposed || !results.value.some(result => result.id === repository)) {
    return;
  }
  emit('select', repository);
}

function submitFromKeyboard({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing || event.keyCode === 229 || event.which === 229) {
    return;
  }
  event.preventDefault();
  void submit();
}

onUnmounted(() => {
  disposed = true;
  reset();
});
defineExpose({
  cancelPending,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div role="search" :aria-labelledby="`${id}-label`" data-testid="llama-hf-search" :aria-busy="active !== undefined" tw-class="space-y-2">
    <div data-testid="llama-hf-search-controls" :tw-class="['space-y-2', scrollOwner === 'parent' ? 'sticky top-0 z-10 -mx-1 border-b border-gray-100 bg-white/95 px-1 pb-2 pt-1 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/95' : '']">
      <div tw-class="flex flex-wrap items-center justify-between gap-2">
        <label :id="`${id}-label`" :for="`${id}-query`" tw-class="block text-xs font-semibold text-gray-600 dark:text-gray-300">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__find_models_on_hugging_face() }}</label>
        <button type="button" data-testid="llama-hf-search-filter-toggle" :disabled="disabled" :aria-expanded="filtersOpen" :aria-controls="`${id}-filters`" tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50" @click="filtersOpen = !filtersOpen"><SlidersHorizontalIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0" />{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__filters() }}<span v-if="draftParameterSummary" tw-class="text-blue-600 dark:text-blue-400">{{ draftParameterSummary }}</span></button>
      </div>
      <div tw-class="flex flex-col sm:flex-row gap-2">
        <input :id="`${id}-query`" v-model="query" :disabled="disabled" maxlength="200" data-testid="llama-hf-search-query" :placeholder="lazyStrings.LlamaCppBrowserHuggingFaceSearch__search_by_model_name_or_leave_blank_for_trends()" tw-class="min-w-0 flex-1 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all disabled:opacity-50" @keydown.enter="submitFromKeyboard({ event: $event })" />
        <LlamaCppBrowserModelActionButton :disabled="disabled || status === 'searching'" data-testid="llama-hf-search-submit" size="regular" tw-class="shrink-0" @click="submit"><Loader2Icon v-if="status === 'searching'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 dark:text-blue-400 motion-reduce:animate-none" /><SearchIcon v-else-if="query.trim()" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><TrendingUpIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ query.trim() ? lazyStrings.LlamaCppBrowserHuggingFaceSearch__search() : lazyStrings.LlamaCppBrowserHuggingFaceSearch__show_trending_models() }}</LlamaCppBrowserModelActionButton>
      </div>
    </div>
    <!-- Only the search controls stay sticky; expanded guidance scrolls with the parent content. -->
    <CspMessageHint v-if="status !== 'failed' && status !== 'more-failed'" :target="{ kind: 'huggingface-metadata' }" activity-for-display-only="model-search" presentation="compact" />
    <fieldset v-if="filtersOpen" :id="`${id}-filters`" :disabled="disabled" tw-class="min-w-0 space-y-2">
      <legend tw-class="mb-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameter_count_in_billions() }}</legend>
      <div tw-class="flex min-w-0 items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 focus-within:ring-2 focus-within:ring-blue-500/40">
        <div tw-class="min-w-0 flex-1"><label :for="`${id}-minimum`" tw-class="block text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__at_least() }}</label><input :id="`${id}-minimum`" v-model="minimumBillions" type="text" inputmode="decimal" :disabled="disabled" :aria-label="lazyStrings.LlamaCppBrowserHuggingFaceSearch__minimum_parameters_in_billions()" :aria-invalid="filterError" :aria-describedby="filterError ? `${id}-filter-error` : undefined" :placeholder="lazyStrings.LlamaCppBrowserHuggingFaceSearch__no_minimum()" data-testid="llama-hf-search-minimum" tw-class="w-full min-w-0 bg-transparent py-1 text-xs text-gray-800 dark:text-gray-100 outline-none disabled:opacity-50" /></div>
        <span aria-hidden="true" tw-class="shrink-0 text-xs text-gray-400">–</span>
        <div tw-class="min-w-0 flex-1"><label :for="`${id}-maximum`" tw-class="block text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__at_most() }}</label><input :id="`${id}-maximum`" v-model="maximumBillions" type="text" inputmode="decimal" :disabled="disabled" :aria-label="lazyStrings.LlamaCppBrowserHuggingFaceSearch__maximum_parameters_in_billions()" :aria-invalid="filterError" :aria-describedby="filterError ? `${id}-filter-error` : undefined" :placeholder="lazyStrings.LlamaCppBrowserHuggingFaceSearch__no_maximum()" data-testid="llama-hf-search-maximum" tw-class="w-full min-w-0 bg-transparent py-1 text-xs text-gray-800 dark:text-gray-100 outline-none disabled:opacity-50" /></div>
      </div>
      <div tw-class="flex flex-wrap gap-1.5">
        <button v-for="preset in parameterPresets" :key="`${preset.minimumBillions}:${preset.maximumBillions}`" type="button" data-testid="llama-hf-search-preset" :disabled="disabled" :aria-pressed="draftNumParameters === createSearchParameterFilter({ minimumBillions: preset.minimumBillions, maximumBillions: preset.maximumBillions })" :tw-class="['rounded-full px-2 py-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50', draftNumParameters === createSearchParameterFilter({ minimumBillions: preset.minimumBillions, maximumBillions: preset.maximumBillions }) ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']" @click="setParameterPreset({ minimumBillions: preset.minimumBillions, maximumBillions: preset.maximumBillions })">{{ preset.label }}</button>
        <button type="button" data-testid="llama-hf-search-clear-parameters" :disabled="disabled" :aria-pressed="minimumBillions.trim() === '' && maximumBillions.trim() === ''" :tw-class="['rounded-full px-2 py-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50', minimumBillions.trim() === '' && maximumBillions.trim() === '' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']" @click="setParameterPreset({ minimumBillions: '', maximumBillions: '' })">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__no_parameter_limit() }}</button>
      </div>
    </fieldset>
    <p v-if="filterError" :id="`${id}-filter-error`" role="alert" data-testid="llama-hf-search-filter-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__enter_a_valid_parameter_range() }}</p>
    <div v-if="status === 'searching'" role="status" tw-class="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
      <span tw-class="inline-flex items-center gap-2"><Loader2Icon aria-hidden="true" tw-class="w-4 h-4 animate-spin shrink-0" />{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__searching_models() }}</span>
      <button type="button" data-testid="llama-hf-search-cancel" tw-class="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800" @click="reset">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <p v-else-if="status === 'failed'" role="alert" data-testid="llama-hf-search-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__could_not_search_models_try_again() }}</p>
    <p v-else-if="status === 'ready' && !results.length" role="status" data-testid="llama-hf-search-empty" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__no_models_found() }}</p>
    <CspMessageHint v-if="status === 'failed'" :target="{ kind: 'huggingface-metadata' }" activity-for-display-only="model-search" presentation="error" />
    <div v-if="results.length" tw-class="space-y-2">
      <p v-if="resultQuery || resultNumParameters" data-testid="llama-hf-search-result-query" tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200"><span v-if="resultQuery">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__results_for({ query: resultQuery }) }}</span><span v-if="resultNumParameters" tw-class="font-normal text-gray-500 dark:text-gray-400">{{ resultQuery ? ' · ' : '' }}{{ parameterSummary({ filter: resultNumParameters }) }}</span></p>
      <p tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__select_a_repository_to_check_model_files() }}</p>
      <!-- Embedded panels already own scrolling; a second bounded list would
           itself be clipped by that parent, requiring two scroll gestures. -->
      <ul data-testid="llama-hf-search-results" :tw-class="['space-y-2', scrollOwner === 'results' ? 'max-h-64 overflow-y-auto overscroll-contain' : '']">
        <li v-for="result in displayResults" :key="result.id">
          <div v-if="result.id === latestBatchStartId" data-testid="llama-hf-search-new-results" tw-class="mb-1 mt-2 border-t border-gray-200 dark:border-gray-700 pt-2 text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__new_results_start_here() }}</div>
          <div tw-class="flex min-w-0 items-start rounded-xl border border-gray-200/70 bg-white/60 transition-[background-color,border-color] duration-200 hover:border-gray-300/80 hover:bg-gray-50/80 focus-within:border-blue-300/70 dark:border-gray-800/80 dark:bg-gray-900/20 dark:hover:border-gray-700/80 dark:hover:bg-gray-800/30 dark:focus-within:border-blue-500/40 motion-reduce:transition-none">
            <button type="button" :disabled="disabled || active !== undefined" data-testid="llama-hf-search-result" :tw-class="['group/select flex min-w-0 flex-1 items-start gap-3 rounded-xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed', scrollOwner === 'parent' ? 'scroll-mt-36' : '']" @click="select({ repository: result.id })">
              <span tw-class="flex min-w-0 flex-1 flex-col gap-1.5">
                <span :title="result.id" tw-class="line-clamp-2 min-w-0 break-all text-[13px] font-semibold leading-5 text-gray-700 transition-colors duration-200 group-hover/select:text-gray-900 group-focus-visible/select:text-gray-900 dark:text-gray-200 dark:group-hover/select:text-gray-100 dark:group-focus-visible/select:text-gray-100 motion-reduce:transition-none">{{ result.id }}</span>
                <span v-if="result.pipeline_tag || parameterCount({ model: result }) !== undefined || result.gguf?.architecture || result.updated || result.downloads !== undefined || result.likes !== undefined" tw-class="inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] leading-4 text-gray-500 dark:text-gray-400 tabular-nums">
                  <span v-if="result.pipeline_tag" :title="lazyStrings.LlamaCppBrowserHuggingFaceSearch__task()" data-testid="llama-hf-search-result-task" tw-class="inline-flex min-w-0 max-w-full items-center gap-1"><WorkflowIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0" /><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__task() }}: </span><span tw-class="break-all">{{ result.pipeline_tag }}</span></span>
                  <span v-if="parameterCount({ model: result }) !== undefined" :title="lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters()" data-testid="llama-hf-search-result-parameters" tw-class="inline-flex items-center gap-1 font-medium text-gray-600 dark:text-gray-300"><CpuIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0 text-blue-500/70 dark:text-blue-400/70" /><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__parameters() }}: </span>{{ formatParameterCount({ model: result }) }}</span>
                  <span v-if="result.gguf?.architecture" :title="lazyStrings.LlamaCppBrowserHuggingFaceSearch__architecture()" data-testid="llama-hf-search-result-architecture" tw-class="inline-flex min-w-0 max-w-full items-center gap-1"><LayersIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0" /><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__architecture() }}: </span><span tw-class="break-all">{{ result.gguf.architecture }}</span></span>
                  <time v-if="result.updated" :datetime="result.updated.datetime" :title="result.updated.title" data-testid="llama-hf-search-result-updated" tw-class="inline-flex items-center gap-1"><ClockIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0" />{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__updated({ time: result.updated.label }) }}</time>
                  <span v-if="result.downloads !== undefined" :title="lazyStrings.LlamaCppBrowserHuggingFaceSearch__downloads()" tw-class="inline-flex items-center gap-1"><DownloadIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0" /><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__downloads() }}: </span>{{ result.downloads.toLocaleString() }}</span>
                  <span v-if="result.likes !== undefined" :title="lazyStrings.LlamaCppBrowserHuggingFaceSearch__likes()" tw-class="inline-flex items-center gap-1"><HeartIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0" /><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__likes() }}: </span>{{ result.likes.toLocaleString() }}</span>
                </span>
              </span>
              <ArrowRightIcon aria-hidden="true" tw-class="mt-1 h-3.5 w-3.5 shrink-0 text-gray-300 transition-[color,transform] duration-200 group-hover/select:translate-x-0.5 group-hover/select:text-blue-500 group-focus-visible/select:translate-x-0.5 group-focus-visible/select:text-blue-500 dark:text-gray-600 dark:group-hover/select:text-blue-400 dark:group-focus-visible/select:text-blue-400 motion-reduce:transform-none motion-reduce:transition-none" />
            </button>
            <a :href="`https://huggingface.co/${repositoryUrlPath({ repository: result.id })}`" target="_blank" rel="noopener noreferrer" :title="lazyStrings.LlamaCppBrowserHuggingFaceSearch__open_repository_on_hugging_face({ repository: result.id })" :aria-label="lazyStrings.LlamaCppBrowserHuggingFaceSearch__open_repository_on_hugging_face({ repository: result.id })" data-testid="llama-hf-search-repository-link" tw-class="mr-2 mt-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors duration-200 hover:bg-gray-100/80 hover:text-blue-500 focus-visible:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-blue-400 dark:focus-visible:text-blue-400 motion-reduce:transition-none"><ExternalLinkIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></a>
          </div>
        </li>
      </ul>
    </div>
    <div v-if="nextCursor !== undefined" tw-class="flex items-center gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
      <button type="button" data-testid="llama-hf-search-more" :disabled="disabled || active !== undefined" :aria-busy="status === 'loading-more'" :aria-describedby="status === 'more-failed' ? `${id}-more-error` : undefined" tw-class="group inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-gray-500 transition-colors duration-200 hover:bg-gray-50 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-100 motion-reduce:transition-none" @click="loadMore">{{ status === 'loading-more' ? lazyStrings.LlamaCppBrowserHuggingFaceSearch__loading_more_models() : status === 'more-failed' ? lazyStrings.llamaCppBrowserDownloads__retry() : lazyStrings.LlamaCppBrowserHuggingFaceSearch__show_more() }}<Loader2Icon v-if="status === 'loading-more'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 dark:text-blue-400 motion-reduce:animate-none" /><RefreshCwIcon v-else-if="status === 'more-failed'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><ChevronDownIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-[color,transform] duration-200 group-hover:translate-y-0.5 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transform-none motion-reduce:transition-none" /></button>
      <button v-if="status === 'loading-more'" type="button" data-testid="llama-hf-search-more-cancel" tw-class="rounded-lg px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" @click="cancelMore">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <!-- Keep the retry action in place when the failure message appears. -->
    <p v-if="status === 'more-failed'" :id="`${id}-more-error`" role="alert" data-testid="llama-hf-search-more-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__could_not_load_more_models_try_again() }}</p>
    <CspMessageHint v-if="status === 'more-failed'" :target="{ kind: 'huggingface-metadata' }" activity-for-display-only="model-search" presentation="error" />
  </div>
</template>
