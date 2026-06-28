<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import {
  SearchIcon,
  ReplaceIcon,
  Undo2Icon,
  Redo2Icon,
  Trash2Icon,
  CopyIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  TypeIcon,
  HashIcon,
  PencilLineIcon,
  MousePointer2Icon,
  XIcon,
  LayersIcon,
  CheckIcon,
  WrapTextIcon,
  BarChart2Icon,
  AlignLeftIcon,
} from 'lucide-vue-next';
import { createAdvancedTextEditorV3WorkerClient } from '@/services/advanced-text-editor-v3/worker/client';
import type {
  AdvancedTextEditorV3Match,
  AdvancedTextEditorV3WorkerClient,
} from '@/services/advanced-text-editor-v3/worker/types';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

const props = defineProps<{
  initialValue: string,
  title: string | undefined,
  mode: 'advanced' | 'textarea',
}>();

const emit = defineEmits<{
  (e: 'update:content', { content }: { content: string }): void,
  (e: 'update:mode', { mode }: { mode: 'advanced' | 'textarea' }): void,
  (e: 'close'): void,
}>();

// --- Text Model Manager ---
function useTextModel({ initialValue }: {
  initialValue: string,
}) {
  const fullText = ref(initialValue);
  const lines = ref<string[]>(initialValue.split('\n'));

  // Atomic update that maintains consistency
  const updateContent = ({ text, immediateLines }: {
    text: string,
    immediateLines: boolean,
  }) => {
    fullText.value = text;
    if (immediateLines) {
      lines.value = text.split('\n');
    }
  };

  const syncLines = () => {
    lines.value = fullText.value.split('\n');
  };

  return { fullText, lines, updateContent, syncLines,
    TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    } };
}

const { fullText, lines, updateContent, syncLines } = useTextModel({
  initialValue: props.initialValue,
});

// --- Mode Management ---
const localMode = ref<'advanced' | 'textarea'>(props.mode);

watch(() => props.mode, (newVal) => {
  localMode.value = newVal;
});

