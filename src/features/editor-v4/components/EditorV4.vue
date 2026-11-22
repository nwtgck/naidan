<script setup lang="ts">
import {
  ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, ListOrderedIcon,
  Redo2Icon, ReplaceAllIcon, ReplaceIcon, SearchIcon, Undo2Icon, WrapTextIcon, XIcon,
} from 'lucide-vue-next';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { useEditorEmacsKeys } from '@/features/editor-v4/composables/useEditorEmacsKeys';
import { useEditorInput } from '@/features/editor-v4/composables/useEditorInput';
import { editorMirrorPieces, useEditorViewport } from '@/features/editor-v4/composables/useEditorViewport';
import { EditorDocument, type EditorChange } from '@/features/editor-v4/logic/document';
import { createEditorSearchSession, EditorSearchTimeout } from '@/features/editor-v4/worker/session';
import type { EditorSearchMatch, EditorSearchOptions, EditorSearchRequest } from '@/features/editor-v4/worker/types';

const props = defineProps<{ initialText: string, readOnly: boolean }>();
type Snapshot = { text: string, dirty: boolean, version: number, checkpoint: number };
const emit = defineEmits<{ change: [snapshot: Snapshot], 'request-save': [] }>();

const documentState = new EditorDocument({ text: props.initialText });
const nativeTextarea = useTemplateRef<HTMLTextAreaElement>('textarea');
const mirrorElement = useTemplateRef<HTMLElement>('mirror');
const findInput = useTemplateRef<HTMLInputElement>('findInput');
const replaceInput = useTemplateRef<HTMLInputElement>('replaceInput');
const textarea = computed(() => nativeTextarea.value ?? undefined);
const mirror = computed(() => mirrorElement.value ?? undefined);
const documentVersion = shallowRef(documentState.version);
const selection = shallowRef(documentState.selection);
const lineNumbers = defineModel<'shown' | 'hidden'>('lineNumbers', { default: 'shown' });
const wordWrap = defineModel<boolean>('wordWrap', { default: false });
const statistics = ref<'shown' | 'hidden'>('hidden');
const keyMap = ref<'standard' | 'emacs'>('standard');
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const searchPanel = ref<'closed' | 'find' | 'replace'>('closed');
const searchOpen = computed(() => {
  switch (searchPanel.value) {
  case 'closed': return false;
  case 'find': case 'replace': return true;
  default: {
    const exhaustive: never = searchPanel.value;
    return exhaustive;
  }
  }
});
const query = ref('');
const replacement = ref('');
const matchCase = ref<EditorSearchOptions['caseSensitivity']>('case-insensitive');
const searchMode = ref<EditorSearchOptions['mode']>('literal');
const searchStatus = ref<'idle' | 'running' | 'invalid-regex' | 'unavailable' | 'timed-out'>('idle');
const replacementLimit = ref<'current' | 'all'>();
const matchCount = ref(0);
const currentMatch = shallowRef<EditorSearchMatch>();
const highlights = shallowRef<EditorSearchMatch[]>([]);
const search = createEditorSearchSession();
const emacsKeys = useEditorEmacsKeys({ document: documentState });
const input = useEditorInput({
  document: documentState,
  textarea,
  isReadOnly: () => props.readOnly,
  publish: publishChange,
});
const viewport = useEditorViewport({
  document: documentState,
  textarea,
  mirror,
  wraps: () => wordWrap.value,
});
const resultCanReplace = computed(() => !props.readOnly && searchStatus.value === 'idle' && currentMatch.value !== undefined);
const resultCanReplaceAll = computed(() => resultCanReplace.value && replacementLimit.value !== 'all');
const canUndo = computed(() => {
  void documentVersion.value;
  return documentState.canUndo;
});
const canRedo = computed(() => {
  void documentVersion.value;
  return documentState.canRedo;
});
let requestNumber = 0;
let highlightedRange: EditorSearchRequest['visible'] | undefined;
let findTimer: ReturnType<typeof setTimeout> | undefined;
let viewportFrame: number | undefined;
let resizeObserver: ResizeObserver | undefined;

