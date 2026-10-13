<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SearchPayload } from './contracts';
import { sendSearchRequest, subscribeSearchResponses } from './transport';
import type { SearchHit, SearchWorkerRequest } from './worker-contracts';
import { isDocsArticleHref } from '../../site/navigation-prefetch';

const props = defineProps<SearchPayload>();
const active = ref(false);
const query = ref('');
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const results = ref<SearchHit[]>([]);
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const resultList = ref<HTMLElement>();
const displayedQuery = ref('');
const currentPath = typeof window === 'undefined' ? undefined : window.location.pathname;
const resultsLabel = computed(() => {
  const typed = query.value.trim();
  if (typed !== displayedQuery.value) {
    if (displayedQuery.value) return `${props.copy.previousResults} ${displayedQuery.value}`;
    return props.copy.purposeTitle;
  }
  return typed ? props.copy.title : props.copy.purposeTitle;
});
let previousFocus: HTMLElement | undefined;
let previousOverflow: string | undefined;
let searchWorker: Worker | undefined;
let unsubscribeResponses: (() => void) | undefined;
let requestId = 0;

// DOM listeners require the browser's positional callback signature.
// eslint-disable-next-line local-rules-named-args/require-named-args
const shortcutListener = (event: KeyboardEvent) => onShortcut({ event });

onMounted(() => {
  active.value = true;
  document.addEventListener('keydown', shortcutListener);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', shortcutListener);
  if (dialog.value?.open) dialog.value.close();
  restorePage();
  searchWorker?.terminate();
  unsubscribeResponses?.();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here.
    },
  }) || {}),
});

function workerFailed({ error }: { error: unknown }): void {
  console.error('[Docs search] Worker search failed.', error);
  unsubscribeResponses?.();
  unsubscribeResponses = undefined;
  searchWorker?.terminate();
  searchWorker = undefined;
  requestId += 1;
  results.value = [];
  displayedQuery.value = '';
  status.value = 'error';
}

function submitSearch(): void {
  if (!dialog.value?.open) return;
  requestId += 1;
  // Keep the previous list in place while the Worker searches. Its query is
  // labelled separately so it cannot be mistaken for results of the new input.
  status.value = 'loading';
  try {
    if (!searchWorker) {
      searchWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      unsubscribeResponses = subscribeSearchResponses({
        worker: searchWorker,
        locale: props.locale,
        onResponse: ({ response }) => {
          if (response.requestId !== requestId || !dialog.value?.open) return;
          switch (response.kind) {
          case 'results':
            results.value = response.results;
            displayedQuery.value = query.value.trim();
            status.value = 'ready';
            return;
          case 'error':
            results.value = [];
            displayedQuery.value = '';
            status.value = 'error';
            return;
          default: {
            const unreachable: never = response;
            throw new Error(`Unknown Docs search response: ${String(unreachable)}`);
          }
          }
        },
        onError: ({ error }) => workerFailed({ error }),
      });
      searchWorker.onerror = event => workerFailed({ error: event });
    }
    const message: SearchWorkerRequest = { requestId, locale: props.locale, query: query.value };
    sendSearchRequest({ worker: searchWorker, request: message });
  } catch (error) {
    workerFailed({ error });
  }
}

function restorePage(): void {
  if (previousOverflow !== undefined) document.body.style.overflow = previousOverflow;
  previousOverflow = undefined;
  previousFocus?.focus();
  previousFocus = undefined;
}

function closeSearch(): void {
  if (!dialog.value?.open) return;
  dialog.value.close();
  requestId += 1;
  status.value = 'idle';
  results.value = [];
  displayedQuery.value = '';
  restorePage();
}

function openSearch(): void {
  if (!dialog.value || dialog.value.open) return;
  const focused = document.activeElement;
  previousFocus = focused instanceof HTMLElement ? focused : undefined;
  previousOverflow = document.body.style.overflow;
  dialog.value.showModal();
  document.body.style.overflow = 'hidden';
  void nextTick(() => input.value?.focus());
  submitSearch();
}

function onShortcut({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
  event.preventDefault();
  if (dialog.value?.open) closeSearch();
  else openSearch();
}

function onCancel({ event }: { event: Event }): void {
  event.preventDefault();
  closeSearch();
}

function onBackdrop({ event }: { event: MouseEvent }): void {
  if (event.target !== dialog.value || !dialog.value) return;
  const bounds = dialog.value.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSearch();
}

function focusResult({ offset }: { offset: number }): void {
  resultList.value?.querySelectorAll<HTMLAnchorElement>('a')[offset]?.focus();
}

function onInputKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing || event.key !== 'ArrowDown' || !results.value.length) return;
  event.preventDefault();
  focusResult({ offset: 0 });
}

