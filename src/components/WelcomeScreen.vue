<script setup lang="ts">
import Logo from './Logo.vue';
import { 
  Sparkles, Zap, Lightbulb, PenTool, Code, 
} from 'lucide-vue-next';

defineEmits<{
  (e: 'select-suggestion', text: string): void
}>();

const suggestions = [
  { label: 'Write a story', icon: PenTool, text: 'Write a short story about a time-traveling detective in a cyberpunk city.' },
  { label: 'Code help', icon: Code, text: 'Explain how to use Vue 3 Composition API with TypeScript and provide a small example.' },
  { label: 'Brainstorm', icon: Lightbulb, text: 'Give me 5 creative ideas for a weekend project involving home automation.' },
  { label: 'Summarize', icon: Zap, text: 'Summarize the key differences between various local LLM architectures.' },
];
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center p-8 max-w-2xl mx-auto text-center">
    <!-- Animated Logo -->
    <div class="mb-6 p-4 rounded-3xl bg-indigo-50 dark:bg-indigo-900/10 animate-in zoom-in duration-500">
      <Logo :size="64" />
    </div>

    <!-- Hero Text -->
    <h1 class="text-3xl font-bold text-gray-800 dark:text-gray-100 mb-2 tracking-tight">
      What's on your mind?
    </h1>
    <p class="text-gray-500 dark:text-gray-400 mb-10 text-lg">
      Start a conversation or try one of these suggestions:
    </p>
    
    <!-- Suggestions Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
      <button 
        v-for="s in suggestions" 
        :key="s.label"
        @click="$emit('select-suggestion', s.text)"
        class="flex items-center gap-3 p-4 rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-indigo-300 dark:hover:border-indigo-500/50 hover:shadow-md hover:shadow-indigo-500/5 transition-all group text-left"
      >
        <div class="p-2 rounded-lg bg-gray-50 dark:bg-gray-700 group-hover:bg-indigo-50 dark:group-hover:bg-indigo-900/20 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
          <component :is="s.icon" class="w-5 h-5" />
        </div>
        <div>
          <div class="font-semibold text-sm text-gray-800 dark:text-gray-200">{{ s.label }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">{{ s.text }}</div>
        </div>
      </button>
    </div>
    
    <!-- Privacy Notice -->
    <div class="mt-12 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/50 px-3 py-1.5 rounded-full">
      <Sparkles class="w-3 h-3 text-indigo-500" />
      <span>Your privacy matters. All conversations are stored locally.</span>
    </div>
  </div>
</template>