const caretLocation = computed(() => {
  void documentVersion.value;
  const { start, end, direction } = selection.value.primary;
  const offset = { backward: start, forward: end, none: end }[direction ?? 'none'];
  return documentState.getPosition({ offset });
});
const selectionSize = computed(() => {
  const { primary, secondary } = selection.value;
  return secondary.reduce((total, range) => total + range.end - range.start, primary.end - primary.start);
});
const documentStatistics = computed(() => {
  void documentVersion.value;
  const content = documentState.text;
  let words = 0;
  for (const _word of content.matchAll(/\S+/g)) {
    words++;
  }
  return { lines: documentState.lineCount, characters: content.length, words };
});
const showMirror = computed(() => wordWrap.value
  || highlights.value.length > 0
  || currentMatch.value !== undefined
  || selection.value.secondary.length > 0);
const mirrorPieces = computed(() => {
  void documentVersion.value;
  if (!showMirror.value) {
    return [];
  }
  const visible = viewport.visibleRange();
  const active = currentMatch.value;
  const matches = active === undefined || highlights.value.some(match => match.index === active.index)
    ? highlights.value
    : [...highlights.value, active];
  return editorMirrorPieces({
    text: documentState.text,
    matches: matches.map(match => ({ ...match, kind: match.index === active?.index ? 'active-match' : 'match' })),
    selections: selection.value.secondary
      .filter(range => range.start <= visible.end && range.end >= visible.start)
      .map(range => ({ ...range, kind: 'selection' })),
  });
});
const findError = computed(() => {
  switch (searchStatus.value) {
  case 'invalid-regex': return lazyStrings.EditorV4__invalid_regular_expression();
  case 'unavailable': return lazyStrings.EditorV4__search_unavailable();
  case 'timed-out': return lazyStrings.EditorV4__search_timed_out();
  case 'idle': case 'running':
    return replacementLimit.value === undefined ? undefined : lazyStrings.EditorV4__replacement_too_large();
  default: {
    const exhaustive: never = searchStatus.value;
    return exhaustive;
  }
  }
});

function snapshot(): Snapshot {
  return {
    text: documentState.text,
    dirty: documentState.dirty,
    version: documentState.version,
    checkpoint: documentState.checkpoint,
  };
}

function captureSavepoint(): Snapshot {
  input.finishComposition();
  documentState.captureSavepoint();
  return snapshot();
}

function markSaved({ checkpoint }: { checkpoint: number }): void {
  documentState.markSaved({ checkpoint });
  emit('change', snapshot());
}

function focus(): void {
  textarea.value?.focus();
}

function refreshVisibleMatches(): void {
  if (textarea.value === undefined || searchStatus.value !== 'idle' || highlightedRange === undefined || matchCount.value === 0) {
    return;
  }
  const visible = viewport.visibleRange();
  if (visible.start !== highlightedRange.start || visible.end !== highlightedRange.end) {
    scheduleSearch({ action: 'refresh' });
  }
}

function queueViewportMeasurement(): void {
  if (viewportFrame !== undefined) {
    return;
  }
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = undefined;
    void viewport.measure().then(refreshVisibleMatches);
  });
}

function publishChange({ change }: { change: EditorChange | undefined }): void {
  selection.value = documentState.selection;
  if (change !== undefined) {
    documentVersion.value = change.version;
    search.record({ change });
    emit('change', snapshot());
    queueViewportMeasurement();
    scheduleSearch({ action: 'edit' });
  }
}

function clearMatches(): void {
  highlightedRange = undefined;
  currentMatch.value = undefined;
  highlights.value = [];
  matchCount.value = 0;
}

function scheduleSearch({ action }: { action: 'edit' | 'query' | 'refresh' }): void {
  if (!searchOpen.value) {
    return;
  }
  const options = {
    edit: { reveal: false, preserveMatches: false, delay: 85 },
    query: { reveal: true, preserveMatches: false, delay: 85 },
    refresh: { reveal: false, preserveMatches: true, delay: 30 },
  }[action];
  clearTimeout(findTimer);
  const requestId = ++requestNumber;
  if (!options.preserveMatches) {
    clearMatches();
    replacementLimit.value = undefined;
  }
  if (query.value === '') {
    searchStatus.value = 'idle';
    return;
  }
  const target: EditorSearchRequest['target'] = options.preserveMatches && currentMatch.value !== undefined
    ? { kind: 'index', index: currentMatch.value.index }
    : { kind: 'offset', offset: documentState.selection.primary.start };
  searchStatus.value = 'running';
  findTimer = setTimeout(() => {
    void searchDocument({ requestId, target, reveal: options.reveal });
  }, options.delay);
}

