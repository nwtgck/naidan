<script setup lang="ts">
import { ref } from 'vue';
import { useErrorEvents } from '../composables/useErrorEvents';
import { 
  Terminal, ChevronUp, ChevronDown, Trash2, AlertCircle, X, Skull
} from 'lucide-vue-next';

const { errorEvents, errorEventCount, clearErrorEvents, addErrorEvent } = useErrorEvents();
const isOpen = ref(false);

function triggerTestError() {
  addErrorEvent({
    source: 'DevTools',
    message: 'Intentional test error triggered by user',
    details: {
      hint: 'This is used to verify the error event system UI.',
      browser: navigator.userAgent,
      randomValue: Math.random()
    }
  });
}

function toggle() {
  isOpen.value = !isOpen.value;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

/**
 * Safely stringify details to avoid template recursion errors.
 */
function stringifyDetails(details: unknown): string {
  if (details === undefined || details === null) return '';
  try {
    return JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    }, 2);
  } catch (_e) {
    return '[Unserializable Details]';
  }
}
</script>

<template>
  <div 
    class="fixed bottom-0 right-0 left-64 z-50 border-t border-gray-800 bg-gray-900 transition-all duration-300 shadow-2xl"
    :class="isOpen ? 'h-64' : 'h-10'"
  >
    <!-- Toggle Bar -->
    <div 
      @click="toggle"
      class="flex items-center justify-between px-4 h-10 cursor-pointer hover:bg-gray-800 transition-colors border-b border-gray-800/50"
    >
      <div class="flex items-center gap-2">
        <Terminal class="w-4 h-4 text-indigo-400" />
        <span class="text-xs font-bold text-gray-400 tracking-wider uppercase">Debug Console</span>
        <div 
          v-if="errorEventCount > 0"
          class="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/50 text-[10px] font-bold text-red-400 animate-pulse"
        >
          <AlertCircle class="w-3 h-3" />
          {{ errorEventCount }} Errors
        </div>
      </div>
      <div class="flex items-center gap-4">
        <button 
          v-if="isOpen"
          @click.stop="triggerTestError"
          class="p-1 hover:text-indigo-400 text-gray-500 transition-colors"
          title="Trigger Test Error"
        >
          <Skull class="w-3.5 h-3.5" />
        </button>
        <button 
          v-if="isOpen && errorEventCount > 0"
          @click.stop="clearErrorEvents"
          class="p-1 hover:text-red-400 text-gray-500 transition-colors"
          title="Clear Logs"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
        <component :is="isOpen ? ChevronDown : ChevronUp" class="w-4 h-4 text-gray-500" />
      </div>
    </div>

    <!-- Content -->
    <div v-if="isOpen" class="h-54 overflow-y-auto bg-black/30 font-mono text-[11px] p-2 space-y-1">
      <div v-if="errorEventCount === 0" class="flex flex-col items-center justify-center h-full text-gray-600 gap-2">
        <X class="w-8 h-8 opacity-20" />
        <p>No errors detected</p>
      </div>
      <div 
        v-for="error in errorEvents" 
        :key="error.id"
        class="border-l-2 border-red-500 bg-red-500/5 p-2 rounded-r flex gap-3 group"
      >
        <span class="text-gray-600 shrink-0">[{{ formatTime(error.timestamp) }}]</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-indigo-400 font-bold bg-indigo-400/10 px-1 rounded">{{ error.source }}</span>
            <span class="text-red-400 font-medium truncate">{{ error.message }}</span>
          </div>
          <pre v-if="error.details" class="bg-black/50 p-2 rounded text-gray-400 overflow-x-auto border border-gray-800">{{ stringifyDetails(error.details as unknown) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
pre {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