function moveResult({ event, offset }: { event: KeyboardEvent; offset: number }): void {
  const links = [...(resultList.value?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
  const current = links.indexOf(event.target as HTMLAnchorElement);
  if (current < 0) return;
  event.preventDefault();
  const next = current + offset;
  if (next < 0) input.value?.focus();
  else links[next]?.focus();
}
</script>

<template>
  <div class="docs-search" data-testid="docs-search-island">
    <button
      class="control docs-search-trigger"
      type="button"
      :disabled="!active"
      :aria-label="copy.open"
      :title="copy.open"
      data-testid="docs-search-trigger"
      @click="openSearch"
    ><svg class="icon sm" aria-hidden="true"><use href="#i-search" /></svg></button>
    <dialog ref="dialog" class="docs-search-dialog" :aria-label="copy.title" @cancel="onCancel({ event: $event })" @click="onBackdrop({ event: $event })">
      <div class="docs-search-head">
        <label class="sr-only" for="docs-search-input">{{ copy.title }}</label>
        <svg class="icon sm" aria-hidden="true"><use href="#i-search" /></svg>
        <input
          id="docs-search-input"
          ref="input"
          v-model="query"
          type="search"
          autocomplete="off"
          :placeholder="copy.placeholder"
          data-testid="docs-search-input"
          @input="submitSearch"
          @keydown="onInputKeydown({ event: $event })"
        >
        <button class="docs-search-close" type="button" :aria-label="copy.close" :title="copy.close" data-testid="docs-search-close" @click="closeSearch">×</button>
      </div>
      <div class="docs-search-content">
        <p class="search-status" :role="status === 'error' ? 'alert' : 'status'">
          <span v-if="status === 'loading'">{{ copy.loading }}<template v-if="results.length"> · <template v-if="displayedQuery">{{ copy.previousResults }} “{{ displayedQuery }}”</template><template v-else>{{ copy.purposeTitle }}</template></template></span>
          <span v-else-if="status === 'error'">{{ copy.error }}</span>
          <span v-else-if="!query.trim()">{{ copy.purposeTitle }}</span>
          <span v-else-if="status === 'ready' && !results.length">{{ copy.noResults }}</span>
          <span v-else-if="status === 'ready'">{{ results.length }} {{ copy.count }}</span>
        </p>
        <button v-if="status === 'error'" class="docs-search-retry" type="button" @click="submitSearch">{{ copy.retry }}</button>
        <ul v-show="results.length" ref="resultList" class="search-results" :aria-label="resultsLabel" data-testid="docs-search-results">
          <li v-for="result in results" :key="result.href">
            <a :href="result.href" :data-docs-guide-prefetch="isDocsArticleHref({ href: result.href }) && result.href !== currentPath ? '' : undefined" @keydown.down="moveResult({ event: $event, offset: 1 })" @keydown.up="moveResult({ event: $event, offset: -1 })">
              <strong>{{ result.title }}</strong>
              <span>{{ result.snippet }}</span>
            </a>
          </li>
        </ul>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.docs-search-trigger { width:37px; padding:0; }
.docs-search-trigger:disabled { cursor:default; }
.docs-search-dialog { box-sizing:border-box; width:min(680px,calc(100vw - 28px)); max-width:none; height:min(62dvh,460px); margin:10dvh auto 0; padding:0; border:1px solid var(--line-strong); border-radius:16px; background:var(--surface); color:var(--text); box-shadow:var(--panel-shadow); overflow:hidden; }
.docs-search-dialog[open] { display:flex; flex-direction:column; }
.docs-search-dialog::backdrop { background:rgba(3,8,18,.62); backdrop-filter:blur(4px); }
.docs-search-head { display:flex; align-items:center; gap:12px; padding:14px 17px; border-bottom:1px solid var(--line); color:var(--muted); }
.docs-search-head input { flex:1; min-width:0; padding:7px 0; border:0; outline:0; background:transparent; color:var(--text); font-size:16px; }
.docs-search-head input:focus-visible { outline:0; }
.docs-search-close { flex:none; width:31px; height:31px; border:1px solid var(--line-strong); border-radius:7px; background:var(--surface-2); color:var(--muted); font-size:22px; line-height:1; }
.docs-search-close:hover { color:var(--text); }
.docs-search-content { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; }
.search-status { position:sticky; top:0; z-index:1; box-sizing:border-box; display:flex; align-items:center; min-height:54px; margin:0; padding:12px 20px; background:var(--surface); color:var(--muted); font-size:13px; }
.search-status span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.docs-search-retry { margin:0 20px 12px; padding:8px 13px; border:1px solid var(--line-strong); border-radius:8px; background:var(--surface-2); color:var(--text); }
.search-results { list-style:none; padding:0 12px 12px; margin:0; }
.search-results li + li { border-top:1px solid var(--line); }
.search-results a { display:block; padding:14px 10px; border-radius:9px; text-decoration:none; }
.search-results a:hover, .search-results a:focus-visible { background:var(--surface-2); }
.search-results strong { display:block; color:var(--text); font-size:15px; }
.search-results span { display:block; margin-top:5px; color:var(--muted); font-size:12px; line-height:1.7; }
@media(max-width:620px) { .docs-search-dialog { margin:5dvh auto 0; max-height:85dvh; } .docs-search-head { padding:10px 12px; } }
</style>
