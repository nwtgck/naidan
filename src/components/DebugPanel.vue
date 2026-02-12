<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useGlobalEvents, type GlobalEvent } from '../composables/useGlobalEvents';
import { useOPFSExplorer } from '../composables/useOPFSExplorer';
import { useLayout } from '../composables/useLayout';
import { 
  Terminal, Trash2, AlertCircle, X, Skull, 
  Info, AlertTriangle, Bug, MoreVertical, HardDrive,
} from 'lucide-vue-next';

const { events, eventCount, errorCount, clearEvents, addErrorEvent, addInfoEvent } = useGlobalEvents();
const { openOPFS } = useOPFSExplorer();
const { isDebugOpen, toggleDebug } = useLayout();
const isMenuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function triggerTestError() {
  addErrorEvent({
    source: 'DevTools',
    message: 'Intentional test error triggered by user',
    details: {
      hint: 'This is used to verify the error event system UI.',
      browser: navigator.userAgent,
    },
  });
  isMenuOpen.value = false;
}

function triggerTestInfo() {
  addInfoEvent({
    source: 'DevTools',
    message: 'Application state synchronized',
    details: {
      status: 'success',
      timestamp: new Date().toISOString(),
    },
  });
  isMenuOpen.value = false;
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


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div 
    class="shrink-0 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 transition-all duration-300 ease-in-out relative"
    :class="isDebugOpen ? 'h-72 overflow-visible z-50' : 'h-0 overflow-hidden z-0'"
    data-testid="debug-panel"
  >
    <!-- Toolbar -->
    <div 
      class="flex items-center justify-between px-4 h-10 border-b border-gray-100 dark:border-gray-800/50 bg-gray-50/80 dark:bg-black/40 backdrop-blur-sm sticky top-0 z-10"
    >
      <div class="flex items-center gap-2">
        <Terminal class="w-4 h-4 text-blue-600 dark:text-blue-400" />
        <span class="text-[10px] font-bold text-gray-400 dark:text-gray-500 tracking-widest uppercase">System Events</span>
        
        <div 
          v-if="errorCount > 0"
          class="ml-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-500/20 border border-red-100 dark:border-red-500/50 text-[10px] font-bold text-red-600 dark:text-red-400 animate-pulse"
          data-testid="debug-error-badge"
        >
          <AlertCircle class="w-3 h-3" />
          {{ errorCount }} Errors
        </div>

        <span
          class="text-[10px] font-bold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded-lg"
          data-testid="debug-total-badge"
        >
          Total: {{ eventCount }}
        </span>
      </div>

      <div class="flex items-center gap-2 relative" ref="menuRef">
        <button 
          v-if="eventCount > 0"
          @click.stop="clearEvents"
          class="p-1.5 hover:text-red-600 dark:hover:text-red-400 text-gray-400 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Clear Logs"
          data-testid="debug-clear-button"
        >
          <Trash2 class="w-4 h-4" />
        </button>

        <!-- More Menu Toggle -->
        <button 
          @mousedown.stop="isMenuOpen = !isMenuOpen"
          class="p-1.5 hover:text-blue-600 dark:hover:text-white text-gray-400 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Development Tools"
          data-testid="debug-menu-button"
          :class="{ 'text-blue-600 dark:text-white bg-gray-100 dark:bg-gray-700': isMenuOpen }"
        >
          <MoreVertical class="w-4 h-4" />
        </button>

        <!-- Dropdown Menu -->
        <div 
          v-if="isMenuOpen"
          @click.stop
          class="absolute right-0 bottom-full mb-2 w-48 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden py-1 z-[60]"
          data-testid="debug-menu-dropdown"
        >
          <button 
            @click.stop="triggerTestInfo"
            class="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            data-testid="trigger-test-info"
          >
            <Info class="w-3.5 h-3.5" />
            <span>Trigger Test Info</span>
          </button>
          <button 
            @click.stop="triggerTestError"
            class="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            data-testid="trigger-test-error"
          >
            <Skull class="w-3.5 h-3.5" />
            <span>Trigger Test Error</span>
          </button>
          <div class="h-px bg-gray-100 dark:bg-gray-700 my-1"></div>
          <button 
            @click.stop="openOPFS"
            class="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            data-testid="open-opfs-explorer"
          >
            <HardDrive class="w-3.5 h-3.5" />
            <span>Explore OPFS</span>
          </button>
        </div>

        <button 
          @click="toggleDebug"
          class="p-1.5 hover:text-gray-600 dark:hover:text-white text-gray-400 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 ml-1"
          title="Close Panel"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Content Area -->
    <div class="h-[calc(100%-40px)] overflow-y-auto bg-gray-50/30 dark:bg-black/40 font-mono p-3 space-y-1.5" data-testid="debug-content-area">
      <div v-if="eventCount === 0" class="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
        <X class="w-8 h-8 opacity-20" />
        <p class="text-xs font-bold uppercase tracking-widest">No events recorded</p>
      </div>
      
      <div 
        v-for="event in events" 
        :key="event.id"
        class="border-l-2 p-2 rounded-r-xl flex gap-3 group transition-colors shadow-sm"
        :class="getEventStyle(event.type)"
        data-testid="event-item"
      >
        <span class="text-[10px] font-bold opacity-40 shrink-0">[{{ formatTime(event.timestamp) }}]</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <component :is="getEventIcon(event.type)" class="w-3 h-3" />
            <span class="text-[10px] font-bold bg-white/20 dark:bg-white/5 px-1.5 py-0.5 rounded-lg border border-white/20 tracking-tighter">{{ event.source }}</span>
            <span class="text-xs font-bold truncate opacity-90">{{ event.message }}</span>
          </div>
          <pre v-if="event.details" class="bg-black/5 dark:bg-black/50 p-3 rounded-xl text-[10px] text-gray-500 dark:text-gray-400 overflow-x-auto border border-gray-100/50 dark:border-gray-800">{{ stringifyDetails(event.details as any) }}</pre>
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
