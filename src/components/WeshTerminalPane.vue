<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { PlusIcon, XIcon } from 'lucide-vue-next';
import type { WeshTerminalSession, WeshTerminalLineKind, WeshTerminalSessionState } from '@/composables/useWeshTerminalSessions';

const props = defineProps<{
  sessions: WeshTerminalSession[];
  activeSessionId: string | undefined;
}>();

const emit = defineEmits<{
  'update:activeSessionId': [string | undefined];
  run: [{ script: string }];
  'create-session': [];
  'close-session': [{ sessionId: string }];
  cancel: [{ sessionId: string }];
}>();

const outputRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);

// Per-session input drafts; cleared after submit.
const drafts = new Map<string, string>();
const inputDraft = ref('');

const activeSession = computed(() =>
  props.sessions.find(s => s.id === props.activeSessionId)
);

const isRunning = computed(() => activeSession.value?.state === 'running');
const isDisabled = computed(() => {
  const s = activeSession.value?.state;
  return !s || s === 'initializing' || s === 'error';
});

// Save/restore draft on session switch.
watch(() => props.activeSessionId, (newId, oldId) => {
  if (oldId) drafts.set(oldId, inputDraft.value);
  inputDraft.value = newId ? (drafts.get(newId) ?? '') : '';
  nextTick(() => {
    focusInput();
    scrollToBottom();
  });
});

// Auto-scroll on new output or when typing.
watch(
  () => activeSession.value?.lines.length,
  () => {
    nextTick(scrollToBottom);
  }
);
watch(inputDraft, () => {
  nextTick(scrollToBottom);
});

// Focus input once session becomes ready.
watch(
  () => activeSession.value?.state,
  (state) => {
    if (state === undefined) return;
    switch (state) {
    case 'ready': nextTick(focusInput); break;
    case 'initializing':
    case 'running':
    case 'error':
      break;
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  }
);

function scrollToBottom() {
  if (outputRef.value) {
    outputRef.value.scrollTop = outputRef.value.scrollHeight;
  }
}

function focusInput() {
  inputRef.value?.focus();
}

function resetTextareaHeight() {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto';
  }
}

function autoResize(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'c') {
    e.preventDefault();
    if (isRunning.value && props.activeSessionId) {
      emit('cancel', { sessionId: props.activeSessionId });
    } else {
      inputDraft.value = '';
      resetTextareaHeight();
    }
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isRunning.value && !isDisabled.value && inputDraft.value.trim()) {
      const script = inputDraft.value;
      inputDraft.value = '';
      resetTextareaHeight();
      emit('run', { script });
    }
  }
}

function lineClass(kind: WeshTerminalLineKind): string {
  switch (kind) {
  case 'command': return 'text-gray-100';
  case 'stdout': return 'text-gray-300';
  case 'stderr': return 'text-yellow-400';
  case 'error': return 'text-red-400';
  case 'system': return 'text-gray-600 italic';
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
}

function stateDotClass(state: WeshTerminalSessionState): string {
  switch (state) {
  case 'initializing': return 'bg-yellow-500 animate-pulse';
  case 'ready': return 'bg-blue-500';
  case 'running': return 'bg-blue-400 animate-pulse';
  case 'error': return 'bg-red-500';
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
}

defineExpose({ focusInput,
  __testOnly: {
  // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }, });
</script>

<template>
  <!-- Tab bar -->
  <div
    class="flex items-center gap-1 px-2 py-1.5 bg-gray-900 border-b border-gray-700/60 shrink-0 overflow-x-auto no-scrollbar"
  >
    <div
      v-for="session in sessions"
      :key="session.id"
      class="group inline-flex items-center rounded-md text-xs font-mono font-medium whitespace-nowrap transition-colors"
      :class="activeSessionId === session.id
        ? 'bg-gray-700 text-gray-100'
        : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'"
    >
      <button
        class="inline-flex items-center gap-1.5 px-2.5 py-1"
        @click="emit('update:activeSessionId', session.id)"
      >
        <span
          class="w-1.5 h-1.5 rounded-full shrink-0"
          :class="stateDotClass(session.state)"
        />
        {{ session.title }}
      </button>
      <button
        class="pr-1.5 pl-0.5 py-1 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity"
        aria-label="Close session"
        @click.stop="emit('close-session', { sessionId: session.id })"
      >
        <XIcon class="w-2.5 h-2.5" />
      </button>
    </div>

    <button
      class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-mono text-gray-600 hover:text-gray-300 hover:bg-gray-800 whitespace-nowrap transition-colors shrink-0"
      data-testid="new-session-button"
      @click="emit('create-session')"
    >
      <PlusIcon class="w-3 h-3" />
      New
    </button>
  </div>

  <!-- Output + inline input area -->
  <div
    ref="outputRef"
    class="flex-1 min-h-0 overflow-y-auto bg-black px-4 py-3 font-mono text-sm leading-relaxed cursor-text"
    @click="focusInput()"
  >
    <template v-if="activeSession">
      <div
        v-for="line in activeSession.lines"
        :key="line.id"
        class="whitespace-pre-wrap break-all"
        :class="lineClass(line.kind)"
      >
        <span v-if="line.kind === 'command'" class="select-none text-blue-400 mr-2">$</span>{{ line.text }}
      </div>
      <div v-if="activeSession.state === 'initializing'" class="text-gray-700 italic animate-pulse mt-1">
        Initializing worker…
      </div>

      <!-- Inline input prompt (ready: visible; running: textarea kept in DOM for Ctrl+C but invisible) -->
      <div v-if="!isDisabled" class="flex items-start mt-px">
        <span v-show="!isRunning" class="text-blue-400 select-none mr-2 shrink-0 leading-relaxed">$</span>
        <textarea
          ref="inputRef"
          v-model="inputDraft"
          :readonly="isRunning"
          rows="1"
          class="flex-1 bg-transparent outline-none resize-none leading-relaxed caret-gray-100"
          :class="isRunning ? 'opacity-0' : 'text-gray-100 placeholder:text-gray-700'"
          data-testid="terminal-input"
          @keydown="handleKeyDown"
          @input="autoResize"
        />
      </div>
    </template>
    <div v-else class="text-gray-700 text-xs italic mt-2">
      No sessions. Press "New" to start a worker-backed shell.
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
