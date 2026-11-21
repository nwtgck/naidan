<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, watch } from 'vue';
import { FolderSearchIcon, Loader2Icon, SearchIcon, SlidersHorizontalIcon, TrendingUpIcon } from 'lucide-vue-next';
import { searchGgufModels } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { createSearchParameterFilter } from '@/features/llama-cpp-browser/hugging-face/parameter-filter';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { huggingFaceUrl } from '@/features/llama-cpp-browser/hugging-face/search-input';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import LlamaCppBrowserModelParameterFilter from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelParameterFilter.vue';
import { lazyStrings } from '@/strings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import ModelSelectorRepositoryRow from '@/components/ModelSelectorRepositoryRow.vue';
import { useHuggingFaceModelSearchPreferences } from '@/composables/useHuggingFaceModelSearchPreferences';
import { useModelSelectorHuggingFaceSearchState } from '@/composables/useModelSelectorHuggingFaceSearchState';

type RepositorySource = 'url' | 'result';
const props = defineProps<{ query: string, active: boolean, disabled: boolean, expandedRepository?: { repository: string, source: RepositorySource }, immediateSelection?: boolean, selectedRepository?: string, choosingRepository?: string }>();
const emit = defineEmits<{ 'update:query': [value: string], select: [repository: string, source: RepositorySource], choose: [repository: string], search: [] }>();
defineSlots<{ repository(): unknown, 'result-actions'({ repository }: { repository: string }): unknown }>();
const id = useId();
const { autoSearch, saving, saveFailed, setAutoSearch } = useHuggingFaceModelSearchPreferences();
const root = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const { results, resultSearch, nextCursor, latestBatchStartId, visitedCursors, filtersOpen, minimumBillions, maximumBillions } = useModelSelectorHuggingFaceSearchState();
const status = ref<'idle' | 'searching' | 'loading-more' | 'ready' | 'failed' | 'invalid-repository'>(resultSearch.value === undefined ? 'idle' : 'ready');
const busy = computed(() => status.value === 'searching' || status.value === 'loading-more');
const filterError = ref(false);
const hasParameterDraft = computed(() => Boolean(minimumBillions.value.trim() || maximumBillions.value.trim()));
const repositoryInput = computed(() => isRepositoryInput({ query: props.query.trim() }));
const searchAction = computed(() => repositoryInput.value ? 'open' : props.query.trim() || hasParameterDraft.value ? 'search' : 'trending');
const appliedParameters = computed(() => resultSearch.value?.numParameters?.split(',').map(bound => bound.replace(/^min:/, '≥ ').replace(/^max:/, '≤ ')) ?? []);
const formatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const displayResults = computed(() => results.value.map(model => {
  const count = model.gguf?.total ?? model.safetensors?.total;
  return { model, parameters: count === undefined ? undefined : formatter.format(count) };
}));
let pending: AbortController | undefined;
let pendingIsAutomatic = false;
let autoTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

function clearAutoTimer(): void {
  clearTimeout(autoTimer);
  autoTimer = undefined;
}

function cancelPending(): void {
  const previous = pending;
  pending = undefined;
  pendingIsAutomatic = false;
  previous?.abort();
  if (previous !== undefined) {
    status.value = resultSearch.value === undefined ? 'idle' : 'ready';
  }
}

// The incoming value can be text typed in the local inventory. Only edits
// originating in this Hugging Face input may schedule an automatic request.
watch(() => props.query, cancelPending, { flush: 'sync' });
watch([minimumBillions, maximumBillions], () => {
  clearAutoTimer();
  filterError.value = false;
  cancelPending();
}, { flush: 'sync' });
watch(() => props.active && !props.disabled, enabled => {
  if (!enabled) {
    clearAutoTimer();
    cancelPending();
  }
}, { flush: 'sync' });
watch(autoSearch, enabled => {
  if (!enabled) {
    stopAutomaticSearch();
  }
}, { flush: 'sync' });
onScopeDispose(() => {
  disposed = true;
  clearAutoTimer();
  cancelPending();
});

function stopAutomaticSearch(): void {
  clearAutoTimer();
  if (pendingIsAutomatic) {
    cancelPending();
  }
}

function toggleAutoSearch(): void {
  if (autoSearch.value) {
    stopAutomaticSearch();
  }
  void setAutoSearch({ enabled: !autoSearch.value });
}

