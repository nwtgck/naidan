<script setup lang="ts">
import { ref, watch, computed, defineAsyncComponent } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useChat } from './composables/useChat';
import { useSettings } from './composables/useSettings';
import { useConfirm } from './composables/useConfirm'; // Import useConfirm
import { usePrompt } from './composables/usePrompt';   // Import usePrompt
import { useOPFSExplorer } from './composables/useOPFSExplorer';
import { useFileExplorerModal } from './composables/useFileExplorerModal';
import { useTheme } from './composables/useTheme';
import { usePrint } from './composables/usePrint';
import Sidebar from './components/Sidebar.vue';

// Async components for print mode to keep initial bundle small.
const PrintView = defineAsyncComponent(() => import('./components/PrintView.vue'));
const ChatPrintContent = defineAsyncComponent(() => import('./components/ChatPrintContent.vue'));

// IMPORTANT: OnboardingModal is imported synchronously to ensure a smooth first-time user experience.
import OnboardingModal from './components/OnboardingModal.vue';
import ToastContainer from './components/ToastContainer.vue';
import { useLayout } from './composables/useLayout';
import { defineAsyncComponentAndLoadOnMounted } from './utils/vue';
import { useGlobalSearch } from './composables/useGlobalSearch';
import { useRecentChats } from './composables/useRecentChats';
import type { EndpointType } from './models/types';

// PWA manager (only for hosted mode)
const PWAManager = __BUILD_MODE_IS_HOSTED__
  ? defineAsyncComponentAndLoadOnMounted(() => import('./components/PWAManager.vue'))
  : undefined;
// Lazily load components that are not visible on initial mount, but prefetch them when idle.
const SettingsModal = defineAsyncComponentAndLoadOnMounted(() => import('./components/SettingsModal.vue'));
const DebugWeshTerminalModal = defineAsyncComponentAndLoadOnMounted(() => import('./components/DebugWeshTerminalModal.vue'));
const GlobalSearchModal = defineAsyncComponentAndLoadOnMounted(() => import('./components/GlobalSearchModal.vue'));
const RecentChatsModal = defineAsyncComponentAndLoadOnMounted(() => import('./components/RecentChatsModal.vue'));
const DebugPanel = defineAsyncComponentAndLoadOnMounted(() => import('./components/DebugPanel.vue'));
const CustomDialog = defineAsyncComponentAndLoadOnMounted(() => import('./components/CustomDialog.vue'));
const OPFSExplorer = defineAsyncComponentAndLoadOnMounted(() => import('./components/OPFSExplorer.vue'));
const FileExplorerModal = defineAsyncComponentAndLoadOnMounted(() => import('./components/FileExplorerModal.vue'));

const chatStore = useChat();
const settingsStore = useSettings();
const { addRecentChat, toggleRecent } = useRecentChats();
const { isSidebarOpen, isDebugOpen, isWeshTerminalOpen, toggleWeshTerminal } = useLayout();
const { activePrintMode } = usePrint();
const router = useRouter();
const route = useRoute();

const isSettingsOpen = computed(() => route.path.startsWith('/settings') || !!route.query.settings);
const lastNonSettingsPath = ref('/');

watch(() => route.path, (path) => {
  if (!path.startsWith('/settings')) {
    lastNonSettingsPath.value = path;
  }
});

// Watch for chat navigation and update recent chats
watch(() => route.path, () => {
  if (route.name === '/chat/[id]' && route.params.id && typeof route.params.id === 'string') {
    addRecentChat({ id: route.params.id });
  }
}, { immediate: true });

const closeSettings = () => {
  if (route.query.settings) {
    const query = { ...route.query };
    delete query.settings;
    router.push({ path: route.path, query });
  } else {
    router.push(lastNonSettingsPath.value);
  }
};

const { isOPFSOpen } = useOPFSExplorer();
const { isFileExplorerOpen } = useFileExplorerModal();

// Initialize theme application logic
useTheme();