function searchOptions(): EditorSearchOptions {
  return { query: query.value, caseSensitivity: matchCase.value, mode: searchMode.value };
}

async function searchDocument({
  requestId, target, reveal,
}: { requestId: number, target: EditorSearchRequest['target'], reveal: boolean }): Promise<void> {
  const before = snapshot();
  const requestedRange = viewport.visibleRange();
  const isCurrent = (): boolean => requestId === requestNumber && before.version === documentState.version && searchOpen.value;
  try {
    const result = await search.search({
      snapshot: before,
      request: { version: before.version, options: searchOptions(), visible: requestedRange, target },
      isCurrent,
    });
    if (!isCurrent() || result === undefined) {
      return;
    }
    switch (result.kind) {
    case 'matches':
      break;
    case 'invalid-regex': case 'unavailable':
      clearMatches();
      searchStatus.value = result.kind;
      return;
    default: {
      const exhaustive: never = result;
      throw new Error('Unexpected editor search result ' + String(exhaustive));
    }
    }
    matchCount.value = result.count;
    currentMatch.value = result.active;
    highlights.value = result.highlights;
    highlightedRange = requestedRange;
    if (reveal && result.active !== undefined && !input.isComposing) {
      documentState.setSelection({
        selection: {
          primary: { start: result.active.start, end: result.active.end },
          secondary: [],
        },
      });
      input.synchronizeElement();
      publishChange({ change: undefined });
      await nextTick();
      if (!isCurrent()) {
        return;
      }
      await viewport.reveal({ offset: result.active.start });
    }
    if (isCurrent()) {
      searchStatus.value = 'idle';
      refreshVisibleMatches();
    }
  } catch (error) {
    if (isCurrent()) {
      clearMatches();
      searchStatus.value = error instanceof EditorSearchTimeout ? 'timed-out' : 'unavailable';
    }
  }
}

function moveMatch({ offset }: { offset: -1 | 1 }): void {
  if (searchStatus.value !== 'idle' || query.value === '' || matchCount.value === 0) {
    return;
  }
  clearTimeout(findTimer);
  const requestId = ++requestNumber;
  searchStatus.value = 'running';
  void searchDocument({
    requestId,
    target: { kind: 'index', index: (currentMatch.value?.index ?? 0) + offset },
    reveal: true,
  });
}

async function replaceMatches({ scope }: { scope: 'current' | 'all' }): Promise<void> {
  const match = currentMatch.value;
  const canReplace = { current: resultCanReplace.value, all: resultCanReplaceAll.value }[scope];
  if (!canReplace || match === undefined || input.isComposing) {
    return;
  }
  clearTimeout(findTimer);
  const requestId = ++requestNumber;
  const before = snapshot();
  const requestedReplacement = replacement.value;
  const isCurrent = (): boolean => requestId === requestNumber && before.version === documentState.version
    && requestedReplacement === replacement.value && !props.readOnly && !input.isComposing;
  const target = {
    current: { kind: 'match', index: match.index },
    all: { kind: 'all' },
  } as const;
  searchStatus.value = 'running';
  try {
    const response = await search.replace({
      snapshot: before,
      request: {
        version: before.version,
        options: searchOptions(),
        replacement: requestedReplacement,
        target: target[scope],
      },
      isCurrent,
    });
    if (!isCurrent() || response === undefined) {
      return;
    }
    switch (response.kind) {
    case 'edits':
      break;
    case 'too-large':
      replacementLimit.value = ({ current: replacementLimit.value ?? 'current', all: 'all' } as const)[scope];
      return;
    case 'invalid-regex': case 'unavailable':
      searchStatus.value = response.kind;
      return;
    default: {
      const exhaustive: never = response;
      throw new Error('Unexpected editor replace result ' + String(exhaustive));
    }
    }
    searchStatus.value = 'idle';
    const change = documentState.applyEdits({ edits: response.edits, selectionAfter: undefined, group: undefined });
    input.synchronizeElement();
    publishChange({ change });
    if (change === undefined && scope === 'current') {
      moveMatch({ offset: 1 });
    }
  } catch (error) {
    if (isCurrent()) {
      searchStatus.value = error instanceof EditorSearchTimeout ? 'timed-out' : 'unavailable';
    }
  } finally {
    if (requestId === requestNumber && searchStatus.value === 'running') {
      searchStatus.value = 'idle';
    }
    if (requestId === requestNumber) {
      refreshVisibleMatches();
    }
  }
}