function toggleMode() {
  const current = localMode.value;
  const nextMode = (() => {
    switch (current) {
    case 'advanced': return 'textarea';
    case 'textarea':
      // Sync lines before switching to advanced for accurate line numbers
      syncLines();
      return 'advanced';
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled mode: ${_ex}`);
    }
    }
  })();
  localMode.value = nextMode;
  emit('update:mode', { mode: nextMode });
}

// --- State ---
const findText = ref('');
const replaceText = ref('');
const caseSensitive = ref<'case-sensitive' | 'case-insensitive'>('case-insensitive');
const useRegex = ref<'regex-on' | 'regex-off'>('regex-off');
const searchMode = ref<'hidden' | 'visible'>('hidden');
const wrapMode = ref<'wrap-on' | 'wrap-off'>('wrap-on');

// Multi-Edit State
const isMultiEditMode = ref(false);
const multiEditInitialText = ref('');
const multiEditInitialContent = ref('');
const multiEditReplacement = ref('');
const multiEditMatches = ref<number[]>([]);

// History for Undo/Redo
const history = ref<string[][]>([[...lines.value]]);
const historyIndex = ref(0);
const MAX_HISTORY = 100;

// UI state
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const lineNumbersContentRef = ref<HTMLElement | null>(null);
const multiEditInputRef = ref<HTMLInputElement | null>(null);
const searchIndex = ref(-1);
const searchMatches = ref<AdvancedTextEditorV3Match[]>([]);
const showStats = ref(false);
const isSearchBusy = ref(false);
const isReplaceBusy = ref(false);
const isMultiEditBusy = ref(false);

// Line Height Calculation State
const lineHeights = ref<number[]>([]);
let ghostElement: HTMLDivElement | null = null;
let lineHeightDebounceTimer: ReturnType<typeof setTimeout> | undefined;

// Emacs kill ring
let killRing = '';

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKeyName = isMac ? 'Cmd' : 'Ctrl';
let workerClient: AdvancedTextEditorV3WorkerClient | undefined;
let searchRequestVersion = 0;
let multiEditRequestVersion = 0;

async function getWorkerClient() {
  if (!workerClient) {
    workerClient = await createAdvancedTextEditorV3WorkerClient();
  }
  return workerClient;
}

// --- Computed Stats ---
const stats = computed(() => {
  const lineCount = lines.value.length;

  if (!showStats.value) {
    return { chars: 0, words: 0, lines: lineCount, lineCount: lineCount };
  }

  const text = fullText.value;
  return {
    chars: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    lines: lineCount,
    lineCount: lineCount,
  };
});

// --- Line Height Measurement ---
const linesForLayout = computed(() => {
  const current = localMode.value;
  switch (current) {
  case 'advanced': return lines.value;
  case 'textarea': return null;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }
});

function calculateLineHeights() {
  if (!textareaRef.value) {
    lineHeights.value = [];
    return;
  }

  const currentMode = localMode.value;
  switch (currentMode) {
  case 'textarea':
    lineHeights.value = [];
    return;
  case 'advanced':
    break;
  default: {
    const _ex: never = currentMode;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }

  const currentWrapMode = wrapMode.value;
  switch (currentWrapMode) {
  case 'wrap-off':
    lineHeights.value = [];
    return;
  case 'wrap-on':
    break;
  default: {
    const _ex: never = currentWrapMode;
    throw new Error(`Unhandled wrap mode: ${_ex}`);
  }
  }

  const textarea = textareaRef.value;
  const win = textarea.ownerDocument.defaultView || window;
  if (!win || typeof win.getComputedStyle !== 'function') return;

  const style = win.getComputedStyle(textarea);
  if (!style) return;

  const width = textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const font = style.font;
  const lineHeightStr = style.lineHeight;
  const lineHeight = parseFloat(lineHeightStr) || 21;

  if (!ghostElement) {
    ghostElement = document.createElement('div');
    ghostElement.style.position = 'absolute';
    ghostElement.style.top = '-9999px';
    ghostElement.style.left = '-9999px';
    ghostElement.style.whiteSpace = 'pre-wrap';
    ghostElement.style.wordBreak = 'break-word';
    ghostElement.style.visibility = 'hidden';
    document.body.appendChild(ghostElement);
  }

  const ghost = ghostElement;
  ghost.style.width = `${width}px`;
  ghost.style.font = font;
  ghost.style.lineHeight = lineHeightStr;

  const heights = lines.value.map(line => {
    if (line === '') return lineHeight;
    ghost.textContent = line;
    if (line.length === 0) ghost.textContent = '\u200b';
    return ghost.clientHeight || lineHeight;
  });

  lineHeights.value = heights;
}

watch([linesForLayout, wrapMode], () => {
  if (linesForLayout.value === null) {
    lineHeights.value = [];
    return;
  }

  const currentWrapMode = wrapMode.value;
  switch (currentWrapMode) {
  case 'wrap-off':
    lineHeights.value = [];
    return;
  case 'wrap-on':
    if (lineHeightDebounceTimer) clearTimeout(lineHeightDebounceTimer);
    lineHeightDebounceTimer = setTimeout(() => {
      calculateLineHeights();
    }, 100);
    break;
  default: {
    const _ex: never = currentWrapMode;
    throw new Error(`Unhandled wrap mode: ${_ex}`);
  }
  }
}, { deep: true });

function recordHistory({ newLines }: { newLines: string[] }) {
  const current = history.value[historyIndex.value];
  if (current && current.length === newLines.length && current.every((l, i) => l === newLines[i])) return;

  if (historyIndex.value < history.value.length - 1) {
    history.value = history.value.slice(0, historyIndex.value + 1);
  }

  history.value.push(newLines);
  if (history.value.length > MAX_HISTORY) {
    history.value.shift();
  } else {
    historyIndex.value++;
  }
}

function handleUndo() {
  if (historyIndex.value > 0) {
    historyIndex.value--;
    const recovered = [...history.value[historyIndex.value]!];
    updateContent({ text: recovered.join('\n'), immediateLines: true });
  }
}

function handleRedo() {
  if (historyIndex.value < history.value.length - 1) {
    historyIndex.value++;
    const recovered = [...history.value[historyIndex.value]!];
    updateContent({ text: recovered.join('\n'), immediateLines: true });
  }
}

let historyTimeout: ReturnType<typeof setTimeout> | undefined;

// --- Helper: update lines from full text (for bulk operations like search/replace) ---
function setFullText({ text, recordInHistory }: {
  text: string,
  recordInHistory?: boolean | undefined,
}) {
  updateContent({ text, immediateLines: true });
  if (recordInHistory) {
    recordHistory({ newLines: text.split('\n') });
  }
}

// --- Search & Replace ---
function updateSearchState({ matches, preserveIndex }: {
  matches: AdvancedTextEditorV3Match[],
  preserveIndex: boolean,
}) {
  searchMatches.value = matches;
  if (matches.length === 0) {
    searchIndex.value = -1;
    return;
  }

  if (!preserveIndex || searchIndex.value === -1) {
    searchIndex.value = 0;
    return;
  }

  searchIndex.value = Math.min(searchIndex.value, matches.length - 1);
}

async function performSearch() {
  if (!findText.value) {
    searchRequestVersion += 1;
    searchMatches.value = [];
    searchIndex.value = -1;
    isSearchBusy.value = false;
    return;
  }

  const requestVersion = ++searchRequestVersion;
  isSearchBusy.value = true;

  try {
    const client = await getWorkerClient();
    const response = await client.searchText({
      request: {
        text: fullText.value,
        query: findText.value,
        caseSensitive: caseSensitive.value,
        useRegex: useRegex.value,
      },
    });
    if (requestVersion !== searchRequestVersion) {
      return;
    }
    updateSearchState({ matches: response.matches, preserveIndex: true });
  } catch (error) {
    if (requestVersion !== searchRequestVersion) {
      return;
    }
    searchMatches.value = [];
    searchIndex.value = -1;
    console.error('Search error:', error);
  } finally {
    if (requestVersion === searchRequestVersion) {
      isSearchBusy.value = false;
    }
  }
}

function highlightMatch({ index }: { index: number }) {
  const match = searchMatches.value[index];
  if (!match || !textareaRef.value) return;

  const el = textareaRef.value;
  el.focus();
  el.setSelectionRange(match.start, match.end);

  const lineHeight = 21;
  const linesBefore = fullText.value.substring(0, match.start).split('\n').length;
  el.scrollTop = (linesBefore - 5) * lineHeight;
}

function nextMatch() {
  if (searchMatches.value.length === 0) return;
  searchIndex.value = (searchIndex.value + 1) % searchMatches.value.length;
  highlightMatch({ index: searchIndex.value });
}

function prevMatch() {
  if (searchMatches.value.length === 0) return;
  searchIndex.value = (searchIndex.value - 1 + searchMatches.value.length) % searchMatches.value.length;
  highlightMatch({ index: searchIndex.value });
}

async function handleReplace({ mode }: { mode: 'single' | 'all' }) {
  if (!findText.value) return;
  isReplaceBusy.value = true;

  try {
    const client = await getWorkerClient();
    switch (mode) {
    case 'all': {
      const response = await client.replaceAll({
        request: {
          text: fullText.value,
          query: findText.value,
          replacement: replaceText.value,
          caseSensitive: caseSensitive.value,
          useRegex: useRegex.value,
        },
      });
      setFullText({ text: response.text, recordInHistory: true });
      updateSearchState({ matches: response.matches, preserveIndex: false });
      break;
    }
    case 'single': {
      const el = textareaRef.value;
      if (!el) return;
      const response = await client.replaceSingle({
        request: {
          text: fullText.value,
          query: findText.value,
          replacement: replaceText.value,
          caseSensitive: caseSensitive.value,
          useRegex: useRegex.value,
          selectionStart: el.selectionStart,
          selectionEnd: el.selectionEnd,
        },
      });

      if (!response.didReplace) {
        updateSearchState({ matches: response.matches, preserveIndex: true });
        nextMatch();
        return;
      }

      setFullText({ text: response.text, recordInHistory: true });
      updateSearchState({ matches: response.matches, preserveIndex: false });
      await nextTick();
      if (
        textareaRef.value &&
        response.replacementStart !== undefined &&
        response.replacementEnd !== undefined
      ) {
        textareaRef.value.setSelectionRange(response.replacementStart, response.replacementEnd);
      }
      break;
    }
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled replace mode: ${_ex}`);
    }
    }
  } finally {
    isReplaceBusy.value = false;
  }
}