// Initialize useConfirm
const {
  isConfirmOpen, confirmTitle, confirmMessage,
  confirmConfirmButtonText, confirmCancelButtonText,
  confirmButtonVariant, confirmIcon,
  handleConfirm, handleCancel,
} = useConfirm();

// Initialize usePrompt
const {
  isPromptOpen, promptTitle, promptMessage,
  promptConfirmButtonText, promptCancelButtonText, promptInputValue,
  promptBodyComponent,
  handlePromptConfirm, handlePromptCancel,
} = usePrompt();

// Synchronize Global Endpoint Settings from URL Query Parameters
watch(
  [
    () => route.query['global-endpoint-type'],
    () => route.query['global-endpoint-url'],
    () => settingsStore.initialized.value
  ],
  async ([type, url, initialized]) => {
    if (!initialized) return;
    if (typeof type === 'string' && typeof url === 'string') {
      const isEndpointType = (val: string): val is EndpointType =>
        ['openai', 'ollama'].includes(val);

      if (isEndpointType(type)) {
        await settingsStore.updateGlobalEndpoint({          type,
          url
        });
      }
    }
  },
  { immediate: true }
);

// Synchronize Global Model from URL Query Parameters
watch(
  [
    () => route.query['global-model'],
    () => settingsStore.initialized.value
  ],
  async ([modelId, initialized]) => {
    if (!initialized) return;
    if (typeof modelId === 'string') {
      await settingsStore.updateGlobalModel(modelId);
    }
  },
  { immediate: true }
);

// Automatically create a new chat if the list becomes empty while on the landing page
// OR if a query parameter 'q' is provided on the landing page
watch(
  [
    () => chatStore.chats.value.length,
    () => router.currentRoute.value?.path,
    () => router.currentRoute.value?.query?.q,
    () => router.currentRoute.value?.query?.['chat-group'],
    () => router.currentRoute.value?.query?.model,
    () => router.currentRoute.value?.query?.['system-prompt'] || router.currentRoute.value?.query?.sp,
    () => settingsStore.initialized.value,
    () => settingsStore.isOnboardingDismissed.value
  ],
  async ([len, path, q, chatGroupId, modelId, systemPromptStr, initialized, dismissed]) => {
    if (!initialized || !dismissed || path !== '/') return;

    // 1. Handle empty state fallback (e.g. first time users or after clearing all chats)
    // This ignores URL parameters and just ensures the user has something to interact with.
    if (len === 0 && !q) {
      const { setActiveFocusArea } = useLayout();
      setActiveFocusArea('chat');
      await chatStore.createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
      if (chatStore.currentChat.value) {
        router.push(`/chat/${chatStore.currentChat.value.id}`);
      }
      return;
    }

    // 2. Handle URL Query Parameters
    // We only trigger this if 'q' is provided. 'system-prompt' or 'model' alone
    // does not trigger a new chat.
    if (q) {
      let targetGroupId: string | undefined = undefined;
      if (typeof chatGroupId === 'string') {
        const group = chatStore.chatGroups.value.find(g => g.id === chatGroupId || g.name === chatGroupId);
        if (group) {
          targetGroupId = group.id;
        } else {
          targetGroupId = await chatStore.createChatGroup(chatGroupId);
        }
      }

      const targetModelId = (typeof modelId === 'string') ? modelId : undefined;
      const systemPrompt = (typeof systemPromptStr === 'string' && systemPromptStr)
        ? { behavior: 'override' as const, content: systemPromptStr }
        : undefined;

      const { setActiveFocusArea } = useLayout();
      setActiveFocusArea('chat');
      await chatStore.createNewChat({
        groupId: targetGroupId,
        modelId: targetModelId,
        systemPrompt
      });

      if (chatStore.currentChat.value) {
        const id = chatStore.currentChat.value.id;
        router.push({
          path: `/chat/${id}`,
          query: { q: q.toString() }
        });
      }
    }
  },
  { immediate: true }
);

