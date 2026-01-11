<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import MessageItem from './MessageItem.vue';
import { Send, Bug, Settings2, Loader2, ArrowLeft, Square } from 'lucide-vue-next';

const chatStore = useChat();
const {
  currentChat,
  streaming,
  activeMessages,
  availableModels,
  fetchingModels,
} = chatStore;
const { settings } = useSettings();
const router = useRouter();
const input = ref('');
const container = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

const showChatSettings = ref(false);

function focusInput() {
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

function scrollToBottom() {
  if (container.value) {
    container.value.scrollTop = container.value.scrollHeight;
  }
}

// Expose for testing
defineExpose({ scrollToBottom, container, handleSend });

async function fetchModels() {
  await chatStore.fetchAvailableModels();
}

async function handleSend() {
  if (!input.value.trim() || streaming.value) return;
  const text = input.value;
  input.value = '';
  await chatStore.sendMessage(text);
  focusInput();
}

async function handleEdit(messageId: string, newContent: string) {
  await chatStore.editMessage(messageId, newContent);
}

function handleSwitchVersion(messageId: string) {
  chatStore.switchVersion(messageId);
}

async function handleFork(messageId: string) {
  const newId = await chatStore.forkChat(messageId);
  if (newId) {
    router.push(`/chat/${newId}`);
  }
}

function jumpToOrigin() {
  if (currentChat.value?.originChatId) {
    router.push(`/chat/${currentChat.value.originChatId}`);
  }
}

watch(
  () => activeMessages.value.length,
  () => nextTick(scrollToBottom),
);

watch(
  () => activeMessages.value[activeMessages.value.length - 1]?.content,
  (newContent) => {
    if (streaming.value && newContent && newContent.length < 400 && container.value) {
        const { scrollTop, scrollHeight, clientHeight } = container.value;
        // Only auto-scroll if user is already at the bottom (within 50px)
        if (scrollHeight - scrollTop - clientHeight < 50) {
            nextTick(scrollToBottom);
        }
    }
  },
  { deep: true },
);

watch(
  () => currentChat.value?.id,
  () => {
    if (currentChat.value) {
      nextTick(scrollToBottom);
      focusInput();
    }
  },
);

onMounted(() => {
    nextTick(scrollToBottom);
    if (currentChat.value) {
      focusInput();
    }
});
</script>

<template>
  <div class="flex flex-col h-full bg-white dark:bg-gray-900 transition-colors">
    <!-- Header -->
    <div v-if="currentChat" class="border-b dark:border-gray-800 px-6 py-4 flex items-center justify-between bg-white dark:bg-gray-900 shadow-sm z-10">
      <div class="flex flex-col overflow-hidden">
        <div class="flex items-center gap-3">
          <button 
            v-if="currentChat.originChatId"
            @click="jumpToOrigin"
            class="p-1.5 -ml-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-indigo-600 transition-colors"
            title="Jump to original chat"
          >
            <ArrowLeft class="w-5 h-5" />
          </button>
          <h2 class="text-xl font-bold text-gray-800 dark:text-gray-100 truncate">{{ currentChat.title || 'Untitled Chat' }}</h2>
        </div>
        <p class="text-xs text-gray-400 dark:text-gray-500 truncate" :class="{ 'ml-8': currentChat.originChatId }">Model: {{ currentChat.overrideModelId || settings.defaultModelId || 'Default' }}</p>
      </div>
      <div class="flex items-center gap-2">
        <button 
          @click="showChatSettings = !showChatSettings; if(showChatSettings) fetchModels()"
          class="p-2 rounded-md transition-colors"
          :class="showChatSettings ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'"
          title="Chat Settings"
        >
          <Settings2 class="w-5 h-5" />
        </button>
        <button 
          @click="chatStore.toggleDebug"
          class="p-2 rounded-md transition-colors"
          :class="currentChat.debugEnabled ? 'text-green-600 bg-green-50 dark:bg-green-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'"
          title="Toggle Debug Mode for this Chat"
        >
          <Bug class="w-5 h-5" />
        </button>
      </div>
    </div>

    <!-- Chat Settings Panel -->
    <div v-if="showChatSettings && currentChat" class="border-b dark:border-gray-800 bg-gray-50 dark:bg-gray-950/50 p-4 animate-in slide-in-from-top duration-200">
      <div class="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Endpoint Type</label>
          <select 
            v-model="currentChat.endpointType"
            class="w-full text-sm border dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800"
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
            class="w-full text-sm border dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800"
            :placeholder="settings.endpointUrl"
          />
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Model Override</label>
          <div class="flex gap-1">
            <select 
              v-model="currentChat.overrideModelId"
              class="flex-1 text-sm border dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800"
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
    <div class="flex-1 flex overflow-hidden">
      <div ref="container" data-testid="scroll-container" class="flex-1 overflow-y-auto relative">
        <div v-if="!currentChat" class="h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
          Select or create a chat to start
        </div>
        <div v-else class="relative p-2">
          <!-- Removed transition-group to prevent unstable jumping between chats -->
          <MessageItem 
            v-for="msg in activeMessages" 
            :key="msg.id" 
            :message="msg" 
            :siblings="chatStore.getSiblings(msg.id)"
            @fork="handleFork"
            @edit="handleEdit"
            @switch-version="handleSwitchVersion"
            class="animate-in fade-in duration-300"
          />
          <div v-if="activeMessages.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
            Start a conversation...
          </div>
        </div>
      </div>

      <!-- Chat State Inspector (Debug Mode) -->
      <div 
        v-if="currentChat?.debugEnabled" 
        class="w-96 border-l dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-y-auto p-4 font-mono text-[10px] animate-in slide-in-from-right duration-300 shadow-xl z-20"
        data-testid="chat-inspector"
      >
        <div class="flex items-center justify-between mb-4 pb-2 border-b dark:border-gray-800">
          <div class="flex items-center gap-2 text-indigo-500 uppercase font-bold tracking-widest">
            <Bug class="w-3.5 h-3.5" />
            <span>Chat Inspector</span>
          </div>
          <button @click="chatStore.toggleDebug" class="text-gray-400 hover:text-white">
            <Square class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="space-y-4">
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Metadata</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ JSON.stringify({ id: currentChat.id, title: currentChat.title, model: currentChat.modelId, currentLeafId: currentChat.currentLeafId }, null, 2) }}</pre>
          </section>
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Active Branch Path</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ activeMessages.map(m => `[${m.role.slice(0,1).toUpperCase()}] ${m.id.slice(0,8)}...`).join(' -> ') }}</pre>
          </section>
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Full Tree Structure</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ JSON.stringify(currentChat.root.items, null, 2) }}</pre>
          </section>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="border-t dark:border-gray-800 p-4" v-if="currentChat">
      <div class="max-w-4xl mx-auto relative">
        <textarea
          ref="textareaRef"
          v-model="input"
          @keydown.enter.ctrl.prevent="handleSend"
          @keydown.enter.meta.prevent="handleSend"
          @keydown.esc.prevent="streaming ? chatStore.abortChat() : null"
          placeholder="Type a message..."
          class="w-full border dark:border-gray-700 rounded-lg pl-4 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          data-testid="chat-input"
        ></textarea>
        <button 
          @click="streaming ? chatStore.abortChat() : handleSend()"
          :disabled="!streaming && !input.trim()"
          class="absolute right-3 bottom-3 px-3 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors shadow-sm"
          :title="streaming ? 'Stop generating (Esc)' : `Send message (${sendShortcutText})`"
          :data-testid="streaming ? 'abort-button' : 'send-button'"
        >
          <template v-if="streaming">
            <span class="text-xs font-medium opacity-90 hidden sm:inline">Esc</span>
            <Square class="w-4 h-4 fill-white text-white" />
          </template>
          <template v-else>
            <span class="text-xs font-medium opacity-90 hidden sm:inline">{{ sendShortcutText }}</span>
            <Send class="w-4 h-4" />
          </template>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Simplified animations */
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fade-in {
  animation-name: fade-in;
}
</style>
