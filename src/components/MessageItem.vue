<script setup lang="ts">
import { computed, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Message } from '../models/types';
import { User, Bot, Brain } from 'lucide-vue-next';

const props = defineProps<{
  message: Message;
}>();

const showThinking = ref(true); // Default to true during streaming to see progress

const displayThinking = computed(() => {
  if (props.message.thinking) return props.message.thinking;
  
  // Try to extract from content if not yet processed (streaming case)
  const match = props.message.content.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
  return (match && match[1]) ? match[1].trim() : '';
});

const displayContent = computed(() => {
  let content = props.message.content;
  
  // Remove <think> blocks for display
  content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
  
  return content;
});

const parsedContent = computed(() => {
  const html = marked.parse(displayContent.value) as string;
  return DOMPurify.sanitize(html);
});

const isUser = computed(() => props.message.role === 'user');
const hasThinking = computed(() => !!props.message.thinking || props.message.content.includes('<think>'));
</script>

<template>
  <div class="flex gap-4 p-4" :class="{ 'bg-gray-50 dark:bg-gray-800/50': !isUser }">
    <div class="flex-shrink-0">
      <div class="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
        <User v-if="isUser" class="w-5 h-5 text-gray-600 dark:text-gray-300" />
        <Bot v-else class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
      </div>
    </div>
    
    <div class="flex-1 overflow-hidden">
      <!-- Thinking Block -->
      <div v-if="hasThinking" class="mb-2">
        <button 
          @click="showThinking = !showThinking"
          class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
        >
          <Brain class="w-3 h-3" />
          {{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}
        </button>
        <div v-if="showThinking && displayThinking" class="mt-2 p-3 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded border-l-4 border-gray-300 dark:border-gray-500 font-mono whitespace-pre-wrap">
          {{ displayThinking }}
        </div>
      </div>

      <!-- Content -->
      <div v-if="displayContent" class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200" v-html="parsedContent"></div>
    </div>
  </div>
</template>
