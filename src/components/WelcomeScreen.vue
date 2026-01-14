<script setup lang="ts">
import { ShieldCheck, Download } from 'lucide-vue-next';

defineEmits<{
  (e: 'select-suggestion', text: string): void
}>();

// Access the build mode global defined in vite.config.ts
const isHosted = typeof __BUILD_MODE_IS_HOSTED__ !== 'undefined' ? __BUILD_MODE_IS_HOSTED__ : true;

const suggestions = [
  { label: 'Write a story', text: 'Write a short story about a time-traveling detective in a cyberpunk city.' },
  { label: 'Code help', text: 'Explain how to use Vue 3 Composition API with TypeScript and provide a small example.' },
  { label: 'Brainstorm', text: 'Give me 5 creative ideas for a weekend project involving home automation.' },
  { label: 'Summarize', text: 'Summarize the key differences between various local LLM architectures.' },
];
</script>

<template>
  <div class="h-full flex flex-col items-center justify-end pb-24 p-8 text-center max-w-4xl mx-auto">
    <div class="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
      
      <!-- Security Status Section -->
      <div class="flex flex-col items-center space-y-6">
        <div class="relative group">
          <!-- Subtle Glow Effect -->
          <div class="absolute inset-0 bg-emerald-500/20 dark:bg-emerald-500/10 blur-2xl rounded-full scale-150 group-hover:scale-110 transition-transform duration-1000"></div>
          
          <div class="relative p-5 rounded-[2rem] bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/20 shadow-sm">
            <ShieldCheck class="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
          </div>
        </div>
        
        <div class="space-y-4">
          <div class="space-y-2">
            <h2 class="text-2xl sm:text-3xl font-bold text-gray-800 dark:text-gray-100 tracking-tight">
              All conversations are stored locally.
            </h2>
            <p class="text-gray-500 dark:text-gray-400 text-sm sm:text-base font-medium max-w-sm mx-auto leading-relaxed">
              Your data stays on your device.
            </p>
          </div>

          <!-- Standalone Build Link (Only in Hosted Mode) -->
          <div v-if="isHosted" class="flex justify-center pt-2">
            <a 
              href="./naidan-standalone.zip" 
              download="naidan-standalone.zip"
              class="group/btn flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 hover:border-emerald-200 dark:hover:border-emerald-500/30 hover:shadow-md transition-all duration-300"
              title="Download standalone portable version"
            >
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span class="text-[10px] font-bold text-gray-400 dark:text-gray-500 group-hover/btn:text-emerald-600 dark:group-hover/btn:text-emerald-400 transition-colors">Download portable app</span>
              <Download class="w-3 h-3 text-gray-300 dark:text-gray-600 group-hover/btn:text-emerald-500 dark:group-hover/btn:text-emerald-400 group-hover/btn:translate-y-0.5 transition-all" />
            </a>
          </div>
        </div>
      </div>

      <!-- Minimal Discovery Links -->
      <div class="pt-8 flex flex-wrap justify-center gap-x-8 gap-y-3 opacity-40 hover:opacity-100 transition-opacity duration-700">
        <button 
          v-for="s in suggestions" 
          :key="s.label"
          @click="$emit('select-suggestion', s.text)"
          class="text-xs font-semibold text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
        >
          {{ s.label }}
        </button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(1.5rem); }
  to { opacity: 0; transform: translateY(1.5rem); }
  50% { opacity: 0.5; }
  to { opacity: 1; transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-bottom-4 {
  animation-name: slide-in-from-bottom;
}
</style>
