<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../composables/useChat';
import { useTheme } from '../composables/useTheme';
import { MessageSquare, Plus, Trash2, Settings as SettingsIcon, Sun, Moon, Monitor, RotateCcw, AlertTriangle, Pencil, Check, X } from 'lucide-vue-next';

const { chats, loadChats, createNewChat, deleteChat, currentChat, lastDeletedChat, undoDelete, deleteAllChats, renameChat } = useChat();
const { themeMode, setTheme } = useTheme();
const router = useRouter();

const editingId = ref<string | null>(null);
const editingTitle = ref('');

const emit = defineEmits<{
  (e: 'open-settings'): void
}>();

onMounted(() => {
  loadChats();
});

async function handleNewChat() {
  await createNewChat();
  if (currentChat.value) {
    router.push(`/chat/${currentChat.value.id}`);
  }
}

function handleOpenChat(id: string) {
  if (editingId.value === id) return;
  router.push(`/chat/${id}`);
}

async function handleDeleteChat(id: string) {
  const isCurrent = currentChat.value?.id === id;
  await deleteChat(id);
  if (isCurrent) {
    router.push('/');
  }
}

function startEditing(id: string, title: string) {
  editingId.value = id;
  editingTitle.value = title;
}

async function saveRename() {
  if (editingId.value && editingTitle.value.trim()) {
    await renameChat(editingId.value, editingTitle.value.trim());
  }
  editingId.value = null;
}

function cancelRename() {
  editingId.value = null;
}


async function handleDeleteAll() {
  if (confirm('Are you absolutely sure you want to delete ALL chats? This action cannot be undone (except for the very last one via Undo).')) {
    await deleteAllChats();
    router.push('/');
  }
}

async function handleUndo() {
  await undoDelete();
  if (currentChat.value) {
    router.push(`/chat/${currentChat.value.id}`);
  }
}
</script>

<template>
  <div class="flex flex-col h-full bg-gray-900 text-white w-64 border-r border-gray-800">
    <div class="p-4 space-y-2">
      <button 
        @click="handleNewChat"
        class="w-full flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors"
      >
        <Plus class="w-4 h-4" />
        New Chat
      </button>

      <!-- Undo Button -->
      <button 
        v-if="lastDeletedChat"
        @click="handleUndo"
        class="w-full flex items-center justify-center gap-2 bg-green-600/20 hover:bg-green-600/30 text-green-400 px-4 py-2 rounded-lg transition-colors text-sm border border-green-600/30"
      >
        <RotateCcw class="w-4 h-4" />
        Undo Delete
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-2">
      <div class="space-y-1">
        <div 
          v-for="chat in chats" 
          :key="chat.id"
          @click="handleOpenChat(chat.id)"
          class="group flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors"
          :class="currentChat?.id === chat.id ? 'bg-gray-800' : 'hover:bg-gray-800'"
        >
          <div class="flex items-center gap-3 overflow-hidden flex-1">
            <MessageSquare class="w-4 h-4 text-gray-400 flex-shrink-0" />
            <div v-if="editingId === chat.id" class="flex items-center gap-1 flex-1">
              <input 
                v-model="editingTitle"
                @keyup.enter="saveRename"
                @keyup.esc="cancelRename"
                @click.stop
                class="bg-gray-700 text-white text-sm px-1 py-0.5 rounded w-full outline-none focus:ring-1 focus:ring-indigo-500"
                auto-focus
              />
              <button @click.stop="saveRename" class="text-green-400 hover:text-green-300 p-0.5">
                <Check class="w-3 h-3" />
              </button>
              <button @click.stop="cancelRename" class="text-red-400 hover:text-red-300 p-0.5">
                <X class="w-3 h-3" />
              </button>
            </div>
            <span v-else class="truncate text-sm">{{ chat.title || 'Untitled Chat' }}</span>
          </div>
          <div v-if="editingId !== chat.id" class="flex items-center gap-1">
            <button 
              @click.stop="startEditing(chat.id, chat.title || '')"
              class="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-indigo-400 p-1 transition-opacity"
            >
              <Pencil class="w-4 h-4" />
            </button>
            <button 
              @click.stop="handleDeleteChat(chat.id)"
              class="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400 p-1 transition-opacity"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="p-4 border-t border-gray-800 space-y-4">
      <!-- Danger Zone -->
      <button 
        v-if="chats.length > 0"
        @click="handleDeleteAll"
        class="flex items-center gap-2 text-xs text-red-400/60 hover:text-red-400 w-full px-2 py-1 rounded hover:bg-red-900/20 transition-colors"
      >
        <AlertTriangle class="w-3 h-3" />
        Clear All History
      </button>

      <!-- Theme Toggle -->
      <div class="flex items-center justify-between bg-gray-800 p-1 rounded-lg">
        <button 
          @click="setTheme('light')"
          class="flex-1 flex justify-center py-1.5 rounded-md transition-all"
          :class="themeMode === 'light' ? 'bg-gray-700 text-yellow-400 shadow-sm' : 'text-gray-400 hover:text-gray-200'"
          title="Light Mode"
        >
          <Sun class="w-4 h-4" />
        </button>
        <button 
          @click="setTheme('dark')"
          class="flex-1 flex justify-center py-1.5 rounded-md transition-all"
          :class="themeMode === 'dark' ? 'bg-gray-700 text-indigo-400 shadow-sm' : 'text-gray-400 hover:text-gray-200'"
          title="Dark Mode"
        >
          <Moon class="w-4 h-4" />
        </button>
        <button 
          @click="setTheme('system')"
          class="flex-1 flex justify-center py-1.5 rounded-md transition-all"
          :class="themeMode === 'system' ? 'bg-gray-700 text-green-400 shadow-sm' : 'text-gray-400 hover:text-gray-200'"
          title="System Preference"
        >
          <Monitor class="w-4 h-4" />
        </button>
      </div>

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
