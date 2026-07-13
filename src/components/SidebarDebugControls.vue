<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref } from 'vue';
import { useLayout } from '@/composables/useLayout';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { useRecentChats } from '@/composables/useRecentChats';
import { useDebugEncryptedOpfsWorkbench } from '@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsWorkbench';
import { useDebugOpfsEncryptionInspector } from '@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector';
import { storageService } from '@/00-storage/service';
import { TerminalIcon, MoreVerticalIcon, HistoryIcon, BoxIcon, FolderSearchIcon, DatabaseIcon } from 'lucide-vue-next';
import MessageActionsMenu from './MessageActionsMenu.vue';

defineProps<{
  isSidebarOpen: boolean,
}>();

const { isDebugOpen, toggleDebug, toggleWeshTerminal } = useLayout();
const { errorCount } = useGlobalEvents();
const { openFileExplorer } = useFileExplorerModal();
const { openRecent } = useRecentChats();
const { openDebugEncryptedOpfsWorkbench } = useDebugEncryptedOpfsWorkbench();
const { openDebugOpfsEncryptionInspector } = useDebugOpfsEncryptionInspector();

const showOpfsMenu = ref(false);
const opfsTriggerRef = ref<HTMLElement | null>(null);
const encryptedInspectorAvailable = ref(false);
const checkingEncryptedInspector = ref(false);
let encryptionInspectionRequestId = 0;

function handleOpenRecent() {
  openRecent();
  showOpfsMenu.value = false;
}

async function toggleOpfsMenu(): Promise<void> {
  if (showOpfsMenu.value) {
    showOpfsMenu.value = false;
    encryptionInspectionRequestId += 1;
    return;
  }
  showOpfsMenu.value = true;
  encryptedInspectorAvailable.value = false;
  checkingEncryptedInspector.value = true;
  const requestId = ++encryptionInspectionRequestId;
  try {
    const inspection = await storageService.inspectOpfsEncryption();
    if (showOpfsMenu.value && requestId === encryptionInspectionRequestId) {
      encryptedInspectorAvailable.value = inspection.type === 'encrypted';
    }
  } catch {
    if (requestId === encryptionInspectionRequestId) {
      encryptedInspectorAvailable.value = false;
    }
  } finally {
    if (requestId === encryptionInspectionRequestId) {
      checkingEncryptedInspector.value = false;
    }
  }
}

function handleOpenOpfsEncryptionInspector(): void {
  if (!encryptedInspectorAvailable.value) {
    return;
  }
  openDebugOpfsEncryptionInspector();
  showOpfsMenu.value = false;
}

function handleOpenEncryptedOpfsWorkbench(): void {
  openDebugEncryptedOpfsWorkbench();
  showOpfsMenu.value = false;
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      showOpfsMenu,
    },
  }) || {}),
});
</script>

<template>
  <div v-if="isSidebarOpen" class="animate-in fade-in" tw-class="flex items-center gap-1 duration-300">
    <button
      @click="toggleDebug"
      :tw-class="['p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm relative group', { 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-inner': isDebugOpen }]"
      :title="lazyStrings.SidebarDebugControls__debug_events()"
      data-testid="sidebar-debug-button"
    >
      <TerminalIcon tw-class="w-4 h-4" />
      <div
        v-if="errorCount > 0"
        tw-class="absolute -top-1 -right-1 flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold shadow-sm animate-pulse"
        data-testid="sidebar-error-badge"
      >
        {{ errorCount }}
      </div>
    </button>

    <div tw-class="relative flex items-center">
      <button
        ref="opfsTriggerRef"
        @click="toggleOpfsMenu"
        :tw-class="['p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm', { 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-inner': showOpfsMenu }]"
        :title="lazyStrings.SidebarDebugControls__more_actions()"
        data-testid="sidebar-opfs-menu-button"
      >
        <MoreVerticalIcon tw-class="w-4 h-4" />
      </button>

      <MessageActionsMenu
        v-if="showOpfsMenu"
        :is-open="showOpfsMenu"
        :trigger-el="opfsTriggerRef"
        :width="180"
        @close="showOpfsMenu = false"
      >
        <div tw-class="px-1 py-1">
          <div tw-class="px-3 py-1.5 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            {{ lazyStrings.SidebarDebugControls__quick_access() }}
          </div>
          <button
            @click="handleOpenRecent"
            tw-class="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium group"
            data-testid="sidebar-recent-button"
          >
            <div tw-class="flex items-center gap-3">
              <HistoryIcon tw-class="w-4 h-4" />
              <span>{{ lazyStrings.SidebarDebugControls__recent_chats() }}</span>
            </div>
            <kbd tw-class="hidden group-hover:inline-block px-1 py-0.5 text-[9px] font-sans font-medium text-gray-400 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">Ctrl+P</kbd>
          </button>
          <button
            @click="openFileExplorer({ options: { kind: 'opfs-root' } }); showOpfsMenu = false"
            tw-class="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium"
            data-testid="sidebar-file-explorer-button"
          >
            <FolderSearchIcon tw-class="w-4 h-4" />
            <span>{{ lazyStrings.SidebarDebugControls__file_explorer() }}</span>
          </button>
          <button
            :disabled="!encryptedInspectorAvailable"
            :title="checkingEncryptedInspector ? 'Checking encrypted storage state' : encryptedInspectorAvailable ? 'Inspect Naidan OPFS encryption control state' : 'Available after encrypted OPFS is unlocked'"
            @click="handleOpenOpfsEncryptionInspector"
            tw-class="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            data-testid="sidebar-opfs-encryption-inspector-button"
          >
            <DatabaseIcon tw-class="w-4 h-4" />
            <span>OPFS Encryption Inspector</span>
          </button>
          <button
            title="Open the low-level EncryptedOpfs development workbench"
            @click="handleOpenEncryptedOpfsWorkbench"
            tw-class="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium"
            data-testid="sidebar-encrypted-opfs-workbench-button"
          >
            <FolderSearchIcon tw-class="w-4 h-4" />
            <span>EncryptedOpfs Workbench</span>
          </button>
          <button
            @click="toggleWeshTerminal(); showOpfsMenu = false"
            tw-class="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors font-medium"
          >
            <BoxIcon tw-class="w-4 h-4" />
            <span>{{ lazyStrings.SidebarDebugControls__wesh_terminal() }}</span>
          </button>
        </div>
      </MessageActionsMenu>
    </div>
  </div>
  <button
    v-else
    @click="toggleDebug"
    :tw-class="['flex items-center justify-center w-8 h-8 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 transition-all relative', { 'text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800': isDebugOpen }]"
    :title="lazyStrings.SidebarDebugControls__debug_events()"
  >
    <TerminalIcon tw-class="w-4 h-4" />
    <div
      v-if="errorCount > 0"
      tw-class="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm animate-pulse border-2 border-white dark:border-gray-900"
    ></div>
  </button>
</template>
