<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useChat } from './composables/useChat';
import { useSettings } from './composables/useSettings';
import { useConfirm } from './composables/useConfirm'; // Import useConfirm
import { usePrompt } from './composables/usePrompt';   // Import usePrompt
import { useOPFSExplorer } from './composables/useOPFSExplorer';
import Sidebar from './components/Sidebar.vue';
import SettingsModal from './components/SettingsModal.vue';
import OnboardingModal from './components/OnboardingModal.vue';
import DebugPanel from './components/DebugPanel.vue';
import ToastContainer from './components/ToastContainer.vue';
import CustomDialog from './components/CustomDialog.vue'; // Import CustomDialog
import OPFSExplorer from './components/OPFSExplorer.vue';
import { useLayout } from './composables/useLayout';

const isSettingsOpen = ref(false);
const chatStore = useChat();
const settingsStore = useSettings();
const { isSidebarOpen } = useLayout();
const router = useRouter();

const { isOPFSOpen } = useOPFSExplorer();

// Initialize useConfirm
const { 
  isConfirmOpen, confirmTitle, confirmMessage, 
  confirmConfirmButtonText, confirmCancelButtonText, 
  confirmButtonVariant, 
  handleConfirm, handleCancel,
} = useConfirm();

// Initialize usePrompt
const { 
  isPromptOpen, promptTitle, promptMessage, 
  promptConfirmButtonText, promptCancelButtonText, promptInputValue,
  handlePromptConfirm, handlePromptCancel,
} = usePrompt();

// Automatically create a new chat if the list becomes empty while on the landing page
// We wait until onboarding is dismissed to ensure default settings (like modelId) are available
watch(
  [
    () => chatStore.chats.value.length, 
    () => router.currentRoute.value.path, 
    () => settingsStore.initialized.value,
    () => settingsStore.isOnboardingDismissed.value
  ],
  async ([len, path, initialized, dismissed]) => {
    if (initialized && dismissed && len === 0 && path === '/') {
      await chatStore.createNewChat();
      if (chatStore.currentChat.value) {
        router.push(`/chat/${chatStore.currentChat.value.id}`);
      }
    }
  },
  { immediate: true }
);

// ChatGPT-style shortcut for New Chat: Ctrl+Shift+O (Cmd+Shift+O on Mac)
onKeyStroke(['o', 'O'], async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
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
      <Sidebar @open-settings="isSettingsOpen = true" />
    </div>
    
    <main class="flex-1 relative flex flex-col min-w-0 pb-10 bg-transparent">
      <!-- Use a key based on route to help Vue identify when to remount or transition -->
      <router-view v-slot="{ Component, route }">
        <transition name="fade" mode="out-in">
          <component :is="Component" :key="route.path" />
        </transition>
      </router-view>
      <DebugPanel />
    </main>

    <SettingsModal 
      :is-open="isSettingsOpen" 
      @close="isSettingsOpen = false" 
    />

    <OnboardingModal v-if="settingsStore.initialized && !settingsStore.isOnboardingDismissed.value" />

    <ToastContainer />

    <!-- Global Custom Confirm Dialog -->
    <CustomDialog
      :show="isConfirmOpen"
      :title="confirmTitle"
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
      @update:inputValue="promptInputValue = $event"
      @confirm="handlePromptConfirm"
      @cancel="handlePromptCancel"
    />

    <OPFSExplorer v-model="isOPFSOpen" />
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.1s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>