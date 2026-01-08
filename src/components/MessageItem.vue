<script setup lang="ts">
import { computed, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Message } from '../models/types';
import { User, Bot, Brain } from 'lucide-vue-next';

const props = defineProps<{
  message: Message;
}>();

const showThinking = ref(false);

const parsedContent = computed(() => {
  const html = marked.parse(props.message.content) as string;
  return DOMPurify.sanitize(html);
});

const isUser = computed(() => props.message.role === 'user');
</script>

<template>
  <div class="flex gap-4 p-4" :class="{ 'bg-gray-50': !isUser }">
    <div class="flex-shrink-0">
      <div class="w-8 h-8 rounded bg-gray-200 flex items-center justify-center">
        <User v-if="isUser" class="w-5 h-5 text-gray-600" />
        <Bot v-else class="w-5 h-5 text-indigo-600" />
      </div>
    </div>
    
    <div class="flex-1 overflow-hidden">
      <!-- Thinking Block -->
      <div v-if="message.thinking" class="mb-2">
        <button 
          @click="showThinking = !showThinking"
          class="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 bg-gray-100 px-2 py-1 rounded"
        >
          <Brain class="w-3 h-3" />
          {{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}
        </button>
        <div v-if="showThinking" class="mt-2 p-3 bg-gray-100 text-gray-600 text-sm rounded border-l-4 border-gray-300 font-mono whitespace-pre-wrap">
          {{ message.thinking }}
        </div>
      </div>

      <!-- Content -->
      <div class="prose prose-sm max-w-none text-gray-800" v-html="parsedContent"></div>
    </div>
  </div>
</template>