// ChatGPT-style shortcut for New Chat: Ctrl+Shift+O (Cmd+Shift+O on Mac)
onKeyStroke(['o', 'O', 'k', 'K', 'p', 'P'], async (e) => {
  // New Chat
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    const { setActiveFocusArea } = useLayout();
    setActiveFocusArea('chat');
    await chatStore.createNewChat({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined
    });
    if (chatStore.currentChat.value) {
      router.push(`/chat/${chatStore.currentChat.value.id}`);
    }
  }

  // Search (Cmd+K)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
    // Detect macOS: simple check for platform or assuming metaKey is typically Command on Mac
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

    // On Mac, only trigger if Meta (Command) is pressed. Ctrl+K should be ignored (Emacs binding).
    if (isMac && !e.metaKey) return;

    e.preventDefault();
    useGlobalSearch().toggleSearch();
  }

  // Recent Chats (Cmd+P)
  // NOTE: Overriding Ctrl+P (Print) is a compromise to provide a convenient shortcut for Recent Chats.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    toggleRecent();
  }
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex h-dvh bg-gray-50/50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden transition-colors duration-300">
    <div
      class="border-r border-gray-100 dark:border-gray-800 shrink-0 h-full transition-all duration-300 ease-in-out relative z-30"
      :class="isSidebarOpen ? 'w-64' : 'w-10'"
    >
      <Sidebar />
    </div>

    <main class="flex-1 relative flex flex-col min-w-0 bg-transparent z-30">
      <!-- Use a key based on route to help Vue identify when to remount or transition -->
      <div class="flex-1 relative min-h-0">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </div>
      <Transition name="debug-panel">
        <DebugPanel v-if="isDebugOpen" />
      </Transition>
    </main>

    <SettingsModal
      :is-open="isSettingsOpen"
      @close="closeSettings"
    />

    <DebugWeshTerminalModal
      :is-open="isWeshTerminalOpen"
      @close="toggleWeshTerminal"
    />

    <Transition name="modal">
      <OnboardingModal v-if="settingsStore.initialized.value && !settingsStore.isOnboardingDismissed.value" />
    </Transition>
    <GlobalSearchModal />
    <RecentChatsModal />

    <ToastContainer />
    <PWAManager v-if="PWAManager" />

    <!-- Global Custom Confirm Dialog -->
    <CustomDialog
      :show="isConfirmOpen"
      :title="confirmTitle"
      :icon="confirmIcon"
      :message="confirmMessage"
      :confirmButtonText="confirmConfirmButtonText"
      :cancelButtonText="confirmCancelButtonText"
      :confirmButtonVariant="confirmButtonVariant"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />

    <!-- Global Custom Prompt Dialog -->
    <CustomDialog
      :show="isPromptOpen"
      :title="promptTitle"
      :message="promptMessage"
      :confirmButtonText="promptConfirmButtonText"
      :cancelButtonText="promptCancelButtonText"
      :confirmButtonVariant="'default'"
      :showInput="true"
      :inputValue="promptInputValue"
      :bodyComponent="promptBodyComponent"
      @update:inputValue="promptInputValue = $event"
      @confirm="handlePromptConfirm"
      @cancel="handlePromptCancel"
    />

    <OPFSExplorer v-model="isOPFSOpen" />
    <FileExplorerModal v-if="isFileExplorerOpen" />
  </div>

  <!-- Print-only Layer: Conditionally rendered only when activePrintMode is set. -->
  <PrintView v-if="activePrintMode !== undefined">
    <ChatPrintContent v-if="activePrintMode === 'chat'" />
  </PrintView>
</template>

<style scoped>
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Modal Transition */
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-active :deep(.modal-content-zoom),
.modal-leave-active :deep(.modal-content-zoom) {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from :deep(.modal-content-zoom),
.modal-leave-to :deep(.modal-content-zoom) {
  transform: scale(0.9);
  opacity: 0;
}

/* Debug Panel Transition */
.debug-panel-enter-active,
.debug-panel-leave-active {
  transition: all 0.3s ease-in-out;
  overflow: hidden;
}

.debug-panel-enter-from,
.debug-panel-leave-to {
  height: 0 !important;
  opacity: 0;
  border-top-width: 0;
}
</style>
