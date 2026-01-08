<script setup lang="ts">
import { computed, ref, onMounted, nextTick, watch } from 'vue';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js';
import mermaid from 'mermaid';

const DOMPurify = typeof window !== 'undefined' ? createDOMPurify(window) : createDOMPurify();
import 'highlight.js/styles/github-dark.css'; 
import 'katex/dist/katex.min.css';
import type { MessageNode } from '../models/types';
import { User, Bot, Brain, GitFork, Pencil, ChevronLeft, ChevronRight } from 'lucide-vue-next';

const props = defineProps<{
  message: MessageNode;
  siblings?: MessageNode[];
}>();

const emit = defineEmits<{
  (e: 'fork', messageId: string): void;
  (e: 'edit', messageId: string, newContent: string): void;
  (e: 'switch-version', messageId: string): void;
}>();

const isEditing = ref(false);
const editContent = ref(props.message.content);

const versionInfo = computed(() => {
  if (!props.siblings || props.siblings.length <= 1) return null;
  const index = props.siblings.findIndex(m => m.id === props.message.id);
  return {
    current: index + 1,
    total: props.siblings.length,
    hasPrev: index > 0,
    hasNext: index < props.siblings.length - 1,
    prevId: index > 0 ? props.siblings[index - 1]?.id : null,
    nextId: index < props.siblings.length - 1 ? props.siblings[index + 1]?.id : null,
  };
});

function handleSaveEdit() {
  if (editContent.value.trim() && editContent.value !== props.message.content) {
    emit('edit', props.message.id, editContent.value);
  }
  isEditing.value = false;
}

function handleCancelEdit() {
  editContent.value = props.message.content;
  isEditing.value = false;
}

// Initialize Mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
});

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang === 'mermaid') {
        return `<pre class="mermaid">${code}</pre>`;
      }
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    }
  })
);

marked.use(markedKatex({
  throwOnError: false,
  output: 'html'
}));

const renderMermaid = async () => {
  await nextTick();
  try {
    // Only run if there are mermaid nodes to process
    const nodes = document.querySelectorAll('.mermaid');
    if (nodes.length > 0) {
      await mermaid.run({
        nodes: nodes as any,
      });
    }
  } catch (e) {
    console.error('Mermaid render error', e);
  }
};

onMounted(renderMermaid);
watch(() => props.message.content, renderMermaid);

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
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_ATTR: ['onerror', 'onclick', 'onload'], // Explicitly forbid dangerous attributes
  });
});

const isUser = computed(() => props.message.role === 'user');
const hasThinking = computed(() => !!props.message.thinking || props.message.content.includes('<think>'));
</script>

<template>
  <div class="flex gap-4 p-4 group" :class="{ 'bg-gray-50 dark:bg-gray-800/50': !isUser }">
    <div class="flex-shrink-0">
      <div class="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
        <User v-if="isUser" class="w-5 h-5 text-gray-600 dark:text-gray-300" />
        <Bot v-else class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
      </div>
    </div>
    
    <div class="flex-1 overflow-hidden">
      <!-- Thinking Block -->
      <div v-if="hasThinking" class="mb-2" data-testid="thinking-block">
        <button 
          @click="showThinking = !showThinking"
          class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
          data-testid="toggle-thinking"
        >
          <Brain class="w-3 h-3" />
          {{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}
        </button>
        <div v-if="showThinking && displayThinking" class="mt-2 p-3 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded border-l-4 border-gray-300 dark:border-gray-500 font-mono whitespace-pre-wrap" data-testid="thinking-content">
          {{ displayThinking }}
        </div>
      </div>

      <!-- Content -->
      <div v-if="isEditing" class="mt-1" data-testid="edit-mode">
        <textarea 
          v-model="editContent"
          class="w-full border dark:border-gray-600 rounded-lg p-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 h-32"
          data-testid="edit-textarea"
        ></textarea>
        <div class="flex justify-end gap-2 mt-2">
          <button @click="handleCancelEdit" class="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">Cancel</button>
          <button @click="handleSaveEdit" class="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors" data-testid="save-edit">Send & Branch</button>
        </div>
      </div>
      <div v-else>
        <div v-if="displayContent" class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200 overflow-x-auto" v-html="parsedContent" data-testid="message-content"></div>
        
        <!-- Version Paging -->
        <div v-if="versionInfo" class="mt-2 flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest select-none" data-testid="version-paging">
          <button 
            @click="versionInfo.prevId && emit('switch-version', versionInfo.prevId)"
            :disabled="!versionInfo.hasPrev"
            class="p-1 hover:text-indigo-500 disabled:opacity-20 transition-colors"
          >
            <ChevronLeft class="w-3 h-3" />
          </button>
          <span class="min-w-[3rem] text-center">{{ versionInfo.current }} / {{ versionInfo.total }}</span>
          <button 
            @click="versionInfo.nextId && emit('switch-version', versionInfo.nextId)"
            :disabled="!versionInfo.hasNext"
            class="p-1 hover:text-indigo-500 disabled:opacity-20 transition-colors"
          >
            <ChevronRight class="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>

    <!-- Message Actions -->
    <div v-if="!isEditing" class="flex-shrink-0 self-start opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
      <button 
        v-if="isUser"
        @click="isEditing = true"
        class="p-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded transition-colors"
        title="Edit message"
      >
        <Pencil class="w-3.5 h-3.5" />
      </button>
      <button 
        @click="emit('fork', message.id)"
        class="flex items-center gap-1.5 px-2 py-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-md transition-all"
        title="Create a new chat branching from this message"
      >
        <span class="text-[10px] font-bold uppercase tracking-tight hidden lg:inline">Fork</span>
        <GitFork class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>
