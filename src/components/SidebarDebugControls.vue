<script setup lang="ts">
import { ref } from 'vue';
import { useLayout } from '../composables/useLayout';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { useOPFSExplorer } from '../composables/useOPFSExplorer';
import { useRecentChats } from '../composables/useRecentChats';
import { Terminal, HardDrive, MoreVertical, History } from 'lucide-vue-next';
import MessageActionsMenu from './MessageActionsMenu.vue';

defineProps<{
  isSidebarOpen: boolean;
}>();

const { isDebugOpen, toggleDebug } = useLayout();
const { errorCount } = useGlobalEvents();
const { openOPFS } = useOPFSExplorer();
const { openRecent } = useRecentChats();

const showOpfsMenu = ref(false);
const opfsTriggerRef = ref<HTMLElement | null>(null);

function handleOpenOPFS() {
  openOPFS();
  showOpfsMenu.value = false;
}

function handleOpenRecent() {
  openRecent();
  showOpfsMenu.value = false;
}

defineExpose({
  __testOnly: {
    showOpfsMenu,
    handleOpenOPFS
  }
});
</script>

<template>
  <div v-if="isSidebarOpen" class="flex items-center gap-1 animate-in fade-in duration-300">
    <button
      @click="toggleDebug"
      class="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm relative group"
      :class="{ 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-inner': isDebugOpen }"
      title="Debug Events"
      data-testid="sidebar-debug-button"
    >
      <Terminal class="w-4 h-4" />
      <div
        v-if="errorCount > 0"
        class="absolute -top-1 -right-1 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold shadow-sm animate-pulse"
        data-testid="sidebar-error-badge"
      >
        {{ errorCount }}
      </div>
    </button>

    <div class="relative flex items-center">
      <button
        ref="opfsTriggerRef"
        @click="showOpfsMenu = !showOpfsMenu"
        class="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm"
        :class="{ 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-inner': showOpfsMenu }"
        title="More Actions"
        data-testid="sidebar-opfs-menu-button"
      >
        <MoreVertical class="w-4 h-4" />
      </button>

      <MessageActionsMenu
        v-if="showOpfsMenu"
        :is-open="showOpfsMenu"
        :trigger-el="opfsTriggerRef"
        :width="180"
        @close="showOpfsMenu = false"
      >
        <div class="px-1 py-1">
          <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Quick Access
          </div>
          <button
            @click="handleOpenRecent"
            class="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium group"
            data-testid="sidebar-recent-button"
          >
            <div class="flex items-center gap-3">
              <History class="w-4 h-4" />
              <span>Recent Chats</span>
            </div>
            <kbd class="hidden group-hover:inline-block px-1 py-0.5 text-[9px] font-sans font-medium text-gray-400 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">Ctrl+E</kbd>
          </button>
          <button
            @click="handleOpenOPFS"
            class="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium"
            data-testid="sidebar-opfs-button"
          >
            <HardDrive class="w-4 h-4" />
            <span>OPFS Explorer</span>
          </button>
        </div>
      </MessageActionsMenu>
    </div>
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
