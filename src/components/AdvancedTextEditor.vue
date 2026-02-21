<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import {
  Search,
  Replace,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  ArrowDown,
  ArrowUp,
  Type,
  Hash,
  PencilLine,
  MousePointer2,
  X,
  Layers,
  Check,
  WrapText,
  BarChart2,
} from 'lucide-vue-next';

const props = defineProps<{
  initialValue: string;
  title: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'update:content', { content }: { content: string }): void;
  (e: 'close'): void;
}>();

// --- State ---
const content = ref(props.initialValue);
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
const history = ref<string[]>([props.initialValue]);
const historyIndex = ref(0);
const MAX_HISTORY = 100;

// UI state
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const lineNumbersContentRef = ref<HTMLElement | null>(null); // Inner container for transform
const multiEditInputRef = ref<HTMLInputElement | null>(null);
const searchIndex = ref(-1);
const searchMatches = ref<{ start: number; end: number }[]>([]);
const showStats = ref(false);

// Line Height Calculation State
const lineHeights = ref<number[]>([]);
let ghostElement: HTMLDivElement | null = null;
let lineHeightDebounceTimer: ReturnType<typeof setTimeout> | undefined;

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKeyName = isMac ? 'Cmd' : 'Ctrl';

// --- Computed Stats ---
const stats = computed(() => {
  const text = content.value;

  // Optimize line counting: Always calculate this as it's needed for line numbers
  // when word wrap is disabled, regardless of whether stats are shown.
  let lineCount = 1;
  if (text.length === 0) {
    lineCount = 0;
  } else {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') lineCount++;
    }
  }

  if (!showStats.value) {
    return { chars: 0, words: 0, lines: lineCount, lineCount: lineCount };
  }

  return {
    chars: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    lines: lineCount,
    lineCount: lineCount,
  };
});
// --- Line Height Measurement ---
function calculateLineHeights() {
  if (!textareaRef.value) {
    lineHeights.value = [];
    return;
  }

  // If wrapping is off, we don't need expensive calculations.
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
  const style = window.getComputedStyle(textarea);
  const width = textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const font = style.font;
  const lineHeightStr = style.lineHeight;
  const lineHeight = parseFloat(lineHeightStr) || 21;

  // Create or reuse ghost element for measurement
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

  const lines = content.value.split('\n');

  // Use a document fragment or batch updates if possible, but for layout thrashing,
  // we just need to minimize DOM reflows. Reading layout properties forces reflow.
  // We can't easily batch reads here without losing sync.
  // However, debouncing the whole operation is the key.

  const heights = lines.map(line => {
    if (line === '') return lineHeight;
    ghost.textContent = line;
    if (line.length === 0) ghost.textContent = '\u200b';
    return ghost.clientHeight || lineHeight;
  });

  lineHeights.value = heights;
}

watch([content, wrapMode], () => {
  const currentWrapMode = wrapMode.value;
  switch (currentWrapMode) {
  case 'wrap-off':
    // No calculation needed for wrap-off, just clear heights immediately
    lineHeights.value = [];
    return;
  case 'wrap-on':
    // Debounce for wrap-on mode to prevent typing lag
    if (lineHeightDebounceTimer) clearTimeout(lineHeightDebounceTimer);
    lineHeightDebounceTimer = setTimeout(() => {
      calculateLineHeights();
    }, 100); // 100ms delay to unblock the UI thread during rapid typing
    break;
  default: {
    const _ex: never = currentWrapMode;
    throw new Error(`Unhandled wrap mode: ${_ex}`);
  }
  }
});
// --- History Management ---
function recordHistory({ newContent }: { newContent: string }) {
  if (newContent === history.value[historyIndex.value]) return;

  if (historyIndex.value < history.value.length - 1) {
    history.value = history.value.slice(0, historyIndex.value + 1);
  }

  history.value.push(newContent);
  if (history.value.length > MAX_HISTORY) {
    history.value.shift();
  } else {
    historyIndex.value++;
  }
}

function handleUndo() {
  if (historyIndex.value > 0) {
    historyIndex.value--;
    content.value = history.value[historyIndex.value]!;
  }
}

function handleRedo() {
  if (historyIndex.value < history.value.length - 1) {
    historyIndex.value++;
    content.value = history.value[historyIndex.value]!;
  }
}

