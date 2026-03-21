<script setup lang="ts">
import { computedAsync } from '@vueuse/core';
import { Calculator, Terminal } from 'lucide-vue-next';
import { useChatTools } from '@/composables/useChatTools';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';

const { isToolEnabled, setToolEnabled, toggleTool } = useChatTools();
const isShellToolSupported = computedAsync(
  async () => checkOPFSSupport(),
  true
);

const handleShellToolToggle = () => {
  if (!isShellToolSupported.value) {
    setToolEnabled({ name: 'shell_execute', enabled: false });
    return;
  }
  toggleTool({ name: 'shell_execute' });
};


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="px-3 py-1 border-b dark:border-gray-700 pb-2 mb-2">
    <div class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">
      Experimental Tools
    </div>
    <button
      @click="toggleTool({ name: 'calculator' })"
      class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 text-left group"
      :class="isToolEnabled({ name: 'calculator' }) ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'text-gray-600 dark:text-gray-300'"
      data-testid="tool-calculator-toggle"
    >
      <div class="flex items-center gap-2">
        <Calculator class="w-4 h-4" :class="isToolEnabled({ name: 'calculator' }) ? 'text-blue-500' : 'text-gray-400'" />
        <span class="text-xs font-medium">Calculator</span>
      </div>
      <div
        class="w-8 h-4 rounded-full relative transition-colors duration-200"
        :class="isToolEnabled({ name: 'calculator' }) ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'"
      >
        <div
          class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200"
          :class="isToolEnabled({ name: 'calculator' }) ? 'translate-x-4' : 'translate-x-0'"
        />
      </div>
    </button>
    <button
      @click="handleShellToolToggle"
      :disabled="!isShellToolSupported"
      class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 text-left group"
      :class="[
        isToolEnabled({ name: 'shell_execute' }) ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'text-gray-600 dark:text-gray-300',
        !isShellToolSupported ? 'opacity-50 cursor-not-allowed' : '',
      ]"
      data-testid="tool-shell-toggle"
    >
      <div class="flex items-center gap-2">
        <Terminal class="w-4 h-4" :class="isToolEnabled({ name: 'shell_execute' }) ? 'text-blue-500' : 'text-gray-400'" />
        <span class="text-xs font-medium">
          Shell in browser{{ isShellToolSupported ? '' : ' (OPFS required)' }}
        </span>
      </div>
      <div
        class="w-8 h-4 rounded-full relative transition-colors duration-200"
        :class="isToolEnabled({ name: 'shell_execute' }) ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'"
      >
        <div
          class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200"
          :class="isToolEnabled({ name: 'shell_execute' }) ? 'translate-x-4' : 'translate-x-0'"
        />
      </div>
    </button>
  </div>
</template>
