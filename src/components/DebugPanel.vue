<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useGlobalEvents, type GlobalEvent } from '../composables/useGlobalEvents';
import { 
  Terminal, ChevronUp, ChevronDown, Trash2, AlertCircle, X, Skull, 
  Info, AlertTriangle, Bug, MoreVertical
} from 'lucide-vue-next';

const { events, eventCount, errorCount, clearEvents, addErrorEvent, addInfoEvent } = useGlobalEvents();
const isOpen = ref(false);
const isMenuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function triggerTestError() {
  addErrorEvent({
    source: 'DevTools',
    message: 'Intentional test error triggered by user',
    details: {
      hint: 'This is used to verify the error event system UI.',
      browser: navigator.userAgent
    }
  });
  isMenuOpen.value = false;
}

function triggerTestInfo() {
  addInfoEvent({
    source: 'DevTools',
    message: 'Application state synchronized',
    details: {
      status: 'success',
      timestamp: new Date().toISOString()
    }
  });
  isMenuOpen.value = false;
}

function toggle() {
  isOpen.value = !isOpen.value;
}

function toggleMenu() {
  isMenuOpen.value = !isMenuOpen.value;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

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

function getEventStyle(type: GlobalEvent['type']) {
  switch (type) {
    case 'error': return 'border-red-500 bg-red-500/5 text-red-400';
    case 'warn':  return 'border-yellow-500 bg-yellow-500/5 text-yellow-400';
    case 'info':  return 'border-blue-500 bg-blue-500/5 text-blue-400';
    default:      return 'border-gray-500 bg-gray-500/5 text-gray-400';
  }
}

function getEventIcon(type: GlobalEvent['type']) {
  switch (type) {
    case 'error': return AlertCircle;
    case 'warn':  return AlertTriangle;
    case 'info':  return Info;
    default:      return Bug;
  }
}

// Click away listener for the menu
function handleClickOutside(event: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
    isMenuOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});
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
        <span class="text-xs font-bold text-gray-400 tracking-wider uppercase">Events</span>
        
        <div 
          v-if="errorCount > 0"
          class="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/50 text-[10px] font-bold text-red-400 animate-pulse"
        >
          <AlertCircle class="w-3 h-3" />
          {{ errorCount }} Errors
        </div>

        <span 
          v-if="isOpen"
          class="text-[10px] font-medium text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded"
        >
          Total: {{ eventCount }}
        </span>
      </div>

      <div class="flex items-center gap-2 relative" ref="menuRef">
        <template v-if="isOpen">
          <button 
            v-if="eventCount > 0"
            @click.stop="clearEvents"
            class="p-1 hover:text-red-400 text-gray-500 transition-colors rounded hover:bg-gray-700"
            title="Clear Logs"
          >
            <Trash2 class="w-4 h-4" />
          </button>

          <!-- More Menu Toggle -->
          <button 
            @click.stop="toggleMenu"
            class="p-1 hover:text-white text-gray-500 transition-colors rounded hover:bg-gray-700"
            title="Development Tools"
          >
            <MoreVertical class="w-4 h-4" />
          </button>

          <!-- Dropdown Menu -->
          <div 
            v-if="isMenuOpen"
            class="absolute right-0 bottom-full mb-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden py-1 z-[60]"
          >
            <button 
              @click.stop="triggerTestInfo"
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-blue-400 hover:bg-gray-700 transition-colors"
            >
              <Info class="w-3.5 h-3.5" />
              <span>Trigger Test Info</span>
            </button>
            <button 
              @click.stop="triggerTestError"
              class="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-gray-700 transition-colors"
            >
              <Skull class="w-3.5 h-3.5" />
              <span>Trigger Test Error</span>
            </button>
          </div>
        </template>
        <component :is="isOpen ? ChevronDown : ChevronUp" class="w-4 h-4 text-gray-500" />
      </div>
    </div>

    <!-- Content Area -->
    <div v-if="isOpen" class="h-54 overflow-y-auto bg-black/30 font-mono text-[11px] p-2 space-y-1">
      <div v-if="eventCount === 0" class="flex flex-col items-center justify-center h-full text-gray-600 gap-2">
        <X class="w-8 h-8 opacity-20" />
        <p>No events recorded</p>
      </div>
      
      <div 
        v-for="event in events" 
        :key="event.id"
        class="border-l-2 p-2 rounded-r flex gap-3 group"
        :class="getEventStyle(event.type)"
      >
        <span class="text-gray-600 shrink-0">[{{ formatTime(event.timestamp) }}]</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <component :is="getEventIcon(event.type)" class="w-3 h-3" />
            <span class="font-bold bg-white/5 px-1 rounded">{{ event.source }}</span>
            <span class="font-medium truncate opacity-90">{{ event.message }}</span>
          </div>
          <pre v-if="event.details" class="bg-black/50 p-2 rounded text-gray-400 overflow-x-auto border border-gray-800">{{ stringifyDetails(event.details as any) }}</pre>
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
