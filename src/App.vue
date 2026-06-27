<script setup lang="ts">
import { ref, watch, computed, defineAsyncComponent } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useCurrentChatState } from './composables/chat/ui/useCurrentChatState';
import { useChatLifecycle } from './composables/chat/ui/useChatLifecycle';
import { useChatListData } from './composables/chat/ui/useChatListData';
import { useChatOrganization } from './composables/chat/ui/useChatOrganization';
import { useSettings } from './composables/useSettings';
import { useFileExplorerModal } from './composables/useFileExplorerModal';
import { usePrint } from './composables/usePrint';
import Sidebar from './components/Sidebar.vue';
import MainLayoutFrame from './components/layout/MainLayoutFrame.vue';
import { idToRaw, toChatId } from '@/models/ids';
import type { ChatGroupId } from '@/models/ids';

// Async components for print mode to keep initial bundle small.
const PrintView = defineAsyncComponent(() => import('./components/PrintView.vue'));
const ChatPrintContent = defineAsyncComponent(() => import('./components/ChatPrintContent.vue'));

import { useLayout } from './composables/useLayout';
import { defineAsyncComponentAndLoadOnMounted } from './utils/vue';
import { useGlobalSearch } from './composables/useGlobalSearch';
import { useRecentChats } from './composables/useRecentChats';

// PWA manager (only for hosted mode)
const PWAManager = __BUILD_MODE_IS_HOSTED__
  ? defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/PWAManager.vue') })
  : undefined;
// Lazily load components that are not visible on initial mount, but prefetch them when idle.
const SettingsModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/SettingsModal.vue') });
const DebugWeshTerminalModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/DebugWeshTerminalModal.vue') });
const GlobalSearchModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/GlobalSearchModal.vue') });
const RecentChatsModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/RecentChatsModal.vue') });
const DebugPanel = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/DebugPanel.vue') });
const FileExplorerModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./components/FileExplorerModal.vue') });

const currentChatState = useCurrentChatState();
const chatLifecycle = useChatLifecycle();
const chatListData = useChatListData();
const chatOrganization = useChatOrganization();
const settingsStore = useSettings();
const { addRecentChat, toggleRecent } = useRecentChats();
const { isSidebarOpen, isDebugOpen, isWeshTerminalOpen, toggleWeshTerminal } = useLayout();
const sidebarWidth = computed(() => isSidebarOpen.value ? 'expanded' as const : 'collapsed' as const);
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
    addRecentChat({ id: toChatId({ raw: route.params.id }) });
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

const { isFileExplorerOpen } = useFileExplorerModal();

// Automatically create a new chat if the list becomes empty while on the landing page
// OR if a query parameter 'q' is provided on the landing page
watch(
  [
    () => chatListData.chats.value.length,
    () => router.currentRoute.value?.path,
    () => router.currentRoute.value?.query?.q,
    () => router.currentRoute.value?.query?.['chat-group'],
    () => router.currentRoute.value?.query?.model,
    () => router.currentRoute.value?.query?.['system-prompt'] || router.currentRoute.value?.query?.sp,
    () => settingsStore.initialized.value,
    () => settingsStore.isOnboardingDismissed.value,
  ],
  async ([len, path, q, chatGroupId, modelId, systemPromptStr, initialized, dismissed]) => {
    if (!initialized || !dismissed || path !== '/') return;

    // 1. Handle empty state fallback (e.g. first time users or after clearing all chats)
    // This ignores URL parameters and just ensures the user has something to interact with.
    if (len === 0 && !q) {
      const { setActiveFocusArea } = useLayout();
      setActiveFocusArea({ area: 'chat' });
      await chatLifecycle.createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
      if (currentChatState.currentChat.value) {
        router.push(`/chat/${idToRaw({ id: currentChatState.currentChat.value.id })}`);
      }
      return;
    }

    // 2. Handle URL Query Parameters
    // We only trigger this if 'q' is provided. 'system-prompt' or 'model' alone
    // does not trigger a new chat.
    if (q) {
      let targetGroupId: ChatGroupId | undefined = undefined;
      if (typeof chatGroupId === 'string') {
        const group = currentChatState.chatGroups.value.find(g => idToRaw({ id: g.id }) === chatGroupId || g.name === chatGroupId);
        if (group) {
          targetGroupId = group.id;
        } else {
          targetGroupId = await chatOrganization.createChatGroup({ name: chatGroupId, options: undefined });
        }
      }

      const targetModelId = (typeof modelId === 'string') ? modelId : undefined;
      const systemPrompt = (typeof systemPromptStr === 'string' && systemPromptStr)
        ? { behavior: 'override' as const, content: systemPromptStr }
        : undefined;

      const { setActiveFocusArea } = useLayout();
      setActiveFocusArea({ area: 'chat' });
      await chatLifecycle.createNewChat({
        groupId: targetGroupId,
        modelId: targetModelId,
        systemPrompt,
      });

      if (currentChatState.currentChat.value) {
        const id = currentChatState.currentChat.value.id;
        router.push({
          path: `/chat/${idToRaw({ id })}`,
          query: { q: q.toString() },
        });
      }
    }
  },
  { immediate: true },
);

// ChatGPT-style shortcut for New Chat: Ctrl+Shift+O (Cmd+Shift+O on Mac)
onKeyStroke(['o', 'O', 'k', 'K', 'p', 'P'], async (e) => {
  // New Chat
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    const { setActiveFocusArea } = useLayout();
    setActiveFocusArea({ area: 'chat' });
    await chatLifecycle.createNewChat({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined,
    });
    if (currentChatState.currentChat.value) {
      router.push(`/chat/${idToRaw({ id: currentChatState.currentChat.value.id })}`);
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
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <MainLayoutFrame :sidebar-width="sidebarWidth">
    <template #sidebar>
      <Sidebar />
    </template>

    <template #main>
      <!-- Use a key based on route to help Vue identify when to remount or transition -->
      <div class="flex-1 relative min-h-0">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </div>
      <Transition name="debug-panel">
        <DebugPanel v-if="isDebugOpen" />
      </Transition>
    </template>
  </MainLayoutFrame>

  <SettingsModal
    :is-open="isSettingsOpen"
    @close="closeSettings"
  />

  <DebugWeshTerminalModal
    :is-open="isWeshTerminalOpen"
    @close="toggleWeshTerminal"
  />

  <GlobalSearchModal />
  <RecentChatsModal />

  <PWAManager v-if="PWAManager" />

  <FileExplorerModal v-if="isFileExplorerOpen" />

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
