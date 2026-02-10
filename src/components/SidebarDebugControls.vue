<script setup lang="ts">
import { useLayout } from '../composables/useLayout';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { useOPFSExplorer } from '../composables/useOPFSExplorer';
import { Terminal, HardDrive } from 'lucide-vue-next';

defineProps<{
  isSidebarOpen: boolean;
}>();

const { isDebugOpen, toggleDebug } = useLayout();
const { errorCount } = useGlobalEvents();
const { openOPFS } = useOPFSExplorer();
</script>

<template>
  <div v-if="isSidebarOpen" class="flex items-center gap-1 animate-in fade-in duration-300">
    <button 
      @click="toggleDebug"
      class="p-3 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm relative group"
      :class="{ 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-inner': isDebugOpen }"
      title="Debug Events"
      data-testid="sidebar-debug-button"
    >
      <Terminal class="w-4 h-4" />
      <div 
        v-if="errorCount > 0"
        class="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold shadow-sm animate-pulse"
        data-testid="sidebar-error-badge"
      >
        {{ errorCount }}
      </div>
    </button>
    <button 
      @click="openOPFS"
      class="p-3 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm"
      title="OPFS Explorer"
      data-testid="sidebar-opfs-button"
    >
      <HardDrive class="w-4 h-4" />
    </button>
  </div>
  <button 
    v-else
    @click="toggleDebug"
    class="flex items-center justify-center w-8 h-8 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 transition-all relative"
    :class="{ 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800': isDebugOpen }"
    title="Debug Events"
  >
    <Terminal class="w-4 h-4" />
    <div 
      v-if="errorCount > 0"
      class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm animate-pulse border-2 border-white dark:border-gray-900"
    ></div>
  </button>
</template>
