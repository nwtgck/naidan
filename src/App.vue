<script setup lang="ts">
import { ref, watch, computed, defineAsyncComponent } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useChat } from './composables/useChat';
import { useSettings } from './composables/useSettings';
import { useConfirm } from './composables/useConfirm'; // Import useConfirm
import { usePrompt } from './composables/usePrompt';   // Import usePrompt
import { useOPFSExplorer } from './composables/useOPFSExplorer';
import Sidebar from './components/Sidebar.vue';
import OnboardingModal from './components/OnboardingModal.vue';
import ToastContainer from './components/ToastContainer.vue';
import { useLayout } from './composables/useLayout';

// Lazily load components that are definitely not visible on initial mount
const SettingsModal = defineAsyncComponent(() => import('./components/SettingsModal.vue'));
const DebugPanel = defineAsyncComponent(() => import('./components/DebugPanel.vue'));
const CustomDialog = defineAsyncComponent(() => import('./components/CustomDialog.vue'));
const OPFSExplorer = defineAsyncComponent(() => import('./components/OPFSExplorer.vue'));

const chatStore = useChat();
const settingsStore = useSettings();
const { isSidebarOpen } = useLayout();
const router = useRouter();
const route = useRoute();

const isSettingsOpen = computed(() => route.path.startsWith('/settings') || !!route.query.settings);
const lastNonSettingsPath = ref('/');

watch(() => route.path, (path) => {
  if (!path.startsWith('/settings')) {
    lastNonSettingsPath.value = path;
  }
});

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

// Automatically create a new chat if the list becomes empty while on the landing page
// OR if a query parameter 'q' is provided on the landing page
watch(
  [
    () => chatStore.chats.value.length, 
    () => router.currentRoute.value?.path,
    () => router.currentRoute.value?.query?.q,
    () => router.currentRoute.value?.query?.['chat-group'],
    () => router.currentRoute.value?.query?.model,
    () => settingsStore.initialized.value,
    () => settingsStore.isOnboardingDismissed.value
  ],
  async ([len, path, q, chatGroupId, modelId, initialized, dismissed]) => {
    if (!initialized || !dismissed || path !== '/') return;

    if (q || len === 0) {
      let targetGroupId: string | null = null;
      if (q && typeof chatGroupId === 'string') {
        const group = chatStore.chatGroups.value.find(g => g.id === chatGroupId || g.name === chatGroupId);
        if (group) {
          targetGroupId = group.id;
        } else {
          targetGroupId = await chatStore.createChatGroup(chatGroupId);
        }
      }

      const targetModelId = (q && typeof modelId === 'string') ? modelId : null;
      const { setActiveFocusArea } = useLayout();
      setActiveFocusArea('chat');
      await chatStore.createNewChat(targetGroupId, targetModelId);
      
      if (chatStore.currentChat.value) {
        const id = chatStore.currentChat.value.id;
        if (q) {
          router.push({
            path: `/chat/${id}`,
            query: { q: q.toString() }
          });
        } else {
          router.push(`/chat/${id}`);
        }
      }
    }
  },
  { immediate: true }
);

// ChatGPT-style shortcut for New Chat: Ctrl+Shift+O (Cmd+Shift+O on Mac)
onKeyStroke(['o', 'O'], async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
    const { setActiveFocusArea } = useLayout();
    setActiveFocusArea('chat');
    await chatStore.createNewChat();
    if (chatStore.currentChat.value) {
      router.push(`/chat/${chatStore.currentChat.value.id}`);
    }
  }
});
</script>

<template>
  <div class="flex h-screen bg-gray-50/50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden transition-colors duration-300">
    <div 
      class="border-r border-gray-100 dark:border-gray-800 shrink-0 h-full transition-all duration-300 ease-in-out relative z-30"
      :class="isSidebarOpen ? 'w-64' : 'w-10'"
    >
      <Sidebar />
    </div>
    
    <main class="flex-1 relative flex flex-col min-w-0 pb-10 bg-transparent">
      <!-- Use a key based on route to help Vue identify when to remount or transition -->
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
      <DebugPanel />
    </main>

    <SettingsModal 
      :is-open="isSettingsOpen" 
      @close="closeSettings" 
    />

    <OnboardingModal />

    <ToastContainer />

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
  </div>
</template>

<style scoped>
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