let historyTimeout: ReturnType<typeof setTimeout> | undefined;
watch(content, (newVal) => {
  emit('update:content', { content: newVal });

  if (historyTimeout) clearTimeout(historyTimeout);
  historyTimeout = setTimeout(() => {
    recordHistory({ newContent: newVal });
  }, 500);
});

// --- Search & Replace ---
function performSearch() {
  if (!findText.value) {
    searchMatches.value = [];
    searchIndex.value = -1;
    return;
  }

  const matches: { start: number; end: number }[] = [];
  const text = content.value;
  const query = findText.value;

  const currentUseRegex = useRegex.value;
  switch (currentUseRegex) {
  case 'regex-on': {
    const currentCaseSensitive = caseSensitive.value;
    const flags = (() => {
      switch (currentCaseSensitive) {
      case 'case-insensitive': return 'gi';
      case 'case-sensitive': return 'g';
      default: {
        const _ex: never = currentCaseSensitive;
        throw new Error(`Unhandled case sensitivity: ${_ex}`);
      }
      }
    })();
    try {
      const re = new RegExp(query, flags);
      let match;
      while ((match = re.exec(text)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length });
        if (!re.global) break;
      }
    } catch (e) {
      console.error('Search error:', e);
    }
    break;
  }
  case 'regex-off': {
    const currentCaseSensitive = caseSensitive.value;
    const { searchStr, targetStr } = (() => {
      switch (currentCaseSensitive) {
      case 'case-insensitive':
        return { searchStr: query.toLowerCase(), targetStr: text.toLowerCase() };
      case 'case-sensitive':
        return { searchStr: query, targetStr: text };
      default: {
        const _ex: never = currentCaseSensitive;
        throw new Error(`Unhandled case sensitivity: ${_ex}`);
      }
      }
    })();

    let pos = targetStr.indexOf(searchStr);
    while (pos !== -1) {
      matches.push({ start: pos, end: pos + searchStr.length });
      pos = targetStr.indexOf(searchStr, pos + 1);
    }
    break;
  }
  default: {
    const _ex: never = currentUseRegex;
    throw new Error(`Unhandled regex mode: ${_ex}`);
  }
  }

  searchMatches.value = matches;
  if (matches.length > 0) {
    if (searchIndex.value === -1) searchIndex.value = 0;
    else if (searchIndex.value >= matches.length) searchIndex.value = matches.length - 1;
  } else {
    searchIndex.value = -1;
  }
}