// --- Cmd+D "Multi-Edit Mode" Implementation ---
async function handleCmdD() {
  const el = textareaRef.value;
  if (!el) return;

  isMultiEditBusy.value = true;
  try {
    const client = await getWorkerClient();
    const response = await client.prepareMultiEdit({
      request: {
        text: fullText.value,
        selectionStart: el.selectionStart,
        selectionEnd: el.selectionEnd,
      },
    });
    if (!response.selection) {
      return;
    }

    isMultiEditMode.value = true;
    multiEditInitialText.value = response.selection;
    multiEditInitialContent.value = fullText.value;
    multiEditReplacement.value = response.selection;
    multiEditMatches.value = response.matchStarts;

    if (response.selectionStart !== undefined && response.selectionEnd !== undefined) {
      el.setSelectionRange(response.selectionStart, response.selectionEnd);
    }
  } finally {
    isMultiEditBusy.value = false;
  }

  nextTick(() => {
    multiEditInputRef.value?.focus();
    multiEditInputRef.value?.select();
  });
}

function applyMultiEdit() {
  exitMultiEdit();
}

function exitMultiEdit() {
  multiEditRequestVersion += 1;
  isMultiEditBusy.value = false;
  isMultiEditMode.value = false;
  textareaRef.value?.focus();
}

watch(multiEditReplacement, async (newVal) => {
  if (isMultiEditMode.value) {
    const requestVersion = ++multiEditRequestVersion;
    isMultiEditBusy.value = true;
    try {
      const client = await getWorkerClient();
      const response = await client.applyMultiEdit({
        request: {
          text: multiEditInitialContent.value,
          target: multiEditInitialText.value,
          replacement: newVal,
        },
      });
      if (requestVersion !== multiEditRequestVersion) {
        return;
      }
      setFullText({ text: response.text });
    } finally {
      if (requestVersion === multiEditRequestVersion) {
        isMultiEditBusy.value = false;
      }
    }
  }
});

