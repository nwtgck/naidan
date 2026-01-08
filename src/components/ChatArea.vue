<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import MessageItem from './MessageItem.vue';
import { Send, Bug, Settings2, Loader2, ArrowLeft } from 'lucide-vue-next';
import { OpenAIProvider, OllamaProvider } from '../services/llm';

const { currentChat, sendMessage, streaming, toggleDebug, forkChat } = useChat();
const { settings } = useSettings();
const router = useRouter();
const input = ref('');
// ... (rest of setup remained the same)

async function handleFork(messageId: string) {
  const newId = await forkChat(messageId);
  if (newId) {
    router.push(`/chat/${newId}`);
  }
}

function jumpToOrigin() {
  if (currentChat.value?.originChatId) {
    router.push(`/chat/${currentChat.value.originChatId}`);
  }
}
const container = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

const showChatSettings = ref(false);
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);

function focusInput() {
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

async function fetchModels() {
  if (!currentChat.value) return;
  fetchingModels.value = true;
  try {
    const type = currentChat.value.endpointType || settings.value.endpointType;
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl;
    const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
    availableModels.value = await provider.listModels(url);
  } catch (e) {
    console.error(e);
    availableModels.value = [];
  } finally {
    fetchingModels.value = false;
  }
}

async function handleSend() {
  if (!input.value.trim() || streaming.value) return;
  const text = input.value;
  input.value = '';
  await sendMessage(text);
  focusInput();
}

function scrollToBottom() {
  if (container.value) {
    container.value.scrollTop = container.value.scrollHeight;
  }
}

watch(
  () => currentChat.value?.messages.length,
  () => nextTick(scrollToBottom)
);

watch(
  () => currentChat.value?.messages[currentChat.value.messages.length - 1]?.content,
  () => {
    // Scroll if near bottom or if it's the assistant typing
    if (container.value) {
        const { scrollTop, scrollHeight, clientHeight } = container.value;
        if (scrollHeight - scrollTop - clientHeight < 100) {
            scrollToBottom();
        }
    }
  },
  { deep: true }
);

watch(
  () => currentChat.value?.id,
  () => {
    if (currentChat.value) {
      focusInput();
    }
  }
);

onMounted(() => {
    scrollToBottom();
    if (currentChat.value) {
      focusInput();
    }
});
</script>

<template>
  <div class="flex flex-col h-full bg-white dark:bg-gray-800">
    <!-- Header -->
    <div v-if="currentChat" class="border-b dark:border-gray-700 px-6 py-4 flex items-center justify-between bg-white dark:bg-gray-800 shadow-sm z-10">
        <div class="flex flex-col overflow-hidden">
          <div class="flex items-center gap-3">
            <button 
              v-if="currentChat.originChatId"
              @click="jumpToOrigin"
              class="p-1.5 -ml-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-indigo-600 transition-colors"
              title="Jump to original chat"
            >
              <ArrowLeft class="w-5 h-5" />
            </button>
            <h2 class="text-xl font-bold text-gray-800 dark:text-gray-100 truncate">{{ currentChat.title }}</h2>
          </div>
          <p class="text-xs text-gray-400 dark:text-gray-500 truncate" :class="{ 'ml-8': currentChat.originChatId }">Model: {{ currentChat.overrideModelId || settings.defaultModelId || 'Default' }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button 
              @click="showChatSettings = !showChatSettings; if(showChatSettings) fetchModels()"
              class="p-2 rounded-md transition-colors"
              :class="showChatSettings ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'"
              title="Chat Settings"
          >
              <Settings2 class="w-5 h-5" />
          </button>
          <button 
              @click="toggleDebug"
              class="p-2 rounded-md transition-colors"
              :class="currentChat.debugEnabled ? 'text-green-600 bg-green-50 dark:bg-green-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'"
              title="Toggle Debug Mode for this Chat"
          >
              <Bug class="w-5 h-5" />
          </button>
        </div>
    </div>

    <!-- Chat Settings Panel -->
    <div v-if="showChatSettings && currentChat" class="border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-4 animate-in slide-in-from-top duration-200">
      <div class="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Endpoint Type</label>
          <select 
            v-model="currentChat.endpointType"
            class="w-full text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800"
          >
            <option :value="undefined">Global ({{ settings.endpointType }})</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Endpoint URL</label>
          <input 
            v-model="currentChat.endpointUrl"
            type="text"
            class="w-full text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800"
            :placeholder="settings.endpointUrl"
          />
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Model Override</label>
          <div class="flex gap-1">
            <select 
              v-model="currentChat.overrideModelId"
              class="flex-1 text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800"
            >
              <option :value="undefined">Global ({{ settings.defaultModelId || 'Default' }})</option>
              <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
            </select>
            <button @click="fetchModels" class="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
              <Loader2 v-if="fetchingModels" class="w-4 h-4 animate-spin" />
              <span v-else class="text-xs text-gray-400">Ref</span>
            </button>
          </div>
        </div>
      </div>
      <div class="mt-2 flex justify-end">
        <button @click="showChatSettings = false" class="text-xs text-indigo-600 hover:underline">Close Settings</button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="container" class="flex-1 overflow-y-auto">
      <div v-if="!currentChat" class="h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
        Select or create a chat to start
      </div>
      <div v-else>
        <transition-group name="list" tag="div">
          <MessageItem 
            v-for="msg in currentChat.messages" 
            :key="msg.id" 
            :message="msg" 
            @fork="handleFork"
          />
        </transition-group>
        <div v-if="currentChat.messages.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          Start a conversation...
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="border-t dark:border-gray-700 p-4" v-if="currentChat">
      <div class="max-w-4xl mx-auto relative">
        <textarea
          ref="textareaRef"
          v-model="input"
          @keydown.enter.ctrl.prevent="handleSend"
          @keydown.enter.meta.prevent="handleSend"
          placeholder="Type a message..."
          class="w-full border dark:border-gray-600 rounded-lg pl-4 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          :disabled="streaming"
        ></textarea>
        <button 
          @click="handleSend"
          :disabled="!input.trim() || streaming"
          class="absolute right-3 bottom-3 px-3 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shadow-sm"
          :title="`Send message (${sendShortcutText})`"
        >
          <span class="text-xs font-medium opacity-90 hidden sm:inline">{{ sendShortcutText }}</span>
          <Send class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.list-enter-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-out;
}
.list-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
/* No leave-active here to ensure instant clearing when switching chats */
</style>