function openSearch({ panel }: { panel: 'find' | 'replace' }): void {
  input.reconcileNativeSelection();
  if (!searchOpen.value) {
    const selectedText = documentState.text.slice(selection.value.primary.start, selection.value.primary.end);
    if (selectedText !== '' && !selectedText.includes('\n')) {
      query.value = selectedText;
    }
  }
  searchPanel.value = panel;
  void nextTick(() => {
    if (panel === 'replace' && query.value !== '') {
      replaceInput.value?.focus();
    } else {
      findInput.value?.focus();
      findInput.value?.select();
    }
  });
}

function closeSearch(): void {
  searchPanel.value = 'closed';
  requestNumber++;
  clearTimeout(findTimer);
  clearMatches();
  replacementLimit.value = undefined;
  searchStatus.value = 'idle';
  search.close();
  focus();
}

function selectOccurrences({ scope }: { scope: 'next' | 'all' }): void {
  input.reconcileNativeSelection();
  const select = {
    next: () => documentState.selectNextOccurrence(),
    all: () => documentState.selectAllOccurrences(),
  };
  const changed = select[scope]();
  input.synchronizeElement();
  publishChange({ change: undefined });
  focus();
  if (changed) {
    void nextTick(() => viewport.reveal({ offset: documentState.selection.secondary.at(-1)?.start ?? documentState.selection.primary.start }));
  }
}

function handleClipboard({ event, action }: { event: ClipboardEvent, action: 'copy' | 'cut' }): void {
  input.reconcileNativeSelection();
  if (input.isComposing || event.clipboardData === null || selection.value.secondary.length === 0) {
    return;
  }
  const selected = [selection.value.primary, ...selection.value.secondary]
    .filter(range => range.start !== range.end)
    .sort((left, right) => left.start - right.start);
  if (selected.length === 0) {
    return;
  }
  event.clipboardData.setData('text/plain', selected.map(range => documentState.text.slice(range.start, range.end)).join('\n'));
  event.preventDefault();
  if (action === 'cut' && !props.readOnly) {
    const change = documentState.replaceSelections({ text: '', group: undefined });
    input.synchronizeElement();
    publishChange({ change });
  }
}

function consume({ event }: { event: KeyboardEvent }): void {
  event.stopPropagation();
  event.preventDefault();
}

function previousOrNext({ event }: { event: KeyboardEvent }): void {
  consume({ event });
  moveMatch({ offset: event.shiftKey ? -1 : 1 });
}

function runHistory({ direction }: { direction: 'undo' | 'redo' }): void {
  input.applyHistory({ direction });
  focus();
  void nextTick(() => viewport.reveal({ offset: documentState.selection.primary.end }));
}

function moveMultipleSelections({ event }: { event: KeyboardEvent }): boolean {
  if (documentState.selection.secondary.length === 0 || event.altKey || event.ctrlKey || (event.metaKey && !isMac)) {
    return false;
  }
  let key = event.key;
  if (event.metaKey) {
    switch (key) {
    case 'ArrowLeft': key = 'Home';
      break;
    case 'ArrowRight': key = 'End';
      break;
    default: return false;
    }
  }
  switch (key) {
  case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': case 'Home': case 'End':
    consume({ event });
    documentState.moveSelections({ key, extend: event.shiftKey });
    input.synchronizeElement();
    publishChange({ change: undefined });
    void nextTick(() => viewport.reveal({ offset: documentState.selection.primary.end }));
    return true;
  default:
    return false;
  }
}

