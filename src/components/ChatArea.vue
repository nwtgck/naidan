<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { useChat } from '../composables/useChat';
import MessageItem from './MessageItem.vue';
import { Send } from 'lucide-vue-next';

const { currentChat, sendMessage, streaming } = useChat();
const input = ref('');
const container = ref<HTMLElement | null>(null);

async function handleSend() {
  if (!input.value.trim() || streaming.value) return;
  const text = input.value;
  input.value = '';
  await sendMessage(text);
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

onMounted(() => {
    scrollToBottom();
});
</script>

<template>
  <div class="flex flex-col h-full bg-white">
    <!-- Messages -->
    <div ref="container" class="flex-1 overflow-y-auto">
      <div v-if="!currentChat" class="h-full flex items-center justify-center text-gray-400">
        Select or create a chat to start
      </div>
      <div v-else>
        <MessageItem 
          v-for="msg in currentChat.messages" 
          :key="msg.id" 
          :message="msg" 
        />
        <div v-if="currentChat.messages.length === 0" class="p-8 text-center text-gray-500">
          Start a conversation...
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="border-t p-4" v-if="currentChat">
      <div class="max-w-4xl mx-auto relative">
        <textarea
          v-model="input"
          @keydown.enter.exact.prevent="handleSend"
          placeholder="Type a message..."
          class="w-full border rounded-lg pl-4 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24"
          :disabled="streaming"
        ></textarea>
        <button 
          @click="handleSend"
          :disabled="!input.trim() || streaming"
          class="absolute right-3 bottom-3 p-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>
