<script setup lang="ts">
import { computed, onBeforeUnmount, watch, ref, nextTick } from 'vue';
import { Plus, X, Terminal } from 'lucide-vue-next';
import { useDebugWeshTerminalSessions } from '@/composables/useDebugWeshTerminalSessions';
import { useConfirm } from '@/composables/useConfirm';

const props = defineProps<{ isOpen: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void
}>();

const {
  sessions,
  activeSession,
  activeSessionId,
  ensureActiveSession,
  createWorkerSession,
  closeSession,
  runCommand,
  reopenSessionIfNeeded,
} = useDebugWeshTerminalSessions();
const { showConfirm } = useConfirm();

const inputRef = ref<HTMLTextAreaElement | null>(null);
const currentSession = computed(() => activeSession.value);

watch(() => props.isOpen, async (open) => {
  if (!open) return;
  await reopenSessionIfNeeded();
  await nextTick();
  inputRef.value?.focus();
}, { immediate: true });

const hasSessions = computed(() => sessions.value.length > 0);

async function handleRun() {
  const session = activeSession.value;
  if (!session) return;
  await runCommand({ script: session.input });
  session.input = '';
  await nextTick();
  inputRef.value?.focus();
}

async function handleCreateSession() {
  await createWorkerSession();
  await nextTick();
  inputRef.value?.focus();
}

async function handleCloseSession(sessionId: string) {
  const confirmed = await showConfirm({
    title: 'Close Session?',
    message: 'This will dispose the worker and lose the session history. Continue?',
    confirmButtonText: 'Close Session',
    cancelButtonText: 'Cancel',
    confirmButtonVariant: 'danger',
  });

  if (!confirmed) {
    return;
  }

  await closeSession({ sessionId });
}

onBeforeUnmount(() => {
  // Sessions intentionally survive modal close; workers are disposed only when the tab is closed.
});

defineExpose({
  __testOnly: {
    ensureActiveSession,
  }
});
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center p-2 md:p-6 bg-black/35">
      <div class="w-full max-w-[1100px] h-[92vh] bg-white dark:bg-gray-900 rounded-3xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-800 flex flex-col">
        <header class="flex items-center justify-between gap-4 px-4 md:px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
          <div class="flex items-center gap-3 min-w-0">
            <div class="p-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300">
              <Terminal class="w-4 h-4" />
            </div>
            <div class="min-w-0">
              <h2 class="text-sm md:text-base font-bold text-gray-900 dark:text-white tracking-tight">Debug Wesh Terminal</h2>
              <p class="text-[11px] md:text-xs text-gray-500 dark:text-gray-400">Worker-backed terminal sessions survive while the app is open.</p>
            </div>
          </div>
          <button
            @click="emit('close')"
            class="p-2 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
            aria-label="Close terminal"
          >
            <X class="w-5 h-5 text-gray-500" />
          </button>
        </header>

        <div class="px-4 md:px-5 pt-3 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
          <div class="flex items-center gap-2 overflow-x-auto no-scrollbar">
            <div
              v-for="session in sessions"
              :key="session.id"
              class="inline-flex items-center rounded-t-xl border border-b-0 overflow-hidden text-xs font-semibold whitespace-nowrap"
              :class="activeSessionId === session.id ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white border-gray-200 dark:border-gray-800' : 'bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'"
            >
              <button
                @click="activeSessionId = session.id"
                class="px-3 py-2"
              >
                {{ session.title }}
              </button>
              <button
                @click.stop="handleCloseSession(session.id)"
                class="px-2 py-2 hover:bg-gray-200 dark:hover:bg-gray-700 border-l border-gray-200/70 dark:border-gray-700/70"
                aria-label="Close session"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              @click="handleCreateSession"
              class="inline-flex items-center gap-2 px-3 py-2 rounded-t-xl border border-b-0 border-dashed text-xs font-semibold whitespace-nowrap bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <Plus class="w-3.5 h-3.5" />
              New Session
            </button>
          </div>
        </div>

        <div class="flex-1 min-h-0 flex flex-col bg-white dark:bg-gray-900">
          <div class="flex-1 min-h-0 overflow-y-auto font-mono text-sm px-4 md:px-5 py-4 bg-gray-50 dark:bg-black/40 border-b border-gray-200 dark:border-gray-800">
            <div v-if="!hasSessions" class="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
              No sessions yet. Create one to start a worker-backed shell.
            </div>
            <template v-else>
              <div v-for="line in currentSession?.lines || []" :key="`${line.kind}-${line.text}`" class="whitespace-pre-wrap break-words leading-6">
                <span v-if="line.kind === 'command'" class="text-blue-600 dark:text-blue-300">$ {{ line.text }}</span>
                <span v-else-if="line.kind === 'stdout'" class="text-gray-800 dark:text-gray-200">{{ line.text }}</span>
                <span v-else-if="line.kind === 'stderr'" class="text-amber-600 dark:text-amber-400">{{ line.text }}</span>
                <span v-else-if="line.kind === 'error'" class="text-red-600 dark:text-red-400">{{ line.text }}</span>
                <span v-else class="text-gray-500 dark:text-gray-400">{{ line.text }}</span>
              </div>
              <div v-if="currentSession?.state !== 'running'" class="flex items-start gap-2 mt-3">
                <span class="text-blue-600 dark:text-blue-300 font-bold">$</span>
                <textarea
                  ref="inputRef"
                  v-model="currentSession!.input"
                  @keydown.enter.exact.prevent="handleRun"
                  @keydown.enter.shift.exact.prevent="currentSession!.input += '\n'"
                  class="flex-1 min-h-16 resize-none bg-transparent border-none outline-none text-gray-900 dark:text-gray-100 font-mono leading-6"
                  placeholder="Type a command and press Enter"
                />
              </div>
              <div v-else class="flex items-center gap-2 mt-3 text-gray-500 dark:text-gray-400">
                <span class="text-blue-600 dark:text-blue-300 font-bold">$</span>
                <span class="text-xs">Running...</span>
              </div>
            </template>
          </div>

          <footer class="px-4 md:px-5 py-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex items-center justify-between gap-4">
            <p class="text-[11px] text-gray-500 dark:text-gray-400">
              Sessions are kept alive until you close the tab.
            </p>
            <button
              @click="handleRun"
              class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              :disabled="!currentSession || currentSession.state !== 'ready' || !currentSession.input.trim()"
            >
              Run
            </button>
          </footer>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.modal-enter-active,
.modal-leave-active {
  transition: all 0.25s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.25s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.98);
  opacity: 0;
}
</style>
