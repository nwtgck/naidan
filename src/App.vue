<script setup lang="ts">
import { ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import SettingsModal from './components/SettingsModal.vue';
import DebugPanel from './components/DebugPanel.vue';

const isSettingsOpen = ref(false);
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