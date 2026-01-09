<script setup lang="ts">
import { ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import SettingsModal from './components/SettingsModal.vue';
import DebugPanel from './components/DebugPanel.vue';

const isSettingsOpen = ref(false);
</script>

<template>
  <div class="flex h-screen bg-gray-50 text-gray-900 overflow-hidden">
    <Sidebar @open-settings="isSettingsOpen = true" />
    
    <main class="flex-1 relative flex flex-col min-w-0 pb-10">
      <router-view />
      <DebugPanel />
    </main>

    <SettingsModal 
      :is-open="isSettingsOpen" 
      @close="isSettingsOpen = false" 
    />
  </div>
</template>

<style scoped>
/* Scoped styles here if needed */
</style>
