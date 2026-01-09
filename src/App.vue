<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useChat } from './composables/useChat';
import Sidebar from './components/Sidebar.vue';
import SettingsModal from './components/SettingsModal.vue';
import DebugPanel from './components/DebugPanel.vue';

const isSettingsOpen = ref(false);
const chatStore = useChat();
const router = useRouter();

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
  <div class="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 overflow-hidden">
    <Sidebar @open-settings="isSettingsOpen = true" />
    
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