<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { X, Terminal } from 'lucide-vue-next';
import { Wesh } from '@/services/wesh';
import { createWeshWriteCaptureHandle, createWeshReadFileHandleFromText } from '@/services/wesh/utils/test-stream';
import DOMPurify from 'dompurify';

defineProps<{ isOpen: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void
}>();

const terminalInput = ref('');
const terminalOutput = ref('');
const outputContainerRef = ref<HTMLElement | null>(null);
const weshInstance = ref<Wesh | null>(null);

async function initWesh() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    terminalOutput.value = 'Error: OPFS not supported in this environment.';
    return;
  }
  const root = await navigator.storage.getDirectory();
  const id = Math.random().toString(36).substring(7);
  const weshDir = await root.getDirectoryHandle('naidan-debug-wesh', { create: true });
  const weshSubDir = await weshDir.getDirectoryHandle(id, { create: true });

  const wesh = new Wesh({ rootHandle: weshSubDir as FileSystemDirectoryHandle });
  await wesh.init();
  weshInstance.value = wesh;
  terminalOutput.value = `Wesh terminal initialized at /naidan-debug-wesh/${id}\n`;
}

async function runCommand() {
  if (!weshInstance.value || !terminalInput.value.trim()) return;

  const script = terminalInput.value;
  const commandHtml = `<span class="text-blue-500 font-bold">$</span> ${DOMPurify.sanitize(script)}\n`;
  terminalOutput.value += commandHtml;
  terminalInput.value = '';

  const stdout = createWeshWriteCaptureHandle();
  const stderr = createWeshWriteCaptureHandle();
  const stdin = createWeshReadFileHandleFromText({ text: '' });

  try {
    const result = await weshInstance.value.execute({
      script,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle
    });

    if (stdout.text) {
      terminalOutput.value += `<span class="text-gray-300">${DOMPurify.sanitize(stdout.text)}</span>`;
    }
    if (stderr.text) {
      terminalOutput.value += `<span class="text-red-400 italic">${DOMPurify.sanitize(stderr.text)}</span>`;
    }

    if (result.exitCode !== 0) {
      terminalOutput.value += `<span class="text-amber-500 text-[10px] uppercase font-bold">Process exited with code ${result.exitCode}</span>\n`;
    }
    terminalOutput.value += '\n';
  } catch (e) {
    terminalOutput.value += `<span class="text-red-500 font-bold">Execution Error:</span> ${DOMPurify.sanitize(String(e))}\n\n`;
  }

  // Scroll to bottom
  if (outputContainerRef.value) {
    setTimeout(() => {
      outputContainerRef.value!.scrollTop = outputContainerRef.value!.scrollHeight;
    }, 0);
  }
}onMounted(initWesh);


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" class="fixed inset-0 z-[100] flex items-center justify-center p-2 md:p-6 bg-black/50 backdrop-blur-sm">
      <div class="w-full max-w-[95vw] h-[95vh] md:h-[90vh] bg-white dark:bg-gray-900 rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-gray-100 dark:border-gray-800 relative modal-content-zoom">
        <div class="px-6 py-4 flex items-center justify-between border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
          <div class="flex items-center gap-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
            <Terminal class="w-5 h-5 text-blue-600" />
            Debug Wesh Terminal
          </div>
          <button @click="emit('close')" class="p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-xl transition-colors">
            <X class="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div
          ref="outputContainerRef"
          class="flex-1 p-6 bg-gray-50 dark:bg-black overflow-y-auto font-mono text-sm text-gray-800 dark:text-gray-300 whitespace-pre-wrap"
          v-html="terminalOutput"
        ></div>

        <div class="p-6 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
          <textarea
            v-model="terminalInput"
            @keydown.enter.ctrl.prevent="runCommand"
            @keydown.enter.meta.prevent="runCommand"
            placeholder="Enter command (Ctrl+Enter or Cmd+Enter to run)..."
            class="w-full h-32 p-4 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono resize-none"
          ></textarea>
          <div class="flex justify-end mt-4">
            <button @click="runCommand" class="px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors shadow-sm">
              Run Command
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.9);
  opacity: 0;
}
</style>
