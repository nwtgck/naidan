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
  return match ? match[1].trim() : '';
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
  <div class="flex gap-4 p-4" :class="{ 'bg-gray-50': !isUser }">
    <div class="flex-shrink-0">
      <div class="w-8 h-8 rounded bg-gray-200 flex items-center justify-center">
        <User v-if="isUser" class="w-5 h-5 text-gray-600" />
        <Bot v-else class="w-5 h-5 text-indigo-600" />
      </div>
    </div>
    
    <div class="flex-1 overflow-hidden">
      <!-- Thinking Block -->
      <div v-if="hasThinking" class="mb-2">
        <button 
          @click="showThinking = !showThinking"
          class="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 bg-gray-100 px-2 py-1 rounded"
        >
          <Brain class="w-3 h-3" />
          {{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}
        </button>
        <div v-if="showThinking && displayThinking" class="mt-2 p-3 bg-gray-100 text-gray-600 text-sm rounded border-l-4 border-gray-300 font-mono whitespace-pre-wrap">
          {{ displayThinking }}
        </div>
      </div>

      <!-- Content -->
      <div v-if="displayContent" class="prose prose-sm max-w-none text-gray-800" v-html="parsedContent"></div>
    </div>
  </div>
</template>
