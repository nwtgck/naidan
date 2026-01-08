<script setup lang="ts">
import { onMounted } from 'vue';
import { useChat } from '../composables/useChat';
import { MessageSquare, Plus, Trash2, Settings as SettingsIcon } from 'lucide-vue-next';

const { chats, loadChats, createNewChat, openChat, deleteChat, currentChat } = useChat();

const emit = defineEmits<{
  (e: 'open-settings'): void
}>();

onMounted(() => {
  loadChats();
});


</script>

<template>
  <div class="flex flex-col h-full bg-gray-900 text-white w-64 border-r border-gray-800">
    <div class="p-4">
      <button 
        @click="createNewChat"
        class="w-full flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors"
      >
        <Plus class="w-4 h-4" />
        New Chat
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-2">
      <div class="space-y-1">
        <div 
          v-for="chat in chats" 
          :key="chat.id"
          @click="openChat(chat.id)"
          class="group flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors"
          :class="currentChat?.id === chat.id ? 'bg-gray-800' : 'hover:bg-gray-800'"
        >
          <div class="flex items-center gap-3 overflow-hidden">
            <MessageSquare class="w-4 h-4 text-gray-400" />
            <span class="truncate text-sm">{{ chat.title || 'Untitled Chat' }}</span>
          </div>
          <button 
            @click.stop="deleteChat(chat.id)"
            class="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400 p-1"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>

    <div class="p-4 border-t border-gray-800">
      <button 
        @click="emit('open-settings')"
        class="flex items-center gap-2 text-sm text-gray-400 hover:text-white w-full px-2 py-2 rounded hover:bg-gray-800"
      >
        <SettingsIcon class="w-4 h-4" />
        Settings
      </button>
    </div>
  </div>
</template>
