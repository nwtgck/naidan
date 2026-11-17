<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { ArrowRightIcon, Loader2Icon, SearchIcon } from 'lucide-vue-next';
import { searchGgufModels, type ModelSearchResult } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { huggingFaceUrl } from '@/features/llama-cpp-browser/hugging-face/search-input';
import { lazyStrings } from '@/strings';

const props = defineProps<{ query: string, active: boolean, disabled: boolean }>();
const emit = defineEmits<{ 'update:query': [value: string], select: [repository: string] }>();
const id = useId();
const results = shallowRef<ModelSearchResult[]>([]);
const resultQuery = ref<string>();
const nextCursor = ref<string>();
const visitedCursors = new Set<string>();
const status = ref<'idle' | 'searching' | 'loading-more' | 'ready' | 'failed' | 'invalid-repository'>('idle');
const busy = computed(() => status.value === 'searching' || status.value === 'loading-more');
let pending: AbortController | undefined;
let disposed = false;

function cancelPending(): void {
  const previous = pending;
  pending = undefined;
  previous?.abort();
  if (previous !== undefined) {
    status.value = resultQuery.value === undefined ? 'idle' : 'ready';
  }
}

// Editing only updates the shared filter. Retain completed results, but never
// let an earlier request publish into a different query or inactive panel.
watch(() => props.query, cancelPending, { flush: 'sync' });
watch(() => props.active && !props.disabled, enabled => {
  if (!enabled) {
    cancelPending();
  }
}, { flush: 'sync' });
onScopeDispose(() => {
  disposed = true;
  cancelPending();
});

function updateQuery({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) {
    emit('update:query', event.target.value);
  }
}

async function requestPage({ query, cursor }: { query: string, cursor: string | undefined }): Promise<void> {
  const controller = new AbortController();
  pending = controller;
  status.value = cursor === undefined ? 'searching' : 'loading-more';
  const isCurrent = () => pending === controller && !controller.signal.aborted && props.active && !props.disabled && !disposed;
  try {
    const page = await searchGgufModels({ query, cursor, numParameters: undefined, signal: controller.signal });
    if (!isCurrent()) {
      return;
    }
    if (cursor === undefined) {
      results.value = page.results;
      resultQuery.value = query;
      visitedCursors.clear();
    } else {
      results.value = [...new Map([...results.value, ...page.results].map(result => [result.id, result])).values()];
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
    }
  }
}

async function submit(): Promise<void> {
  if (!props.active || props.disabled || disposed || props.query.trim() === '') {
    return;
  }
  cancelPending();
  const query = props.query.trim();
  const url = huggingFaceUrl({ input: query });
  if (url !== undefined || /^https?:\/\//i.test(query) || query.startsWith('hf.co/')) {
    try {
      const { repository } = parseRepository({ input: url ?? query });
      status.value = resultQuery.value === undefined ? 'idle' : 'ready';
      emit('select', repository);
    } catch {
      status.value = 'invalid-repository';
    }
    return;
  }
  await requestPage({ query, cursor: undefined });
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
  if (!props.active || props.disabled || disposed || pending !== undefined || nextCursor.value === undefined || resultQuery.value === undefined) {
    return;
  }
  await requestPage({ query: resultQuery.value, cursor: nextCursor.value });
}

function select({ repository }: { repository: string }): void {
  if (!props.active || props.disabled || disposed || !results.value.some(result => result.id === repository)) {
    return;
  }
  cancelPending();
  emit('select', repository);
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section v-show="active" data-testid="model-selector-hf-search" tw-class="space-y-3 p-3">
    <form @submit.prevent="submit" tw-class="space-y-2">
      <label :for="id" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.ModelSelectorHuggingFaceSearch__model_name_or_repository_url() }}</label>
      <input :id="id" :value="query" :disabled="disabled" maxlength="200" autocomplete="off" spellcheck="false" data-testid="model-selector-hf-query" @input="updateQuery({ event: $event })" @keydown.enter="submitFromKeyboard({ event: $event })" tw-class="h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
      <div tw-class="flex items-start gap-3">
        <button type="submit" :disabled="disabled || !active || !query.trim()" data-testid="model-selector-hf-submit" tw-class="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40"><SearchIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelSelectorHuggingFaceSearch__search_hugging_face() }}</button>
        <p tw-class="text-[11px] leading-4 text-gray-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__search_sends_your_query_to_hugging_face() }}</p>
      </div>
    </form>
    <p v-if="busy" role="status" tw-class="flex items-center gap-2 text-xs text-gray-500"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ lazyStrings.ModelSelectorHuggingFaceSearch__searching() }}</p>
    <p v-if="status === 'failed'" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__could_not_search_hugging_face() }}</p>
    <p v-else-if="status === 'invalid-repository'" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__enter_a_valid_repository_url() }}</p>
    <template v-if="resultQuery !== undefined">
      <p tw-class="break-words text-[11px] text-gray-400">{{ lazyStrings.ModelSelectorHuggingFaceSearch__results_for({ query: resultQuery }) }}</p>
      <ul v-if="results.length" tw-class="space-y-0.5">
        <li v-for="result in results" :key="result.id"><button type="button" :disabled="disabled" data-testid="model-selector-hf-result" @click="select({ repository: result.id })" tw-class="group flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"><span tw-class="break-all">{{ result.id }}</span><ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" /></button></li>
      </ul>
      <p v-else-if="!busy" tw-class="text-xs text-gray-500">{{ lazyStrings.ModelSelectorHuggingFaceSearch__no_models_found() }}</p>
      <button v-if="nextCursor !== undefined" type="button" :disabled="disabled || busy" data-testid="model-selector-hf-more" @click="loadMore" tw-class="min-h-8 rounded-lg px-3 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-500/10">{{ lazyStrings.ModelSelectorHuggingFaceSearch__more() }}</button>
    </template>
  </section>
</template>
