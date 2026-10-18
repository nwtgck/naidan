<script setup lang="ts">
import { twClasses, twClassString } from 'virtual:naidan-tailwind';
import { ensureStrings, lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import { ref } from 'vue';
import LlamaCppMemoryPanel from '@/features/llama-cpp-browser/components/LlamaCppMemoryPanel.vue';
import { useGlobalEvents, type GlobalEvent } from '@/composables/useGlobalEvents';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { useLayout } from '@/composables/useLayout';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import {
  TerminalIcon, Trash2Icon, AlertCircleIcon, XIcon, SkullIcon,
  InfoIcon, AlertTriangleIcon, BugIcon, MoreVerticalIcon, HardDriveIcon,
} from 'lucide-vue-next';

const { events, eventCount, errorCount, clearEvents, addErrorEvent, addInfoEvent } = useGlobalEvents();
const { openFileExplorer } = useFileExplorerModal();
const { isDebugOpen, toggleDebug } = useLayout();
const isMenuOpen = ref(false);
const selectedTab = ref<'events' | 'llama'>('events');

function navigateTabs({ event }: { event: KeyboardEvent }): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return;
  }
  event.preventDefault();
  if (event.key === 'Home') {
    selectedTab.value = 'events';
  } else if (event.key === 'End') {
    selectedTab.value = 'llama';
  } else {
    switch (selectedTab.value) {
    case 'events': selectedTab.value = 'llama';
      break;
    case 'llama': selectedTab.value = 'events';
      break;
    default: {
      const exhaustive: never = selectedTab.value;
      throw new Error(String(exhaustive));
    }
    }
  }
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    target.querySelector<HTMLButtonElement>(`[data-tab="${selectedTab.value}"]`)?.focus();
  }
}

const menuRef = ref<HTMLElement | null>(null);

async function triggerTestError(): Promise<void> {
  isMenuOpen.value = false;
  addErrorEvent({
    source: 'DevTools',
    message: await ensureStrings.DebugPanel__intentional_test_error_triggered_by_user(),
    details: {
      hint: await ensureStrings.DebugPanel__this_is_used_to_verify_the_error_event_system_ui(),
      browser: navigator.userAgent,
    },
  });
}

async function triggerTestInfo(): Promise<void> {
  isMenuOpen.value = false;
  addInfoEvent({
    source: 'DevTools',
    message: await ensureStrings.DebugPanel__application_state_synchronized(),
    details: {
      status: 'success',
      timestamp: new Date().toISOString(),
    },
  });
}

function formatTime({ timestamp }: { timestamp: number }) {
  return new Date(timestamp).toLocaleTimeString();
}

function stringifyDetails({ details }: { details: unknown }): string {
  if (details === undefined || details === null) {
    return '';
  }
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

function getEventStyle({ type }: { type: GlobalEvent['type'] }) {
  switch (type) {
  case 'error': return twClassString('border-red-400/60', 'bg-red-500/5', 'text-red-700', 'dark:text-red-300');
  case 'warn':  return twClassString('border-yellow-500/60', 'bg-yellow-500/5', 'text-yellow-700', 'dark:text-yellow-300');
  case 'info':  return twClassString('border-blue-500/40', 'bg-gray-50', 'dark:bg-gray-800/40', 'text-gray-700', 'dark:text-gray-200');
  default:      return twClassString('border-gray-300', 'dark:border-gray-600', 'bg-gray-50', 'dark:bg-gray-800/40', 'text-gray-600', 'dark:text-gray-300');
  }
}

function getEventIcon({ type }: { type: GlobalEvent['type'] }) {
  switch (type) {
  case 'error': return AlertCircleIcon;
  case 'warn':  return AlertTriangleIcon;
  case 'info':  return InfoIcon;
  default:      return BugIcon;
  }
}

// Click away listener for the menu
function handleClickOutside({ event }: { event: MouseEvent }) {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
    isMenuOpen.value = false;
  }
}

function openOPFSRootExplorer() {
  openFileExplorer({ options: { kind: 'opfs-root' } });
  isMenuOpen.value = false;
}