function handleKeydown({ event }: { event: KeyboardEvent }): void {
  const bodyFocused = event.target === textarea.value;
  if (event.isComposing || input.isComposing || event.keyCode === 229) {
    event.stopPropagation();
    return;
  }
  if (event.key === 'Escape') {
    if (searchOpen.value) {
      consume({ event });
      closeSearch();
    } else if (selection.value.secondary.length > 0) {
      consume({ event });
      documentState.setSelection({ selection: { primary: selection.value.primary, secondary: [] } });
      publishChange({ change: undefined });
    }
    return;
  }
  if ((event.key === 'Enter' && event.target === findInput.value) || (event.key === 'F3' && searchOpen.value)) {
    previousOrNext({ event });
    return;
  }
  if (event.key === 'Enter' && event.target === replaceInput.value) {
    consume({ event });
    void replaceMatches({ scope: 'current' });
    return;
  }

  // Explorer's own navigation and clipboard shortcuts apply to file rows only.
  event.stopPropagation();
  if (bodyFocused) {
    input.reconcileNativeSelection();
    if (moveMultipleSelections({ event })) {
      return;
    }
  }
  const key = event.key.toLowerCase();
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (bodyFocused && keyMap.value === 'emacs' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    const result = emacsKeys.run({ key, readOnly: props.readOnly });
    if (result !== undefined) {
      consume({ event });
      input.synchronizeElement();
      publishChange({ change: result.change });
      void viewport.reveal({ offset: documentState.selection.primary.end });
      return;
    }
  }
  if (!modifier) {
    return;
  }
  if ((isMac ? (key === 'f' || event.code === 'KeyF') && event.altKey : key === 'h' && !event.altKey) && !event.shiftKey) {
    consume({ event });
    openSearch({ panel: 'replace' });
    return;
  }
  if (event.altKey) {
    return;
  }
  if (key === 'f' && !event.shiftKey) {
    consume({ event });
    openSearch({ panel: 'find' });
    return;
  }
  if (key === 's' && !event.shiftKey) {
    consume({ event });
    if (!props.readOnly) {
      emit('request-save');
    }
    return;
  }
  if (!bodyFocused) {
    return;
  }
  if (key === 'd' && !event.shiftKey) {
    consume({ event });
    selectOccurrences({ scope: 'next' });
  } else if (key === 'l' && event.shiftKey) {
    consume({ event });
    selectOccurrences({ scope: 'all' });
  } else if (key === 'z' || (!isMac && key === 'y' && !event.shiftKey)) {
    consume({ event });
    runHistory({ direction: event.shiftKey || key === 'y' ? 'redo' : 'undo' });
  }
}

watch([query, matchCase, searchMode, searchPanel], () => scheduleSearch({ action: 'query' }));
watch(replacement, () => {
  replacementLimit.value = undefined;
});
watch(wordWrap, queueViewportMeasurement, { flush: 'post' });

onMounted(() => {
  input.synchronizeElement();
  void viewport.measure();
  if (typeof ResizeObserver === 'function' && textarea.value !== undefined) {
    resizeObserver = new ResizeObserver(queueViewportMeasurement);
    resizeObserver.observe(textarea.value);
  }
});
onUnmounted(() => {
  requestNumber++;
  clearTimeout(findTimer);
  if (viewportFrame !== undefined) {
    cancelAnimationFrame(viewportFrame);
  }
  resizeObserver?.disconnect();
  search.close();
});