// --- Emacs Keybindings ---
function handleEmacsKeydown({ event }: { event: KeyboardEvent }) {
  // Only handle Ctrl+key (not Cmd on Mac for Emacs bindings)
  if (!event.ctrlKey || event.metaKey || event.altKey) return false;

  const el = textareaRef.value;
  if (!el) return false;
  if (document.activeElement !== el) return false;

  const text = fullText.value;
  const pos = el.selectionStart;

  switch (event.key) {
  case 'a': {
    // Move to beginning of line
    event.preventDefault();
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    el.setSelectionRange(lineStart, lineStart);
    return true;
  }
  case 'e': {
    // Move to end of line
    event.preventDefault();
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    el.setSelectionRange(lineEnd, lineEnd);
    return true;
  }
  case 'b': {
    // Move backward one character
    event.preventDefault();
    const newPos = Math.max(0, pos - 1);
    el.setSelectionRange(newPos, newPos);
    return true;
  }
  case 'n': {
    // Move to next line (down)
    event.preventDefault();
    const currentLineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const col = pos - currentLineStart;
    let nextLineStart = text.indexOf('\n', pos);
    if (nextLineStart === -1) return true; // Already on last line
    nextLineStart += 1;
    let nextLineEnd = text.indexOf('\n', nextLineStart);
    if (nextLineEnd === -1) nextLineEnd = text.length;
    const target = Math.min(nextLineStart + col, nextLineEnd);
    el.setSelectionRange(target, target);
    return true;
  }
  case 'p': {
    // Move to previous line (up)
    event.preventDefault();
    const curLineStart = text.lastIndexOf('\n', pos - 1) + 1;
    if (curLineStart === 0) return true; // Already on first line
    const col2 = pos - curLineStart;
    const prevLineEnd = curLineStart - 1; // the \n before this line
    const prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const target2 = Math.min(prevLineStart + col2, prevLineEnd);
    el.setSelectionRange(target2, target2);
    return true;
  }
  case 'k': {
    // Kill from cursor to end of line
    event.preventDefault();
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    // If cursor is already at end of line, kill the newline itself
    if (lineEnd === pos && pos < text.length) {
      lineEnd = pos + 1;
    }
    killRing = text.substring(pos, lineEnd);
    const before = text.substring(0, pos);
    const after = text.substring(lineEnd);
    setFullText({ text: before + after });
    nextTick(() => {
      el.setSelectionRange(pos, pos);
    });
    return true;
  }
  case 'h': {
    // Delete character before cursor (backspace)
    event.preventDefault();
    if (pos > 0) {
      const before = text.substring(0, pos - 1);
      const after = text.substring(pos);
      setFullText({ text: before + after });
      const newPos = pos - 1;
      nextTick(() => {
        el.setSelectionRange(newPos, newPos);
      });
    }
    return true;
  }
  case 'w': {
    // Kill word backward
    event.preventDefault();
    let wordStart = pos;
    // Skip whitespace backward
    while (wordStart > 0 && /\s/.test(text[wordStart - 1] || '')) wordStart--;
    // Skip word characters backward
    while (wordStart > 0 && /\S/.test(text[wordStart - 1] || '')) wordStart--;
    killRing = text.substring(wordStart, pos);
    const before = text.substring(0, wordStart);
    const after = text.substring(pos);
    setFullText({ text: before + after });
    nextTick(() => {
      el.setSelectionRange(wordStart, wordStart);
    });
    return true;
  }
  case 'y': {
    // Yank (paste) last killed text
    event.preventDefault();
    if (killRing) {
      const before = text.substring(0, pos);
      const after = text.substring(pos);
      setFullText({ text: before + killRing + after });
      const newPos = pos + killRing.length;
      nextTick(() => {
        el.setSelectionRange(newPos, newPos);
      });
    }
    return true;
  }
  case 't': {
    // Transpose two characters before cursor
    event.preventDefault();
    if (pos >= 2) {
      const chars = text.split('');
      const tmp = chars[pos - 2]!;
      chars[pos - 2] = chars[pos - 1]!;
      chars[pos - 1] = tmp;
      setFullText({ text: chars.join('') });
      nextTick(() => {
        el.setSelectionRange(pos, pos);
      });
    }
    return true;
  }
  default:
    return false;
  }
}

// --- Utils ---
function copyToClipboard() {
  navigator.clipboard.writeText(fullText.value);
}

function handleClose() {
  emit('update:content', { content: fullText.value });
  emit('close');
}

function handleBackdropClick({ event }: { event: MouseEvent }) {
  if (event.target === event.currentTarget) {
    handleClose();
  }
}

function syncScroll() {
  if (textareaRef.value && lineNumbersContentRef.value) {
    const scrollTop = textareaRef.value.scrollTop;
    lineNumbersContentRef.value.style.transform = `translateY(-${scrollTop}px)`;
  }
}

function handleScroll() {
  requestAnimationFrame(syncScroll);
}

