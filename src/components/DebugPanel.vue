<script setup lang="ts">
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { computed } from 'vue';

const { currentChat, chats, streaming } = useChat();
const { settings } = useSettings();

const isDebug = computed(() => settings.value.debugMode);
</script>

<template>
  <div v-if="isDebug" class="fixed bottom-0 right-0 w-96 h-96 bg-gray-900 text-green-400 p-4 overflow-auto border-t border-l border-gray-700 shadow-xl opacity-90 text-xs font-mono z-40">
    <div class="mb-4">
      <h3 class="font-bold text-white mb-2 border-b border-gray-700 pb-1">State Monitor</h3>
      <div class="mb-2">
        <span class="text-gray-400">Streaming:</span> {{ streaming }}
      </div>
      <div class="mb-2">
         <span class="text-gray-400">Storage:</span> {{ settings.storageType }}
      </div>
    </div>

    <div class="mb-4">
      <h3 class="font-bold text-white mb-2 border-b border-gray-700 pb-1">Current Chat</h3>
      <pre v-if="currentChat">{{ currentChat }}</pre>
      <div v-else class="text-gray-500">(No chat selected)</div>
    </div>

    <div>
      <h3 class="font-bold text-white mb-2 border-b border-gray-700 pb-1">Chat List</h3>
      <pre>{{ chats }}</pre>
    </div>
  </div>
</template>