function highlightMatch({ index }: { index: number }) {
  const match = searchMatches.value[index];
  if (!match || !textareaRef.value) return;

  const el = textareaRef.value;
  el.focus();
  el.setSelectionRange(match.start, match.end);

  const lineHeight = 21;
  const linesBefore = content.value.substring(0, match.start).split('\n').length;
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

function handleReplace({ mode }: { mode: 'single' | 'all' }) {
  if (!findText.value) return;

  switch (mode) {
  case 'all': {
    let newContent = '';
    const currentUseRegex = useRegex.value;
    switch (currentUseRegex) {
    case 'regex-on': {
      const currentCaseSensitive = caseSensitive.value;
      const flags = (() => {
        switch (currentCaseSensitive) {
        case 'case-insensitive': return 'gi';
        case 'case-sensitive': return 'g';
        default: {
          const _ex: never = currentCaseSensitive;
          throw new Error(`Unhandled case sensitivity: ${_ex}`);
        }
        }
      })();
      const re = new RegExp(findText.value, flags);
      newContent = content.value.replace(re, replaceText.value);
      break;
    }
    case 'regex-off': {
      const currentCaseSensitive = caseSensitive.value;
      switch (currentCaseSensitive) {
      case 'case-insensitive': {
        const re = new RegExp(findText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        newContent = content.value.replace(re, replaceText.value);
        break;
      }
      case 'case-sensitive':
        newContent = content.value.split(findText.value).join(replaceText.value);
        break;
      default: {
        const _ex: never = currentCaseSensitive;
        throw new Error(`Unhandled case sensitivity: ${_ex}`);
      }
      }
      break;
    }
    default: {
      const _ex: never = currentUseRegex;
      throw new Error(`Unhandled regex mode: ${_ex}`);
    }
    }
    content.value = newContent;
    performSearch();
    break;
  }
  case 'single': {
    const el = textareaRef.value;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selection = content.value.substring(start, end);

    const isMatch = (() => {
      const currentUseRegex = useRegex.value;
      switch (currentUseRegex) {
      case 'regex-on': {
        const currentCaseSensitive = caseSensitive.value;
        const flags = (() => {
          switch (currentCaseSensitive) {
          case 'case-insensitive': return 'i';
          case 'case-sensitive': return '';
          default: {
            const _ex: never = currentCaseSensitive;
            throw new Error(`Unhandled case sensitivity: ${_ex}`);
          }
          }
        })();
        const re = new RegExp(findText.value, flags);
        return re.test(selection);
      }
      case 'regex-off': {
        const currentCaseSensitive = caseSensitive.value;
        switch (currentCaseSensitive) {
        case 'case-insensitive':
          return selection.toLowerCase() === findText.value.toLowerCase();
        case 'case-sensitive':
          return selection === findText.value;
        default: {
          const _ex: never = currentCaseSensitive;
          throw new Error(`Unhandled case sensitivity: ${_ex}`);
        }
        }
      }
      default: {
        const _ex: never = currentUseRegex;
        throw new Error(`Unhandled regex mode: ${_ex}`);
      }
      }
    })();

    if (isMatch) {
      const before = content.value.substring(0, start);
      const after = content.value.substring(end);
      content.value = before + replaceText.value + after;

      nextTick(() => {
        performSearch();
      });
    } else {
      nextMatch();
    }
    break;
  }
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled replace mode: ${_ex}`);
  }
  }
}

// --- Cmd+D "Multi-Edit Mode" Implementation ---
function handleCmdD() {
  const el = textareaRef.value;
  if (!el) return;

  let selection = content.value.substring(el.selectionStart, el.selectionEnd);

  if (!selection) {
    const text = content.value;
    let wordStart = el.selectionStart;
    while (wordStart > 0 && /\w/.test(text[wordStart - 1] || '')) wordStart--;
    let wordEnd = el.selectionEnd;
    while (wordEnd < text.length && /\w/.test(text[wordEnd] || '')) wordEnd++;

    if (wordStart !== wordEnd) {
      el.setSelectionRange(wordStart, wordEnd);
      selection = text.substring(wordStart, wordEnd);
    } else {
      return;
    }
  }

  isMultiEditMode.value = true;
  multiEditInitialText.value = selection;
  multiEditInitialContent.value = content.value;
  multiEditReplacement.value = selection;

  const matches: number[] = [];
  let pos = content.value.indexOf(selection);
  while (pos !== -1) {
    matches.push(pos);
    pos = content.value.indexOf(selection, pos + 1);
  }
  multiEditMatches.value = matches;

  nextTick(() => {
    multiEditInputRef.value?.focus();
    multiEditInputRef.value?.select();
  });
}

function applyMultiEdit() {
  exitMultiEdit();
}

function exitMultiEdit() {
  isMultiEditMode.value = false;
  textareaRef.value?.focus();
}

watch(multiEditReplacement, (newVal) => {
  if (isMultiEditMode.value) {
    const newContent = multiEditInitialContent.value.split(multiEditInitialText.value).join(newVal);
    content.value = newContent;
  }
});

// --- Utils ---
function copyToClipboard() {
  navigator.clipboard.writeText(content.value);
}

function handleClose() {
  emit('close');
}

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
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

// Shortcuts
function handleKeyDown(e: KeyboardEvent) {
  const isMod = e.ctrlKey || e.metaKey;

  if (isMod && e.key === 'f') {
    e.preventDefault();
    const selection = window.getSelection()?.toString();
    if (selection) {
      findText.value = selection;
      performSearch();
    }
    searchMode.value = 'visible';
    nextTick(() => {
      const findInput = document.querySelector('[data-testid="find-input"]') as HTMLInputElement;
      findInput?.focus();
      if (selection) findInput?.select();
    });
  }
  if (isMod && e.key === 'd') {
    e.preventDefault();
    handleCmdD();
  }
  if (isMod && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) handleRedo();
    else handleUndo();
  }
  if (e.key === 'Escape') {
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

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', calculateLineHeights);
  nextTick(() => {
    textareaRef.value?.focus();
    syncScroll();
    calculateLineHeights();
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('resize', calculateLineHeights);
  if (historyTimeout) clearTimeout(historyTimeout);
  if (lineHeightDebounceTimer) clearTimeout(lineHeightDebounceTimer);
  if (ghostElement && ghostElement.parentNode) {
    ghostElement.parentNode.removeChild(ghostElement);
  }
});

defineExpose({
  __testOnly: {
    isMultiEditMode,
    searchMatches,
    history,
    historyIndex,
    wrapMode,
    calculateLineHeights,
    lineHeights,
  }
});
</script>

<template>
  <!-- Backdrop Container (Minimal blur and darkness) -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/5 backdrop-blur-[0.2px] p-4 md:p-8 transition-opacity"
    @click="handleBackdropClick"
    data-testid="editor-backdrop"
  >    <!-- Editor Container (Lighter Slate-900 background) -->
    <div
      class="w-full h-full max-w-5xl flex bg-white dark:bg-[#0f172a] border border-gray-200 dark:border-white/10 rounded-2xl overflow-hidden shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)] ring-1 ring-black/5 dark:ring-white/5"
      @click.stop
      data-testid="advanced-text-editor"
    >
      <!-- Sidebar -->
      <div class="w-12 border-r border-gray-100 dark:border-white/10 flex flex-col items-center py-4 gap-4 bg-gray-50 dark:bg-slate-950/50 z-30 shrink-0">
        <button
          @click="handleClose"
          class="p-2.5 bg-gray-200 dark:bg-white/10 hover:bg-gray-300 dark:hover:bg-white/20 rounded-xl transition-all shadow-sm text-gray-600 dark:text-gray-300 mb-2 group"
          title="Close Editor (Esc)"
        >
          <X class="w-4.5 h-4.5 group-hover:scale-110 transition-transform" />
        </button>

        <div class="h-px w-6 bg-gray-200 dark:bg-white/10"></div>

        <div class="flex flex-col gap-1">
          <button
            @click="handleUndo"
            :disabled="historyIndex <= 0"
            class="p-2.5 hover:bg-white dark:hover:bg-white/5 rounded-xl disabled:opacity-30 transition-all hover:shadow-sm group"
            :title="`Undo (${modKeyName}+Z)`"
          >
            <Undo2 class="w-4.5 h-4.5 text-gray-500 group-hover:text-blue-500" />
          </button>
          <button
            @click="handleRedo"
            :disabled="historyIndex >= history.length - 1"
            class="p-2.5 hover:bg-white dark:hover:bg-white/5 rounded-xl disabled:opacity-30 transition-all hover:shadow-sm group"
            :title="`Redo (${modKeyName}+Shift+Z)`"
          >
            <Redo2 class="w-4.5 h-4.5 text-gray-500 group-hover:text-blue-500" />
          </button>
        </div>

        <div class="h-px w-6 bg-gray-200 dark:bg-white/10"></div>

        <div class="flex flex-col gap-1">
          <button
            @click="searchMode = searchMode === 'visible' ? 'hidden' : 'visible'"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="searchMode === 'visible' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            :title="`Find & Replace (${modKeyName}+F)`"
          >
            <Search class="w-4.5 h-4.5" />
          </button>
          <button
            @click="showStats = !showStats"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="showStats ? 'bg-purple-500/20 text-purple-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            title="Toggle Stats"
          >
            <BarChart2 class="w-4.5 h-4.5" />
          </button>
          <button
            @click="handleCmdD"
            class="p-2.5 rounded-xl hover:bg-white dark:hover:bg-white/5 transition-all hover:shadow-sm group text-gray-500"
            :title="`Multi-Edit Occurrence (${modKeyName}+D)`"
          >
            <Layers class="w-4.5 h-4.5 group-hover:text-amber-500" />
          </button>
          <button
            @click="toggleWrap"
            class="p-2.5 rounded-xl transition-all hover:shadow-sm group"
            :class="wrapMode === 'wrap-on' ? 'bg-indigo-500/20 text-indigo-400' : 'hover:bg-white dark:hover:bg-white/5 text-gray-500'"
            title="Toggle Word Wrap"
          >
            <WrapText class="w-4.5 h-4.5" />
          </button>
        </div>

        <div class="mt-auto flex flex-col gap-1 mb-2">
          <button
            @click="copyToClipboard"
            class="p-2.5 hover:bg-white dark:hover:bg-white/5 rounded-xl transition-all hover:shadow-sm text-gray-500 hover:text-blue-500"
            title="Copy All"
          >
            <Copy class="w-4.5 h-4.5" />
          </button>
          <button
            @click="content = ''"
            class="p-2.5 hover:bg-red-50 dark:hover:bg-red-500/10 text-gray-400 hover:text-red-500 rounded-xl transition-all"
            title="Clear All"
          >
            <Trash2 class="w-4.5 h-4.5" />
          </button>
        </div>
      </div>

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
                  @input="performSearch"
                  @keydown.enter="nextMatch"
                  placeholder="Search..."
                  class="w-full pl-10 pr-32 py-2 bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all placeholder:text-gray-400 font-mono"
                  data-testid="find-input"
                />
                <Search class="absolute left-3.5 top-2.5 w-4 h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
                <div v-if="findText" class="absolute right-2 top-1.5 flex items-center gap-2 bg-gray-50 dark:bg-white/10 px-2 py-1 rounded-lg border border-gray-200 dark:border-white/10">
                  <span class="text-[10px] text-gray-400 font-mono font-bold">{{ searchMatches.length > 0 ? searchIndex + 1 : 0 }}/{{ searchMatches.length }}</span>
                  <div class="h-3 w-px bg-gray-300 dark:bg-white/20"></div>
                  <div class="flex items-center">
                    <button @click="prevMatch" class="p-0.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors"><ArrowUp class="w-3.5 h-3.5 text-gray-400" /></button>
                    <button @click="nextMatch" class="p-0.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors"><ArrowDown class="w-3.5 h-3.5 text-gray-400" /></button>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 bg-white dark:bg-black/20 p-1 border border-gray-200 dark:border-white/10 rounded-xl">
                <button
                  @click="caseSensitive = caseSensitive === 'case-sensitive' ? 'case-insensitive' : 'case-sensitive'; performSearch()"
                  class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all"
                  :class="caseSensitive === 'case-sensitive' ? 'bg-blue-500/20 text-blue-400 shadow-inner' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-white/10'"
                  title="Match Case"
                >
                  Aa
                </button>
                <button
                  @click="useRegex = useRegex === 'regex-on' ? 'regex-off' : 'regex-on'; performSearch()"
                  class="px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all"
                  :class="useRegex === 'regex-on' ? 'bg-blue-500/20 text-blue-400 shadow-inner' : 'text-gray-400 hover:bg-gray-50 dark:hover:bg-white/10'"
                  title="Use Regex"
                >
                  .*
                </button>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <div class="relative flex-1 group">
                <input
                  v-model="replaceText"
                  @keydown.enter="handleReplace({ mode: 'single' })"
                  placeholder="Replace with..."
                  class="w-full pl-10 pr-4 py-2 bg-white dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all placeholder:text-gray-400 font-mono"
                  data-testid="replace-input"
                />
                <Replace class="absolute left-3.5 top-2.5 w-4 h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
              </div>
              <div class="flex items-center gap-2">
                <button
                  @click="handleReplace({ mode: 'single' })"
                  class="px-4 py-2 text-[11px] font-bold uppercase tracking-wider bg-white dark:bg-white/10 hover:bg-gray-50 dark:hover:bg-white/20 text-gray-600 dark:text-gray-200 rounded-xl transition-all border border-gray-200 dark:border-white/10 shadow-sm"
                >
                  Replace
                </button>
                <button
                  @click="handleReplace({ mode: 'all' })"
                  class="px-4 py-2 text-[11px] font-bold uppercase tracking-wider bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all shadow-lg shadow-blue-500/20"
                >
                  Replace All
                </button>
                <div class="w-px h-6 bg-gray-200 dark:bg-white/10 mx-1"></div>
                <button @click="searchMode = 'hidden'" class="p-2 hover:bg-gray-200 dark:hover:bg-white/10 rounded-xl text-gray-400 transition-colors">
                  <X class="w-4 h-4" />
                </button>
              </div>
            </div>
            <div class="flex items-center justify-between mt-1 px-1">
              <div class="text-[9px] text-gray-400 font-medium flex items-center gap-3">
                <span class="flex items-center gap-1"><Layers class="w-3 h-3" /> {{ modKeyName }}+D for Multi-Edit</span>
                <span class="flex items-center gap-1"><Check class="w-3 h-3" /> Enter to find next</span>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Editor Canvas -->
        <div class="flex-1 flex flex-col min-h-0 bg-transparent relative group/editor">
          <!-- Line Numbers Area (Synced with Slate-900 background) -->
          <div
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
            v-model="content"
            @scroll="handleScroll"
            class="w-full h-full pr-16 py-5 font-mono text-sm bg-transparent outline-none resize-none text-gray-800 dark:text-gray-200 leading-[21px] selection:bg-blue-500/45 selection:text-white overscroll-area z-10"
            :class="wrapMode === 'wrap-off' ? 'pl-16 whitespace-pre overflow-x-auto' : 'pl-16 whitespace-pre-wrap overflow-x-hidden'"
            spellcheck="false"
            :wrap="wrapMode === 'wrap-on' ? 'soft' : 'off'"
            data-testid="advanced-textarea"
          ></textarea>

          <!-- Empty State Watermark -->
          <div v-if="!content" class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.02] dark:opacity-[0.03]">
            <PencilLine class="w-64 h-64" />
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
                  <Layers class="w-3.5 h-3.5" />
                </div>
                <div class="flex flex-col">
                  <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Multi-Edit Mode</span>
                  <span class="text-[11px] text-amber-500/90 font-mono truncate max-w-[200px]" :title="multiEditInitialText">
                    Renaming: "{{ multiEditInitialText }}"
                  </span>
                </div>
              </div>
              <span class="text-[10px] font-bold text-amber-500/80 px-2 py-0.5 bg-amber-500/5 rounded-full border border-amber-500/20">
                {{ multiEditMatches.length }} instances
              </span>
            </div>

            <div class="relative group">
              <input
                ref="multiEditInputRef"
                v-model="multiEditReplacement"
                @keydown.enter="applyMultiEdit"
                @keydown.esc="exitMultiEdit"
                placeholder="Type to replace all..."
                class="w-full px-4 py-2.5 bg-gray-50 dark:bg-black/40 border border-gray-100 dark:border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 outline-none transition-all font-mono placeholder:text-gray-500 text-white"
              />
              <div class="absolute right-3 top-2.5 flex items-center gap-1">
                <button @click="applyMultiEdit" class="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-400 hover:text-green-500 transition-colors" title="Confirm (Enter)">
                  <Check class="w-4 h-4" />
                </button>
                <button @click="exitMultiEdit" class="p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-400 hover:text-red-500 transition-colors" title="Cancel (Esc)">
                  <X class="w-4 h-4" />
                </button>
              </div>
            </div>
            <div class="mt-2 text-[9px] text-gray-400 text-center font-medium">
              Type to rename all. <span class="text-gray-500">Enter</span> to apply, <span class="text-gray-500">Esc</span> to cancel.
            </div>
          </div>
        </Transition>

        <!-- Footer Info Bar (Opaque Slate-900 background) -->
        <div v-if="showStats" class="h-9 border-t border-gray-100 dark:border-white/10 flex items-center justify-between px-6 bg-white dark:bg-[#0f172a] text-[10px] font-bold uppercase tracking-widest text-gray-400 z-30 relative shrink-0">
          <div class="flex items-center gap-6">
            <span class="flex items-center gap-1.5"><Type class="w-3 h-3 text-blue-500/50" /> {{ stats.chars }} <span class="opacity-40 font-medium">Chars</span></span>
            <span class="flex items-center gap-1.5"><PencilLine class="w-3 h-3 text-amber-500/50" /> {{ stats.words }} <span class="opacity-40 font-medium">Words</span></span>
            <span class="flex items-center gap-1.5"><Hash class="w-3 h-3 text-emerald-500/50" /> {{ stats.lines }} <span class="opacity-40 font-medium">Lines</span></span>
          </div>

          <div class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <MousePointer2 class="w-3 h-3 text-purple-500/50" />
              <span class="opacity-40 font-medium">Selection:</span>
              <span>{{ textareaRef?.selectionEnd ? textareaRef.selectionEnd - textareaRef.selectionStart : 0 }}</span>
            </div>
            <div class="h-3 w-px bg-gray-200 dark:border-white/10"></div>
            <span class="text-blue-500/80">{{ historyIndex + 1 }}/{{ history.length }} <span class="opacity-40 font-medium">Steps</span></span>
          </div>
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