function toggleWrap() {
  const current = wrapMode.value;
  switch (current) {
  case 'wrap-on': wrapMode.value = 'wrap-off'; break;
  case 'wrap-off': wrapMode.value = 'wrap-on'; break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled wrap mode: ${_ex}`);
  }
  }
}

// --- Handle textarea input (line-based update) ---
function handleInput() {
  if (!textareaRef.value) return;
  const newText = textareaRef.value.value;
  fullText.value = newText;

  if (historyTimeout) clearTimeout(historyTimeout);

  const currentMode = localMode.value;
  switch (currentMode) {
  case 'advanced':
    // Immediate split for line numbers
    lines.value = newText.split('\n');
    historyTimeout = setTimeout(() => {
      recordHistory({ newLines: [...lines.value] });
    }, 500);
    break;
  case 'textarea':
    // Debounce split for history and stats to keep typing fast
    historyTimeout = setTimeout(() => {
      lines.value = newText.split('\n');
      recordHistory({ newLines: [...lines.value] });
    }, 500);
    break;
  default: {
    const _ex: never = currentMode;
    throw new Error(`Unhandled mode: ${_ex}`);
  }
  }
}

// Shortcuts
function handleKeyDown({ event }: { event: KeyboardEvent }) {
  const isMod = event.ctrlKey || event.metaKey;

  // Emacs keybindings (Ctrl only, not Cmd on Mac)
  // Check before other shortcuts. Ctrl+F and Ctrl+D are excluded (handled below as search/multi-edit).
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key !== 'f' && event.key !== 'd' && event.key !== 'z') {
    if (handleEmacsKeydown({ event })) return;
  }

  if (isMod && event.key === 'f') {
    event.preventDefault();
    const selection = window.getSelection()?.toString();
    if (selection) {
      findText.value = selection;
      void performSearch();
    }
    searchMode.value = 'visible';
    nextTick(() => {
      const findInput = document.querySelector('[data-testid="find-input"]') as HTMLInputElement;
      findInput?.focus();
      if (selection) findInput?.select();
    });
  }
  if (isMod && event.key === 'd') {
    event.preventDefault();
    void handleCmdD();
  }
  if (isMod && event.key === 'z') {
    event.preventDefault();
    if (event.shiftKey) handleRedo();
    else handleUndo();
  }
  if (event.key === 'Escape') {
    if (isMultiEditMode.value) {
      exitMultiEdit();
      return;
    }
    const currentSearchMode = searchMode.value;
    switch (currentSearchMode) {
    case 'visible':
      searchMode.value = 'hidden';
      textareaRef.value?.focus();
      break;
    case 'hidden':
      handleClose();
      break;
    default: {
      const _ex: never = currentSearchMode;
      throw new Error(`Unhandled search mode: ${_ex}`);
    }
    }
  }
}

useEventTargetListener(window, 'keydown', (event) => {
  handleKeyDown({ event });
});
useEventTargetListener(window, 'resize', calculateLineHeights);

onMounted(() => {
  void getWorkerClient();
  nextTick(() => {
    textareaRef.value?.focus();
    syncScroll();
    calculateLineHeights();
  });
});

onUnmounted(() => {
  if (historyTimeout) clearTimeout(historyTimeout);
  if (lineHeightDebounceTimer) clearTimeout(lineHeightDebounceTimer);
  if (ghostElement && ghostElement.parentNode) {
    ghostElement.parentNode.removeChild(ghostElement);
  }
  if (workerClient) {
    void workerClient.dispose();
  }
});

defineExpose({
  TEST_ONLY: {
    isMultiEditMode,
    isMultiEditBusy,
    isSearchBusy,
    searchMatches,
    history,
    historyIndex,
    wrapMode,
    calculateLineHeights,
    lineHeights,
    lines,
  },
});
</script>

<template>
  <!-- Backdrop Container -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/5 backdrop-blur-[0.2px] p-4 md:p-8 transition-opacity"
    @click="handleBackdropClick({ event: $event })"
    data-testid="editor-backdrop"
  >
    <!-- Editor Container -->
    <div
      class="w-full h-full max-w-5xl flex bg-white dark:bg-[#0f172a] border border-gray-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)] ring-1 ring-black/5 dark:ring-white/5"
      @click.stop
      data-testid="advanced-text-editor"
    >
      <!-- Main Content Area -->
      <div class="flex-1 flex flex-col min-w-0 bg-transparent relative">
        <!-- Search Overlay -->
        <Transition
          enter-active-class="transition duration-300 ease-out"
          enter-from-class="opacity-0 -translate-y-2"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition duration-200 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-2"
        >
          <div v-if="searchMode === 'visible'" class="px-6 py-4 border-b border-gray-100 dark:border-white/10 bg-gray-50/90 dark:bg-slate-950/95 backdrop-blur-md flex flex-col gap-3 z-30">
            <div class="flex items-center gap-3">
              <div class="relative flex-1 group">
                <input
                  v-model="findText"
                  @input="void performSearch()"
                  @keydown.enter="nextMatch"
                  :placeholder="lazyStrings.advancedTextEditor__search()"
                  class="w-full pl-10 pr-32 py-2 bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all placeholder:text-gray-400 font-mono"
                  data-testid="find-input"
                />
                <SearchIcon class="absolute left-3.5 top-2.5 w-4 h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
                <div v-if="findText" class="absolute right-2 top-1.5 flex items-center gap-2 bg-gray-50 dark:bg-white/10 px-2 py-1 rounded-lg border border-gray-200 dark:border-white/10">
                  <span
                    v-if="isSearchBusy"
                    class="text-[10px] text-blue-500 font-mono font-bold"
                    data-testid="search-busy-indicator"
                  >
                    ...
                  </span>
                  <span class="text-[10px] text-gray-400 font-mono font-bold">{{ searchMatches.length > 0 ? searchIndex + 1 : 0 }}/{{ searchMatches.length }}</span>
                  <div class="h-3 w-px bg-gray-300 dark:bg-white/20"></div>
                  <div class="flex items-center">
                    <button @click="prevMatch" :disabled="isSearchBusy" class="p-0.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors disabled:opacity-40"><ArrowUpIcon class="w-3.5 h-3.5 text-gray-400" /></button>
                    <button @click="nextMatch" :disabled="isSearchBusy" class="p-0.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors disabled:opacity-40"><ArrowDownIcon class="w-3.5 h-3.5 text-gray-400" /></button>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 bg-white dark:bg-black/20 p-1 border border-gray-200 dark:border-white/10 rounded-xl">
                <button
                  @click="caseSensitive = caseSensitive === 'case-sensitive' ? 'case-insensitive' : 'case-sensitive'; void performSearch()"
                  class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all"
                  :class="caseSensitive === 'case-sensitive' ? 'bg-blue-500/20 text-blue-400 shadow-inner' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-white/10'"
                  :title="lazyStrings.advancedTextEditor__match_case()"
                >
                  {{ lazyStrings.advancedTextEditor__aa() }}
                </button>
                <button
                  @click="useRegex = useRegex === 'regex-on' ? 'regex-off' : 'regex-on'; void performSearch()"
                  class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all"
                  :class="useRegex === 'regex-on' ? 'bg-blue-500/20 text-blue-400 shadow-inner' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-white/10'"
                  :title="lazyStrings.advancedTextEditor__use_regex()"
                >
                  .*
                </button>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <div class="relative flex-1 group">
                <input
                  v-model="replaceText"
                  @keydown.enter="void handleReplace({ mode: 'single' })"
                  :placeholder="lazyStrings.advancedTextEditor__replace_with()"
                  class="w-full pl-10 pr-4 py-2 bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all placeholder:text-gray-400 font-mono"
                  data-testid="replace-input"
                />
                <ReplaceIcon class="absolute left-3.5 top-2.5 w-4 h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
              </div>
              <div class="flex items-center gap-2">
                <button
                  @click="void handleReplace({ mode: 'single' })"
                  :disabled="isReplaceBusy"
                  class="px-4 py-2 text-[11px] font-bold uppercase tracking-wider bg-white dark:bg-white/10 hover:bg-gray-50 dark:hover:bg-white/20 text-gray-600 dark:text-gray-200 rounded-xl transition-all border border-gray-200 dark:border-white/10 shadow-sm disabled:opacity-40"
                  data-testid="replace-button"
                >
                  {{ lazyStrings.advancedTextEditor__replace() }}
                </button>
                <button
                  @click="void handleReplace({ mode: 'all' })"
                  :disabled="isReplaceBusy"
                  class="px-4 py-2 text-[11px] font-bold uppercase tracking-wider bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all shadow-lg shadow-blue-500/20 disabled:opacity-40"
                  data-testid="replace-all-button"
                >
                  {{ lazyStrings.advancedTextEditor__replace_all() }}
                </button>
                <div class="w-px h-6 bg-gray-200 dark:bg-white/10 mx-1"></div>
                <button @click="searchMode = 'hidden'" class="p-2 hover:bg-gray-200 dark:hover:bg-white/10 rounded-xl text-gray-400 transition-colors">
                  <XIcon class="w-4 h-4" />
                </button>
              </div>
            </div>
            <div class="flex items-center justify-between mt-1 px-1">
              <div class="text-[9px] text-gray-400 font-medium flex items-center gap-3">
                <span class="flex items-center gap-1"><LayersIcon class="w-3 h-3" /> {{ lazyStrings.advancedTextEditor__multi_edit_occurrence_with_shortcut({ shortcut: `${modKeyName}+D` }) }}</span>
                <span class="flex items-center gap-1"><CheckIcon class="w-3 h-3" /> {{ lazyStrings.advancedTextEditor__enter_to_find_next() }}</span>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Editor Canvas -->
        <div class="flex-1 flex flex-col min-h-0 bg-transparent relative group/editor">
          <!-- Line Numbers Area -->
          <div
            v-if="localMode === 'advanced'"
            class="absolute left-0 top-0 bottom-0 w-12 border-r border-gray-50 dark:border-white/10 overflow-hidden pointer-events-none select-none bg-gray-50 dark:bg-[#0f172a] z-20"
          >
            <!-- Inner container that moves with transform -->
            <div ref="lineNumbersContentRef" class="flex flex-col items-center py-5 text-[10px] font-mono text-gray-300 dark:text-gray-500 will-change-transform">
              <template v-if="wrapMode === 'wrap-on' && lineHeights.length > 0">
                <div
                  v-for="(height, i) in lineHeights"
                  :key="i"
                  class="flex-shrink-0 flex items-start justify-center"
                  :style="{ height: `${height}px` }"
                >
                  <span class="leading-[21px]">{{ i + 1 }}</span>
                </div>
              </template>
              <template v-else>
                <div v-for="n in stats.lineCount" :key="n" class="h-[21px] leading-[21px] flex-shrink-0">{{ n }}</div>
              </template>
              <div style="height: 80vh" class="flex-shrink-0"></div>
            </div>
          </div>

          <textarea
            ref="textareaRef"
            :value="fullText"
            @input="handleInput"
            @scroll="handleScroll"
            class="w-full h-full pr-16 py-5 font-mono text-sm bg-transparent outline-none resize-none text-gray-800 dark:text-gray-200 leading-[21px] selection:bg-blue-500/45 selection:text-white overscroll-area z-10 transition-all duration-200"
            :class="[
              (() => {
                const current = wrapMode;
                switch (current) {
                case 'wrap-off': return 'whitespace-pre overflow-x-auto';
                case 'wrap-on': return 'whitespace-pre-wrap overflow-x-hidden';
                }
              })(),
              (() => {
                const current = localMode;
                switch (current) {
                case 'advanced': return 'pl-16';
                case 'textarea': return 'pl-5';
                }
              })()
            ]"
            spellcheck="false"
            :wrap="wrapMode === 'wrap-on' ? 'soft' : 'off'"
            data-testid="advanced-textarea"
          ></textarea>

          <!-- Empty State Watermark -->
          <div v-if="lines.length <= 1 && !lines[0]" class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.02] dark:opacity-[0.03]">
            <PencilLineIcon class="w-64 h-64" />
          </div>
        </div>

        <!-- Multi-Edit Overlay -->
        <Transition
          enter-active-class="transition duration-300 ease-out"
          enter-from-class="opacity-0 translate-y-4 scale-95"
          enter-to-class="opacity-100 translate-y-0 scale-100"
          leave-active-class="transition duration-200 ease-in"
          leave-from-class="opacity-100 translate-y-0 scale-100"
          leave-to-class="opacity-0 translate-y-4 scale-95"
        >
          <div v-if="isMultiEditMode" class="absolute bottom-12 left-1/2 -translate-x-1/2 w-96 z-50 bg-white dark:bg-slate-900 border border-amber-500/30 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] p-4 ring-1 ring-black/5">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <div class="p-1.5 bg-amber-500/10 rounded-lg text-amber-500">
                  <LayersIcon class="w-3.5 h-3.5" />
                </div>
                <div class="flex flex-col">
                  <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.advancedTextEditor__multi_edit_mode() }}</span>
                  <span class="text-[11px] text-amber-500/90 font-mono truncate max-w-[200px]" :title="multiEditInitialText">
                    {{ lazyStrings.advancedTextEditor__renaming_text({ text: multiEditInitialText }) }}
                  </span>
                </div>
              </div>
              <span class="text-[10px] font-bold text-amber-500/80 px-2 py-0.5 bg-amber-500/5 rounded-full border border-amber-500/20">
                {{ lazyStrings.advancedTextEditor__instance_count({ count: multiEditMatches.length }) }}
              </span>
            </div>

            <div class="relative group">
              <input
                ref="multiEditInputRef"
                v-model="multiEditReplacement"
                @keydown.enter="applyMultiEdit"
                @keydown.esc="exitMultiEdit"
                :placeholder="lazyStrings.advancedTextEditor__type_to_replace_all()"
                class="w-full px-4 py-2.5 bg-gray-50 dark:bg-black/40 border border-gray-100 dark:border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all font-mono placeholder:text-gray-500 text-white"
                data-testid="multi-edit-input"
              />
              <div class="absolute right-3 top-2.5 flex items-center gap-1">
                <button @click="applyMultiEdit" :disabled="isMultiEditBusy" class="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-400 hover:text-green-500 transition-colors disabled:opacity-40" :title="lazyStrings.advancedTextEditor__confirm_enter()">
                  <CheckIcon class="w-4 h-4" />
                </button>
                <button @click="exitMultiEdit" class="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-400 hover:text-red-500 transition-colors" :title="lazyStrings.advancedTextEditor__cancel_esc()">
                  <XIcon class="w-4 h-4" />
                </button>
              </div>
            </div>
            <div class="mt-2 text-[9px] text-gray-400 text-center font-medium">
              <span v-if="isMultiEditBusy" data-testid="multi-edit-busy-indicator">{{ lazyStrings.advancedTextEditor__updating() }}</span>
              <span v-else>{{ lazyStrings.advancedTextEditor__type_to_rename_all() }} <span class="text-gray-500">{{ lazyStrings.advancedTextEditor__enter() }}</span> {{ lazyStrings.advancedTextEditor__to_apply() }} <span class="text-gray-500">{{ lazyStrings.advancedTextEditor__esc() }}</span> {{ lazyStrings.advancedTextEditor__to_cancel() }}</span>
            </div>
          </div>
        </Transition>

        <!-- Footer Info Bar -->
        <div v-if="showStats" class="h-9 border-t border-gray-100 dark:border-white/10 flex items-center justify-between px-6 bg-white dark:bg-[#0f172a] text-[10px] font-bold uppercase tracking-widest text-gray-400 z-30 relative shrink-0">
          <div class="flex items-center gap-6">
            <span class="flex items-center gap-1.5"><TypeIcon class="w-3 h-3 text-blue-500/50" /> {{ stats.chars }} <span class="opacity-40 font-medium">{{ lazyStrings.advancedTextEditor__chars() }}</span></span>
            <span class="flex items-center gap-1.5"><PencilLineIcon class="w-3 h-3 text-amber-500/50" /> {{ stats.words }} <span class="opacity-40 font-medium">{{ lazyStrings.advancedTextEditor__words() }}</span></span>
            <span class="flex items-center gap-1.5"><HashIcon class="w-3 h-3 text-emerald-500/50" /> {{ stats.lines }} <span class="opacity-40 font-medium">{{ lazyStrings.advancedTextEditor__lines() }}</span></span>
          </div>

          <div class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <MousePointer2Icon class="w-3 h-3 text-purple-500/50" />
              <span class="opacity-40 font-medium">{{ lazyStrings.advancedTextEditor__selection() }}</span>
              <span>{{ textareaRef?.selectionEnd ? textareaRef.selectionEnd - textareaRef.selectionStart : 0 }}</span>
            </div>
            <div class="h-3 w-px bg-gray-200 dark:border-white/10"></div>
            <span class="text-blue-500/80">{{ historyIndex + 1 }}/{{ history.length }} <span class="opacity-40 font-medium">{{ lazyStrings.advancedTextEditor__steps() }}</span></span>
          </div>
        </div>
      </div>

      <!-- Sidebar (Right) -->
      <div class="w-12 border-l border-gray-100 dark:border-white/10 flex flex-col items-center py-4 gap-4 bg-gray-50 dark:bg-slate-950/50 z-30 shrink-0">
        <button
          @click="handleClose"
          class="p-2.5 bg-gray-200 dark:bg-white/10 hover:bg-gray-300 dark:hover:bg-white/20 rounded-xl transition-all shadow-sm text-gray-600 dark:text-gray-300 mb-2 group"
          :title="lazyStrings.advancedTextEditor__close_editor_esc()"
          data-testid="close-button"
        >
          <XIcon class="w-4.5 h-4.5 group-hover:scale-110 transition-transform" />
        </button>

        <div class="h-px w-6 bg-gray-200 dark:bg-white/10"></div>

        <div class="flex flex-col gap-1">
          <button
            @click="handleUndo"
            :disabled="historyIndex <= 0"
            class="p-2.5 hover:bg-white dark:hover:bg-white/5 rounded-xl disabled:opacity-30 transition-all hover:shadow-sm group"
            :title="lazyStrings.advancedTextEditor__undo_with_shortcut({ shortcut: `${modKeyName}+Z` })"
          >
            <Undo2Icon class="w-4.5 h-4.5 text-gray-500 group-hover:text-blue-500" />
          </button>
          <button
            @click="handleRedo"
            :disabled="historyIndex >= history.length - 1"
            class="p-2.5 hover:bg-white dark:hover:bg-white/5 rounded-xl disabled:opacity-30 transition-all hover:shadow-sm group"
            :title="lazyStrings.advancedTextEditor__redo_with_shortcut({ shortcut: `${modKeyName}+Shift+Z` })"
          >
            <Redo2Icon class="w-4.5 h-4.5 text-gray-500 group-hover:text-blue-500" />
          </button>
        </div>

        <div class="h-px w-6 bg-gray-200 dark:bg-white/10"></div>

        <div class="flex flex-col gap-1">
          <button
            @click="toggleMode"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="localMode === 'textarea' ? 'bg-orange-500/20 text-orange-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            :title="localMode === 'textarea' ? lazyStrings.advancedTextEditor__switch_to_advanced_editor() : lazyStrings.advancedTextEditor__switch_to_normal_textarea()"
            data-testid="toggle-mode-button"
          >
            <AlignLeftIcon class="w-4.5 h-4.5" />
          </button>
          <button
            @click="searchMode = searchMode === 'visible' ? 'hidden' : 'visible'"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="searchMode === 'visible' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            :title="lazyStrings.advancedTextEditor__find_and_replace_with_shortcut({ shortcut: `${modKeyName}+F` })"
          >
            <SearchIcon class="w-4.5 h-4.5" />
          </button>
          <button
            @click="showStats = !showStats"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="showStats ? 'bg-purple-500/20 text-purple-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            :title="lazyStrings.advancedTextEditor__toggle_stats()"
          >
            <BarChart2Icon class="w-4.5 h-4.5" />
          </button>
          <button
            @click="void handleCmdD()"
            class="p-2.5 rounded-xl hover:bg-white dark:hover:bg-white/5 transition-all hover:shadow-sm group text-gray-500"
            :title="lazyStrings.advancedTextEditor__multi_edit_occurrence_with_shortcut({ shortcut: `${modKeyName}+D` })"
          >
            <LayersIcon class="w-4.5 h-4.5 group-hover:text-amber-500" />
          </button>
          <button
            @click="toggleWrap"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="wrapMode === 'wrap-on' ? 'bg-indigo-500/20 text-indigo-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            :title="lazyStrings.advancedTextEditor__toggle_word_wrap()"
          >
            <WrapTextIcon class="w-4.5 h-4.5" />
          </button>
        </div>

        <div class="mt-auto flex flex-col gap-1 mb-2">
          <button
            @click="copyToClipboard"
            class="p-2.5 hover:bg-white dark:hover:bg-white/5 rounded-xl transition-all hover:shadow-sm text-gray-500 hover:text-blue-500"
            :title="lazyStrings.advancedTextEditor__copy_all()"
          >
            <CopyIcon class="w-4.5 h-4.5" />
          </button>
          <button
            @click="setFullText({ text: '' })"
            class="p-2.5 hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 rounded-xl transition-all"
            :title="lazyStrings.advancedTextEditor__clear_all()"
          >
            <Trash2Icon class="w-4.5 h-4.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
textarea {
  tab-size: 4;
  caret-color: #3b82f6;
  padding-bottom: 80vh;
}

/* Custom scrollbar */
textarea::-webkit-scrollbar {
  width: 14px;
}
textarea::-webkit-scrollbar-track {
  background: transparent;
}
textarea::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.1);
  border: 4px solid transparent;
  background-clip: content-box;
  border-radius: 20px;
}
textarea::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.2);
  border: 4px solid transparent;
  background-clip: content-box;
}

.dark textarea::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.05);
  border: 4px solid transparent;
  background-clip: content-box;
}
.dark textarea::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.1);
  border: 4px solid transparent;
  background-clip: content-box;
}

/* Enhanced Selection highlight */
textarea::selection {
  background: rgba(59, 130, 246, 0.45);
  color: #fff;
}

.animate-in {
  animation-fill-mode: forwards;
}

@keyframes slide-in-from-left {
  from { transform: translateX(-10px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.slide-in-from-left-2 {
  animation: slide-in-from-left 0.2s cubic-bezier(0, 0, 0.2, 1);
}
</style>