defineExpose({
  getSnapshot: snapshot,
  captureSavepoint,
  markSaved,
  focus,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <section data-testid="editor-v4" tw-class="flex min-h-40 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950" @keydown="handleKeydown({ event: $event })">
    <div v-if="searchPanel !== 'closed'" tw-class="z-10 self-end w-full max-w-lg shrink-0 rounded-bl-lg border-b border-l border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800" :aria-label="lazyStrings.EditorV4__find_in_document()">
      <div tw-class="flex items-center gap-1">
        <button type="button" tw-class="shrink-0 rounded p-1 text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700" :title="lazyStrings.EditorV4__toggle_replace_field()" :aria-label="lazyStrings.EditorV4__toggle_replace_field()" :aria-expanded="searchPanel === 'replace'" @click="searchPanel = searchPanel === 'find' ? 'replace' : 'find'">
          <ChevronRightIcon v-if="searchPanel === 'find'" aria-hidden="true" tw-class="h-4 w-4" />
          <ChevronDownIcon v-else aria-hidden="true" tw-class="h-4 w-4" />
        </button>
        <input ref="findInput" v-model="query" type="text" spellcheck="false" data-testid="editor-v4-find" :placeholder="lazyStrings.EditorV4__find_in_document()" :aria-label="lazyStrings.EditorV4__find_in_document()" :aria-invalid="searchStatus === 'invalid-regex'" tw-class="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-950" />
        <button type="button" data-testid="editor-v4-match-case" :aria-pressed="matchCase === 'case-sensitive'" :aria-label="lazyStrings.EditorV4__match_case()" :title="lazyStrings.EditorV4__match_case()" tw-class="rounded px-1 text-xs font-semibold hover:bg-gray-200 aria-pressed:bg-blue-100 dark:hover:bg-gray-700 dark:aria-pressed:bg-blue-950" @click="matchCase = matchCase === 'case-sensitive' ? 'case-insensitive' : 'case-sensitive'">Aa</button>
        <button type="button" data-testid="editor-v4-regex" :aria-pressed="searchMode === 'regex'" :aria-label="lazyStrings.EditorV4__use_regular_expression()" :title="lazyStrings.EditorV4__use_regular_expression()" tw-class="rounded px-1 font-mono text-xs hover:bg-gray-200 aria-pressed:bg-blue-100 dark:hover:bg-gray-700 dark:aria-pressed:bg-blue-950" @click="searchMode = searchMode === 'regex' ? 'literal' : 'regex'">.*</button>
        <span v-if="query !== '' && searchStatus === 'idle'" aria-live="polite" tw-class="shrink-0 px-1 text-xs text-gray-600 dark:text-gray-300" data-testid="editor-v4-match-count">{{ lazyStrings.EditorV4__find_match_position({ index: currentMatch ? currentMatch.index + 1 : 0, count: matchCount }) }}</span>
        <button type="button" :aria-label="lazyStrings.EditorV4__find_previous()" :title="lazyStrings.EditorV4__find_previous()" :disabled="matchCount === 0 || searchStatus !== 'idle'" tw-class="rounded p-1 hover:bg-gray-200 disabled:opacity-40 dark:hover:bg-gray-700" @click="moveMatch({ offset: -1 })"><ArrowUpIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        <button type="button" :aria-label="lazyStrings.EditorV4__find_next()" :title="lazyStrings.EditorV4__find_next()" :disabled="matchCount === 0 || searchStatus !== 'idle'" tw-class="rounded p-1 hover:bg-gray-200 disabled:opacity-40 dark:hover:bg-gray-700" @click="moveMatch({ offset: 1 })"><ArrowDownIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        <button type="button" :aria-label="lazyStrings.EditorV4__close_find()" :title="lazyStrings.EditorV4__close_find()" tw-class="rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-700" @click="closeSearch"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      </div>
      <div v-if="searchPanel === 'replace'" tw-class="mt-1 flex items-center gap-1 pl-6">
        <input ref="replaceInput" v-model="replacement" type="text" :disabled="readOnly" spellcheck="false" data-testid="editor-v4-replacement" :placeholder="lazyStrings.EditorV4__replace_with()" :aria-label="lazyStrings.EditorV4__replace_with()" tw-class="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-950" />
        <button type="button" data-testid="editor-v4-replace-current" :aria-label="lazyStrings.EditorV4__replace_current()" :title="lazyStrings.EditorV4__replace_current()" :disabled="!resultCanReplace" tw-class="rounded p-1 hover:bg-gray-200 disabled:opacity-40 dark:hover:bg-gray-700" @click="replaceMatches({ scope: 'current' })"><ReplaceIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        <button type="button" data-testid="editor-v4-replace-all" :aria-label="lazyStrings.EditorV4__replace_all()" :title="lazyStrings.EditorV4__replace_all()" :disabled="!resultCanReplaceAll" tw-class="rounded p-1 hover:bg-gray-200 disabled:opacity-40 dark:hover:bg-gray-700" @click="replaceMatches({ scope: 'all' })"><ReplaceAllIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      </div>
      <p v-if="findError !== undefined" role="status" tw-class="mt-1 pl-6 text-xs text-red-700 dark:text-red-400">{{ findError }}</p>
    </div>

    <div tw-class="flex min-h-24 min-w-0 flex-1 overflow-hidden">
      <div v-if="lineNumbers === 'shown'" aria-hidden="true" tw-class="relative w-12 shrink-0 overflow-hidden border-r border-gray-100 bg-gray-50 text-right font-mono text-xs tabular-nums text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
        <span v-for="marker in viewport.visible.value" :key="marker.line" :style="{ top: marker.top + 'px' }" data-testid="editor-v4-line-marker" class="editor-line-marker" tw-class="pointer-events-none absolute inset-x-0 pr-3">{{ marker.line }}</span>
      </div>
      <div tw-class="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div v-if="showMirror" data-testid="editor-v4-mirror-viewport" aria-hidden="true" tw-class="pointer-events-none absolute inset-0 overflow-hidden" :style="{ width: viewport.frame.value.width + 'px' }">
          <pre ref="mirror" class="editor-surface editor-mirror" :class="{ 'editor-wrap': wordWrap }" :style="{ transform: 'translate(' + -viewport.frame.value.left + 'px,' + -viewport.frame.value.top + 'px)' }"><span v-for="(piece, index) in mirrorPieces" :key="index" :data-offset="piece.start" :class="{ 'editor-secondary': piece.kind === 'selection', 'editor-match': piece.kind === 'match', 'editor-active-match': piece.kind === 'active-match', 'editor-caret': piece.kind === 'caret' }">{{ piece.text }}</span></pre>
        </div>
        <textarea
          ref="textarea"
          data-testid="editor-v4-input"
          :aria-label="lazyStrings.EditorV4__text_editor()"
          class="editor-surface"
          :class="{ 'editor-wrap': wordWrap }"
          :wrap="wordWrap ? 'soft' : 'off'"
          :readonly="readOnly"
          spellcheck="false"
          tw-class="relative block h-full w-full resize-none overflow-auto border-0 bg-transparent text-gray-900 outline-none selection:bg-blue-300/70 dark:text-gray-100 dark:selection:bg-blue-600/60"
          @beforeinput="input.handleBeforeInput({ event: $event })"
          @input="input.handleInput({ event: $event })"
          @compositionstart="input.handleCompositionStart"
          @compositionend="input.handleCompositionEnd"
          @select="input.reconcileNativeSelection"
          @keyup="input.reconcileNativeSelection"
          @pointerup="input.reconcileNativeSelection"
          @scroll="queueViewportMeasurement"
          @copy="handleClipboard({ event: $event, action: 'copy' })"
          @cut="handleClipboard({ event: $event, action: 'cut' })"
        />
      </div>
    </div>

    <footer tw-class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
      <button type="button" :aria-label="lazyStrings.EditorV4__find_in_document()" :title="lazyStrings.EditorV4__find_in_document()" tw-class="rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-700" @click="openSearch({ panel: 'find' })"><SearchIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      <button type="button" :disabled="readOnly || !canUndo" :aria-label="lazyStrings.EditorV4__undo()" :title="lazyStrings.EditorV4__undo()" tw-class="rounded p-1 hover:bg-gray-200 disabled:opacity-40 dark:hover:bg-gray-700" @click="runHistory({ direction: 'undo' })"><Undo2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
      <button type="button" :disabled="readOnly || !canRedo" :aria-label="lazyStrings.EditorV4__redo()" :title="lazyStrings.EditorV4__redo()" tw-class="rounded p-1 hover:bg-gray-200 disabled:opacity-40 dark:hover:bg-gray-700" @click="runHistory({ direction: 'redo' })"><Redo2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
      <button type="button" :aria-pressed="lineNumbers === 'shown'" :aria-label="lazyStrings.EditorV4__line_numbers()" :title="lazyStrings.EditorV4__line_numbers()" tw-class="rounded p-1 hover:bg-gray-200 aria-pressed:bg-blue-100 dark:hover:bg-gray-700 dark:aria-pressed:bg-blue-950" @click="lineNumbers = lineNumbers === 'shown' ? 'hidden' : 'shown'"><ListOrderedIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      <button type="button" data-testid="editor-v4-wrap-toggle" :aria-pressed="wordWrap" :aria-label="lazyStrings.EditorV4__word_wrap()" :title="lazyStrings.EditorV4__word_wrap()" tw-class="rounded p-1 hover:bg-gray-200 aria-pressed:bg-blue-100 dark:hover:bg-gray-700 dark:aria-pressed:bg-blue-950" @click="wordWrap = !wordWrap"><WrapTextIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      <details tw-class="relative">
        <summary tw-class="cursor-pointer rounded px-1 py-1 hover:bg-gray-200 dark:hover:bg-gray-700">{{ lazyStrings.EditorV4__editor_options() }}</summary>
        <div tw-class="absolute bottom-full right-0 z-10 mb-1 w-max rounded border border-gray-200 bg-white p-1 shadow-md dark:border-gray-700 dark:bg-gray-900">
          <button type="button" tw-class="block w-full rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800" @click="selectOccurrences({ scope: 'next' })">{{ lazyStrings.EditorV4__select_next_occurrence() }}</button>
          <button type="button" tw-class="block w-full rounded px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800" @click="selectOccurrences({ scope: 'all' })">{{ lazyStrings.EditorV4__select_all_occurrences() }}</button>
          <button type="button" :aria-pressed="keyMap === 'emacs'" tw-class="block w-full rounded px-2 py-1 text-left hover:bg-gray-100 aria-pressed:bg-blue-100 dark:hover:bg-gray-800 dark:aria-pressed:bg-blue-950" @click="keyMap = keyMap === 'standard' ? 'emacs' : 'standard'">{{ lazyStrings.EditorV4__emacs_key_bindings() }}</button>
          <button type="button" :aria-pressed="statistics === 'shown'" tw-class="block w-full rounded px-2 py-1 text-left hover:bg-gray-100 aria-pressed:bg-blue-100 dark:hover:bg-gray-800 dark:aria-pressed:bg-blue-950" @click="statistics = statistics === 'shown' ? 'hidden' : 'shown'">{{ lazyStrings.EditorV4__document_statistics() }}</button>
        </div>
      </details>
      <span tw-class="tabular-nums">{{ lazyStrings.EditorV4__line_and_column({ line: caretLocation.line, column: caretLocation.column }) }}</span>
      <span v-if="selectionSize > 0" tw-class="tabular-nums">{{ lazyStrings.EditorV4__selected_characters({ count: selectionSize }) }}</span>
      <span v-if="statistics === 'shown'" tw-class="tabular-nums">{{ lazyStrings.EditorV4__document_counts({ lines: documentStatistics.lines, characters: documentStatistics.characters, words: documentStatistics.words }) }}</span>
    </footer>
  </section>
</template>

<style scoped>
.editor-surface {
  box-sizing: border-box;
  font: 13px/20px ui-monospace, monospace;
  font-variant-ligatures: none;
  tab-size: 4;
  padding: 8px 12px;
  white-space: pre;
  text-align: start;
  direction: ltr;
}

.editor-wrap {
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.editor-mirror {
  margin: 0;
  width: 100%;
  color: transparent;
}

.editor-line-marker {
  line-height: 20px;
}

.editor-match {
  background: rgb(250 204 21 / 33%);
}

.editor-active-match {
  background: rgb(251 146 60 / 45%);
}

.editor-secondary {
  background: rgb(59 130 246 / 40%);
}

.editor-caret {
  box-shadow: 1px 0 rgb(59 130 246);
}
</style>