useEventTargetListener(document, 'mousedown', (event) => handleClickOutside({ event }));


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    v-if="isDebugOpen"
    tw-class="shrink-0 flex flex-col border-t border-gray-200 dark:border-gray-700/70 bg-white dark:bg-gray-900 relative h-72 overflow-visible z-50"
    data-testid="debug-panel"
  >
    <!-- Toolbar -->
    <div
      tw-class="shrink-0 flex items-center justify-between gap-3 px-3 py-1.5 min-h-10 border-b border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900 sticky top-0 z-10"
    >
      <div tw-class="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 min-w-0">
        <div tw-class="flex items-center gap-2 min-w-0 max-w-full">
            <TerminalIcon tw-class="w-4 h-4 shrink-0 text-blue-500/60" />
            <div role="tablist" @keydown="navigateTabs({ event: $event })" tw-class="flex items-center gap-0.5 min-w-0 overflow-x-auto rounded-lg bg-gray-100 dark:bg-gray-800/60 p-0.5">
              <button id="debug-events-tab" role="tab" data-tab="events" data-testid="debug-events-tab" :aria-selected="selectedTab === 'events'" :tabindex="selectedTab === 'events' ? 0 : -1" aria-controls="debug-events-content" @click="selectedTab = 'events'" :tw-class="['text-xs font-medium leading-4 whitespace-nowrap px-2.5 py-1 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40', selectedTab === 'events' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-600/60' : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-white/60 dark:hover:bg-gray-700/40']">{{ lazyStrings.DebugPanel__system_events() }}</button>
              <button id="debug-llama-tab" role="tab" data-tab="llama" data-testid="debug-llama-tab" :aria-selected="selectedTab === 'llama'" :tabindex="selectedTab === 'llama' ? 0 : -1" aria-controls="debug-llama-content" @click="selectedTab = 'llama'" :tw-class="['text-xs font-medium leading-4 whitespace-nowrap px-2.5 py-1 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40', selectedTab === 'llama' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-600/60' : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-white/60 dark:hover:bg-gray-700/40']">{{ lazyStrings.LlamaCppMemoryPanel__llama_cpp_browser() }}</button>
            </div>
        </div>

        <div
          v-if="errorCount > 0"
          tw-class="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-red-50 dark:bg-red-400/10 border border-red-200/70 dark:border-red-400/20 text-[11px] font-medium text-red-700 dark:text-red-300 tabular-nums"
          data-testid="debug-error-badge"
        >
          <AlertCircleIcon tw-class="w-3 h-3" />
          {{ lazyStrings.DebugPanel__error_count({ count: errorCount }) }}
        </div>

        <span
          tw-class="text-[11px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800/70 border border-gray-200/70 dark:border-gray-700/60 px-1.5 py-0.5 rounded-md tabular-nums whitespace-nowrap"
          data-testid="debug-total-badge"
        >
          {{ lazyStrings.DebugPanel__total_count({ count: eventCount }) }}
        </span>
      </div>

      <div tw-class="shrink-0 flex items-center gap-0.5 relative" ref="menuRef">
        <button
          v-if="eventCount > 0"
          @click.stop="clearEvents"
          tw-class="w-7 h-7 flex items-center justify-center hover:text-red-600 dark:hover:text-red-400 text-gray-400 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
          :title="lazyStrings.DebugPanel__clear_logs()"
          data-testid="debug-clear-button"
        >
          <Trash2Icon tw-class="w-4 h-4" />
        </button>

        <!-- More Menu Toggle -->
        <button
          @mousedown.stop="isMenuOpen = !isMenuOpen"
          :title="lazyStrings.DebugPanel__development_tools()"
          data-testid="debug-menu-button"
          :tw-class="['w-7 h-7 flex items-center justify-center text-gray-400 transition-colors rounded-lg hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40', { 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800': isMenuOpen }]"
        >
          <MoreVerticalIcon tw-class="w-4 h-4" />
        </button>

        <!-- Dropdown Menu -->
        <div
          v-if="isMenuOpen"
          @click.stop
          tw-class="absolute right-0 bottom-full mb-2 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700/80 rounded-xl shadow-lg shadow-black/15 overflow-hidden p-1.5 z-[60]"
          data-testid="debug-menu-dropdown"
        >
          <button
            @click.stop="triggerTestInfo"
            tw-class="w-full min-h-8 flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700/60"
            data-testid="trigger-test-info"
          >
            <InfoIcon tw-class="w-3.5 h-3.5 shrink-0 text-blue-500/60" />
            <span>{{ lazyStrings.DebugPanel__trigger_test_info() }}</span>
          </button>
          <button
            @click.stop="triggerTestError"
            tw-class="w-full min-h-8 flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700/60"
            data-testid="trigger-test-error"
          >
            <SkullIcon tw-class="w-3.5 h-3.5 shrink-0 text-red-500/70 dark:text-red-400/80" />
            <span>{{ lazyStrings.DebugPanel__trigger_test_error() }}</span>
          </button>
          <div tw-class="h-px bg-gray-200/80 dark:bg-gray-700/60 my-1 mx-1"></div>
          <button
            @click.stop="openOPFSRootExplorer"
            tw-class="w-full min-h-8 flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700/60"
            data-testid="open-opfs-explorer"
          >
            <HardDriveIcon tw-class="w-3.5 h-3.5 shrink-0 text-gray-400" />
            <span>{{ lazyStrings.DebugPanel__explore_opfs() }}</span>
          </button>
        </div>

        <button
          @click="toggleDebug"
          tw-class="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ml-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
          :title="lazyStrings.DebugPanel__close_panel()"
        >
          <XIcon tw-class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Content Area -->
    <div v-show="selectedTab === 'events'" id="debug-events-content" role="tabpanel" tabindex="0" aria-labelledby="debug-events-tab" tw-class="min-h-0 flex-1 overflow-y-auto bg-gray-50/30 dark:bg-gray-900 p-3 space-y-2" data-testid="debug-content-area">
      <div v-if="eventCount === 0" tw-class="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 gap-3">
        <div tw-class="p-2.5 rounded-xl bg-gray-100 dark:bg-gray-800/70">
          <TerminalIcon tw-class="w-5 h-5 text-gray-400 dark:text-gray-500" />
        </div>
        <p tw-class="text-xs leading-5">{{ lazyStrings.DebugPanel__no_events_recorded() }}</p>
      </div>

      <div
        v-for="event in events"
        :key="idToRaw({ id: event.id })"
        :tw-class="['border-l-2 px-3 py-2.5 rounded-r-lg flex flex-wrap gap-x-3 gap-y-1.5 group transition-colors', twClasses(getEventStyle({ type: event.type }))]"
        data-testid="event-item"
      >
        <span tw-class="text-[11px] font-mono text-gray-500 dark:text-gray-400 shrink-0 tabular-nums">[{{ formatTime({ timestamp: event.timestamp }) }}]</span>
        <div tw-class="flex-1 min-w-0">
          <div tw-class="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
            <component :is="getEventIcon({ type: event.type })" tw-class="w-3.5 h-3.5 shrink-0" />
            <span tw-class="text-[11px] font-mono text-gray-500 dark:text-gray-400 bg-white/60 dark:bg-gray-900/50 px-1.5 py-0.5 rounded-md">{{ event.source }}</span>
            <span tw-class="text-xs leading-5 break-words min-w-0">{{ event.message }}</span>
          </div>
          <pre v-if="event.details" tw-class="mt-2 bg-white/70 dark:bg-gray-900/70 p-2.5 rounded-lg text-[11px] leading-5 text-gray-600 dark:text-gray-400 overflow-x-auto border border-gray-200/70 dark:border-gray-700/50">{{ stringifyDetails({ details: event.details as any }) }}</pre>
        </div>
      </div>
    </div>
    <div v-show="selectedTab === 'llama'" id="debug-llama-content" role="tabpanel" tabindex="0" aria-labelledby="debug-llama-tab" tw-class="min-h-0 flex-1 overflow-y-auto bg-gray-50/30 dark:bg-gray-900 p-3">
      <LlamaCppMemoryPanel />
    </div>
  </div>
</template>

<style scoped>
pre {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
