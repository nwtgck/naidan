<script setup lang="ts">
import { ref, onMounted } from 'vue';
import Sidebar from './components/Sidebar.vue';
import ChatArea from './components/ChatArea.vue';
import SettingsModal from './components/SettingsModal.vue';
import DebugPanel from './components/DebugPanel.vue';
import { useSettings } from './composables/useSettings';
import { useChat } from './composables/useChat';
import { useTheme } from './composables/useTheme';

const { init: initSettings } = useSettings();
const { loadChats } = useChat();
useTheme(); // Initialize theme logic

const showSettings = ref(false);

onMounted(async () => {
  await initSettings();
  await loadChats();
});
</script>

<template>
  <div class="flex h-screen w-screen bg-gray-100 dark:bg-gray-900 overflow-hidden text-gray-900 dark:text-gray-100 font-sans">
    <!-- Sidebar -->
    <Sidebar @open-settings="showSettings = true" />

    <!-- Main Chat Area -->
    <main class="flex-1 h-full relative">
      <router-view />
      <DebugPanel />
    </main>

    <!-- Settings Modal -->
    <SettingsModal 
      :isOpen="showSettings" 
      @close="showSettings = false"
    />
  </div>
</template>