function updateQuery({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const query = event.target.value;
  emit('update:query', query);
  clearAutoTimer();
  if (!autoSearch.value || !props.active || props.disabled || saving.value || isRepositoryInput({ query: query.trim() }) || ('isComposing' in event && event.isComposing)) {
    return;
  }
  autoTimer = setTimeout(() => {
    autoTimer = undefined;
    if (autoSearch.value && !saving.value && props.query === query) {
      void runSearch({ automatic: true });
    }
  }, 400);
}

function isRepositoryInput({ query }: { query: string }): boolean {
  return huggingFaceUrl({ input: query }) !== undefined || /^https?:\/\//i.test(query) || query.startsWith('hf.co/');
}

async function requestPage({ query, cursor, numParameters, automatic }: { query: string, cursor: string | undefined, numParameters: string | undefined, automatic: boolean }): Promise<void> {
  const controller = new AbortController();
  pending = controller;
  pendingIsAutomatic = automatic;
  status.value = cursor === undefined ? 'searching' : 'loading-more';
  const isCurrent = () => pending === controller && !controller.signal.aborted && props.active && !props.disabled && !disposed;
  try {
    const page = await searchGgufModels({ query, cursor, numParameters, signal: controller.signal });
    if (!isCurrent()) {
      return;
    }
    if (cursor === undefined) {
      results.value = page.results;
      resultSearch.value = { query, numParameters };
      latestBatchStartId.value = undefined;
      visitedCursors.clear();
    } else {
      const existing = new Map(results.value.map(result => [result.id, result]));
      const firstNew = page.results.find(result => !existing.has(result.id));
      for (const result of page.results) {
        existing.set(result.id, result);
      }
      results.value = [...existing.values()];
      if (firstNew !== undefined) {
        latestBatchStartId.value = firstNew.id;
      }
      visitedCursors.add(cursor);
    }
    nextCursor.value = page.nextCursor !== undefined && !visitedCursors.has(page.nextCursor) ? page.nextCursor : undefined;
    status.value = 'ready';
  } catch {
    if (isCurrent()) {
      status.value = 'failed';
    }
  } finally {
    if (pending === controller) {
      pending = undefined;
      pendingIsAutomatic = false;
    }
  }
}

async function submit(): Promise<void> {
  clearAutoTimer();
  await runSearch({ automatic: false });
}

async function runSearch({ automatic }: { automatic: boolean }): Promise<void> {
  if (!props.active || props.disabled || disposed) {
    return;
  }
  const query = props.query.trim();
  cancelPending();
  filterError.value = false;
  if (isRepositoryInput({ query })) {
    if (automatic) {
      return;
    }
    try {
      const { repository } = parseRepository({ input: huggingFaceUrl({ input: query }) ?? query });
      status.value = resultSearch.value === undefined ? 'idle' : 'ready';
      emit('select', repository, 'url');
    } catch {
      status.value = 'invalid-repository';
    }
    return;
  }
  let numParameters: string | undefined;
  try {
    numParameters = createSearchParameterFilter({ minimumBillions: minimumBillions.value, maximumBillions: maximumBillions.value });
  } catch {
    filterError.value = true;
    filtersOpen.value = true;
    return;
  }
  if (!automatic) {
    filtersOpen.value = false;
  }
  emit('search');
  await requestPage({ query, cursor: undefined, numParameters, automatic });
}

function submitFromKeyboard({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented) {
    return;
  }
  event.preventDefault();
  if (event.isComposing || event.keyCode === 229 || event.which === 229) {
    return;
  }
  void submit();
}

async function loadMore(): Promise<void> {
  const previous = resultSearch.value;
  if (!props.active || props.disabled || disposed || pending !== undefined || nextCursor.value === undefined || previous === undefined) {
    return;
  }
  await requestPage({ query: previous.query, cursor: nextCursor.value, numParameters: previous.numParameters, automatic: false });
}

function select({ repository, action }: { repository: string, action: 'details' | 'choose' }): void {
  if (!props.active || props.disabled || disposed || !results.value.some(result => result.id === repository)) {
    return;
  }
  clearAutoTimer();
  cancelPending();
  switch (action) {
  case 'choose': emit('choose', repository);
    break;
  case 'details': emit('select', repository, 'result');
    break;
  default: throw new Error(String(action satisfies never));
  }
}

function focusOrigin({ repository, source }: { repository: string, source: RepositorySource }): void {
  let anchor: HTMLInputElement | HTMLButtonElement | undefined;
  switch (source) {
  case 'url': anchor = input.value;
    break;
  case 'result':
    anchor = Array.from(root.value?.querySelectorAll<HTMLButtonElement>('[data-repository]') ?? []).find(button => button.dataset.repository === repository);
    break;
  default: throw new Error(String(source satisfies never));
  }
  anchor?.focus({ preventScroll: true });
  anchor?.scrollIntoView?.({ block: 'nearest' });
}

defineExpose({ focusOrigin, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section v-show="active" ref="root" data-testid="model-selector-hf-search" tw-class="space-y-2">
    <form @submit.prevent="submit" tw-class="sticky top-0 z-10 space-y-2 bg-[var(--model-selector-panel-background,var(--color-white))] pt-4 pb-2 dark:bg-[var(--model-selector-panel-background,var(--color-gray-900))]">
      <label :for="id" tw-class="sr-only">{{ lazyStrings.ModelSelectorHuggingFaceSearch__model_name_or_repository_url() }}</label>
      <div tw-class="flex min-w-0 items-center gap-1.5">
        <input :id="id" ref="input" :value="query" :disabled="disabled" :placeholder="lazyStrings.ModelSelectorHuggingFaceSearch__repository_placeholder()" maxlength="200" autocomplete="off" spellcheck="false" data-testid="model-selector-hf-query" @input="updateQuery({ event: $event })" @compositionend="updateQuery({ event: $event })" @keydown.enter="submitFromKeyboard({ event: $event })" tw-class="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-800 outline-none transition-colors placeholder:text-gray-500 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-300 motion-reduce:transition-none" />
        <LlamaCppBrowserModelActionButton type="submit" appearance="outline" size="compact" :disabled="disabled || !active" :aria-label="searchAction === 'open' ? lazyStrings.ModelSelectorHuggingFaceSearch__open_repository() : searchAction === 'search' ? lazyStrings.ModelSelectorHuggingFaceSearch__search_hugging_face() : lazyStrings.ModelSelectorHuggingFaceSearch__show_trending()" data-testid="model-selector-hf-submit" style="inline-size: 6rem" tw-class="h-9 shrink-0 whitespace-nowrap">
          <FolderSearchIcon v-if="repositoryInput" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
          <TrendingUpIcon v-else-if="searchAction === 'trending'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
          <SearchIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
          {{ searchAction === 'open' ? lazyStrings.ModelSelectorHuggingFaceSearch__open() : searchAction === 'search' ? lazyStrings.ModelSelectorHuggingFaceSearch__search() : lazyStrings.ModelSelectorHuggingFaceSearch__trending() }}
        </LlamaCppBrowserModelActionButton>
        <button type="button" data-testid="model-selector-hf-filter" :disabled="disabled" :aria-expanded="filtersOpen" :aria-controls="id + '-filters'" :aria-label="lazyStrings.ModelSelectorHuggingFaceSearch__search_options()" :title="lazyStrings.ModelSelectorHuggingFaceSearch__search_options()" :tw-class="['relative grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:hover:bg-gray-800 motion-reduce:transition-none', (filtersOpen || hasParameterDraft) && 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300']" @click="filtersOpen = !filtersOpen">
          <SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4" />
          <span v-if="hasParameterDraft" aria-hidden="true" tw-class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blue-500" />
        </button>
      </div>
      <Transition name="hf-filter">
        <div v-if="filtersOpen" :id="id + '-filters'" class="hf-filter">
          <div tw-class="min-h-0 overflow-hidden">
            <div tw-class="space-y-2 rounded-lg border border-gray-200 bg-white p-2.5 dark:border-gray-700 dark:bg-gray-800">
              <LlamaCppBrowserModelParameterFilter v-model:minimum-billions="minimumBillions" v-model:maximum-billions="maximumBillions" :disabled="disabled" :invalid="filterError" :error-described-by="filterError ? id + '-filter-error' : undefined" />
              <p v-if="filterError" :id="id + '-filter-error'" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__check_parameter_range() }}</p>
              <div tw-class="flex items-center justify-between gap-3 border-t border-gray-100 pt-2 dark:border-gray-800">
                <div tw-class="min-w-0">
                  <p :id="id + '-auto-search-label'" tw-class="text-xs font-medium">{{ lazyStrings.ModelSelectorHuggingFaceSearch__auto_search() }}</p>
                  <p :id="id + '-auto-search-help'" tw-class="mt-0.5 text-[11px] leading-4 text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__auto_search_help() }}</p>
                </div>
                <ToggleSwitch>
                  <button type="button" role="switch" :aria-checked="autoSearch" :aria-labelledby="id + '-auto-search-label'" :aria-describedby="id + '-auto-search-help'" :disabled="disabled || saving" data-testid="model-selector-hf-auto-search" @click="toggleAutoSearch" />
                </ToggleSwitch>
              </div>
              <p v-if="saveFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__could_not_save_search_settings() }}</p>
            </div>
          </div>
        </div>
      </Transition>
    </form>
    <Transition name="hf-filter">
      <div v-if="expandedRepository?.source === 'url'" class="hf-filter">
        <div tw-class="min-h-0 overflow-hidden"><slot name="repository" /></div>
      </div>
    </Transition>
    <p v-if="busy" role="status" tw-class="flex items-center gap-2 text-xs text-gray-500"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ lazyStrings.ModelSelectorHuggingFaceSearch__searching() }}</p>
    <p v-if="status === 'failed'" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__could_not_search_hugging_face() }}</p>
    <p v-else-if="status === 'invalid-repository'" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__enter_a_valid_repository_url() }}</p>
    <template v-if="resultSearch !== undefined">
      <p v-if="resultSearch.query || appliedParameters.length" tw-class="flex flex-wrap items-center gap-x-2 gap-y-1 break-words px-2 text-[11px] text-gray-500 dark:text-gray-400">
        <span>{{ resultSearch.query ? lazyStrings.ModelSelectorHuggingFaceSearch__results_for({ query: resultSearch.query }) : lazyStrings.ModelSelectorHuggingFaceSearch__results() }}</span>
        <span v-for="bound in appliedParameters" :key="bound" tw-class="rounded bg-gray-100 px-1.5 py-0.5 tabular-nums dark:bg-gray-800">{{ bound }}</span>
      </p>
      <TransitionGroup v-if="results.length" tag="ul" name="hf-result" appear tw-class="divide-y divide-gray-100 dark:divide-gray-800">
        <ModelSelectorRepositoryRow v-for="{ model, parameters } in displayResults" :key="model.id" :row-id="model.id" :disabled="disabled" :choose-label="immediateSelection ? model.id : undefined" :checked="immediateSelection && model.id.toLowerCase() === selectedRepository?.toLowerCase()" :download-status="model.id === choosingRepository ? lazyStrings.ModelSelectorHuggingFaceSearch__checking_configuration() : undefined" :expanded="expandedRepository?.source === 'result' && expandedRepository.repository === model.id" test-id="model-selector-hf-result" @toggle="select({ repository: model.id, action: 'details' })" @choose="select({ repository: model.id, action: 'choose' })">
          <template v-if="model.id === latestBatchStartId" #before>
            <div data-testid="model-selector-hf-new-results" tw-class="mb-1 mt-2 border-t border-gray-200 pt-2 text-[10px] text-gray-500 dark:border-gray-700 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceSearch__new_results_start_here() }}</div>
          </template>
          <span :title="model.id" tw-class="block break-all font-medium">{{ model.id }}</span>
          <span v-if="parameters || model.pipeline_tag || model.gguf?.architecture" tw-class="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
            <span v-if="parameters" tw-class="font-medium tabular-nums">{{ parameters }}</span>
            <span v-if="model.pipeline_tag" tw-class="break-all">{{ model.pipeline_tag === 'automatic-speech-recognition' ? lazyStrings.ModelSelectorHuggingFaceSearch__speech_recognition() : model.pipeline_tag }}</span>
            <span v-if="model.gguf?.architecture && model.gguf.architecture !== model.pipeline_tag" tw-class="break-all">{{ model.gguf.architecture }}</span>
          </span>
          <template #actions><slot name="result-actions" :repository="model.id" /></template>
          <template #configuration><slot name="repository" /></template>
        </ModelSelectorRepositoryRow>
      </TransitionGroup>
      <p v-else-if="!busy" tw-class="text-xs text-gray-500">{{ lazyStrings.ModelSelectorHuggingFaceSearch__no_models_found() }}</p>
      <button v-if="nextCursor !== undefined" type="button" :disabled="disabled || busy" data-testid="model-selector-hf-more" @click="loadMore" tw-class="min-h-8 rounded-lg px-3 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-500/10">{{ lazyStrings.ModelSelectorHuggingFaceSearch__more() }}</button>
    </template>
  </section>
</template>

<style scoped>
.hf-filter {
  display: grid;
  grid-template-rows: 1fr;
}
.hf-filter-enter-active,
.hf-filter-leave-active {
  transition: grid-template-rows 160ms ease, opacity 140ms ease;
}
.hf-filter-enter-from,
.hf-filter-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
.hf-result-enter-active {
  transition: opacity 170ms ease, translate 170ms ease;
}
.hf-result-enter-from {
  opacity: 0;
  translate: 0 3px;
}
@media (prefers-reduced-motion: reduce) {
  .hf-filter-enter-active,
  .hf-filter-leave-active,
  .hf-result-enter-active {
    transition: none;
  }
}
</style>
