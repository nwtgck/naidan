<script setup lang="ts">
import { ShieldCheck, Download } from 'lucide-vue-next';

defineProps<{
  hasInput?: boolean
}>();

defineEmits<{
  (e: 'select-suggestion', text: string): void
}>();

// Access the build mode global defined in vite.config.ts
const isHosted = (() => {
  const t = typeof __BUILD_MODE_IS_HOSTED__;
  switch (t) {
  case 'undefined':
    return true;
  case 'boolean':
  case 'string':
  case 'number':
  case 'object':
  case 'function':
  case 'symbol':
  case 'bigint':
    return __BUILD_MODE_IS_HOSTED__;
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();

const suggestions = [
  { label: 'Write a story', text: 'Write a short story about a time-traveling detective in a cyberpunk city.' },
  { label: 'Code help', text: 'Explain how to use Vue 3 Composition API with TypeScript and provide a small example.' },
  { label: 'Brainstorm', text: 'Give me 5 creative ideas for a weekend project involving home automation.' },
  { label: 'Summarize', text: 'Summarize the key differences between various local LLM architectures.' },
];


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="absolute inset-0 flex flex-col items-center justify-center p-6 sm:p-12 text-center pointer-events-none">
    <div class="w-full max-w-4xl flex flex-col items-center space-y-8 sm:space-y-12 translate-y-[-25%] sm:translate-y-[-30%] animate-in fade-in zoom-in duration-1000">

      <!-- Security Status Section -->
      <div class="flex flex-col items-center space-y-4 sm:space-y-6 pointer-events-auto">
        <div class="relative group">
          <!-- Subtle Glow Effect -->
          <div class="absolute inset-0 bg-emerald-500/20 dark:bg-emerald-500/10 blur-2xl rounded-full scale-150 group-hover:scale-110 transition-transform duration-1000"></div>

          <div class="relative p-4 sm:p-5 rounded-[2rem] bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/20 shadow-sm">
            <ShieldCheck class="w-8 h-8 sm:w-10 sm:h-10 text-emerald-600 dark:text-emerald-400" />
          </div>
        </div>

        <div class="space-y-3 sm:space-y-4">
          <div class="space-y-1 sm:space-y-2">
            <h2 class="text-xl sm:text-3xl font-bold text-gray-800 dark:text-gray-100 tracking-tight leading-tight">
              All conversations are stored locally.
            </h2>
            <p class="text-gray-500 dark:text-gray-400 text-xs sm:text-base font-medium max-w-sm mx-auto leading-relaxed">
              Your data stays on your device.
            </p>
          </div>

          <!-- Standalone Build Link (Only in Hosted Mode) -->
          <div v-if="isHosted" class="flex justify-center pt-1">
            <a
              href="./naidan-standalone.zip"
              download="naidan-standalone.zip"
              class="group/btn flex items-center gap-2 px-3 py-1 sm:px-4 sm:py-1.5 rounded-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 hover:border-emerald-200 dark:hover:border-emerald-500/30 hover:shadow-md transition-all duration-300"
              title="Download standalone portable version"
            >
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span class="text-[9px] sm:text-[10px] font-bold text-gray-400 dark:text-gray-500 group-hover/btn:text-emerald-600 dark:group-hover/btn:text-emerald-400 transition-colors">Download portable app</span>
              <Download class="w-2.5 h-2.5 sm:w-3 sm:h-3 text-gray-300 dark:text-gray-600 group-hover/btn:text-emerald-500 dark:group-hover/btn:text-emerald-400 group-hover/btn:translate-y-0.5 transition-all" />
            </a>
          </div>
        </div>
      </div>

      <!-- Minimal Discovery Links -->
      <div
        data-testid="suggestions-container"
        class="pt-4 sm:pt-8 flex flex-wrap justify-center gap-x-6 sm:gap-x-8 gap-y-2 sm:gap-y-3 transition-all duration-700 pointer-events-auto"
        :class="hasInput ? 'opacity-0 pointer-events-none translate-y-2' : 'opacity-40 hover:opacity-100 translate-y-0'"
      >
        <button
          v-for="s in suggestions"
          :key="s.label"
          @click="$emit('select-suggestion', s.text)"
          class="text-[10px] sm:text-xs font-semibold text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
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
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes slide-in-from-bottom {
  from { transform: translateY(1.5rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in {
  animation-name: zoom-in;
}
</style>

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
