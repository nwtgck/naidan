<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  XIcon, GitForkIcon, RefreshCwIcon,
  ArrowUpIcon, Settings2Icon, DownloadIcon, MoreVerticalIcon, BugIcon,
  FolderIcon, FolderInputIcon, ChevronRightIcon, HammerIcon, SearchIcon, ImageIcon,
  PrinterIcon, LinkIcon, TerminalIcon, ListIcon
} from 'lucide-vue-next';
import type { MediaShelfVisibility } from '@/composables/useLayout';

type HeaderChat = {
  readonly id: string;
  readonly title: string | null;
  readonly groupId?: string | null;
  readonly originChatId?: string;
  readonly debugEnabled: boolean;
};

type HeaderChatGroup = {
  readonly id: string;
  readonly name: string;
};

defineProps<{
  currentChat: HeaderChat | null;
  chatGroups: readonly HeaderChatGroup[];
  currentChatGroupBadge: HeaderChatGroup | undefined;
  activeMessageCount: number;
  modelLabel: string;
  hasOverrides: boolean;
  showChatSettings: boolean;
  outlineVisibility: 'hidden' | 'visible';
  generatingTitle: boolean;
  isCurrentChatStreaming: boolean;
  mediaShelfVisibility: MediaShelfVisibility;
  isChatWeshTerminalOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'jump-origin'): void;
  (e: 'title-action'): void;
  (e: 'update:show-chat-settings', value: boolean): void;
  (e: 'fork-last-message'): void;
  (e: 'move-to-group', groupId: string | null): void;
  (e: 'toggle-outline'): void;
  (e: 'print'): void;
  (e: 'search-chat'): void;
  (e: 'open-history'): void;
  (e: 'export-chat'): void;
  (e: 'toggle-media-shelf'): void;
  (e: 'share-url'): void;
  (e: 'toggle-wesh-terminal'): void;
  (e: 'toggle-debug'): void;
}>();

const showMoreMenu = ref(false);
const showMoveMenu = ref(false);
const ignoreTitleHover = ref(false);
const actionsMenuRoot = ref<HTMLElement | null>(null);

function closeFloatingMenus(_args: Record<string, never>) {
  showMoreMenu.value = false;
  showMoveMenu.value = false;
}

function handleDocumentPointerDown({ event }: { event: PointerEvent }) {
  if (!showMoreMenu.value && !showMoveMenu.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (actionsMenuRoot.value?.contains(target)) return;
  closeFloatingMenus({});
}

function handleDocumentPointerDownEvent(event: PointerEvent) {
  handleDocumentPointerDown({ event });
}

function emitMoveToGroup({ groupId }: { groupId: string | null }) {
  emit('move-to-group', groupId);
  showMoveMenu.value = false;
}

function emitMoreAction({ action }: {
  action:
    | 'print'
    | 'search-chat'
    | 'open-history'
    | 'export-chat'
    | 'toggle-media-shelf'
    | 'share-url'
    | 'toggle-wesh-terminal'
    | 'toggle-debug'
}) {
  switch (action) {
  case 'print':
    emit('print');
    break;
  case 'search-chat':
    emit('search-chat');
    break;
  case 'open-history':
    emit('open-history');
    break;
  case 'export-chat':
    emit('export-chat');
    break;
  case 'toggle-media-shelf':
    emit('toggle-media-shelf');
    break;
  case 'share-url':
    emit('share-url');
    break;
  case 'toggle-wesh-terminal':
    emit('toggle-wesh-terminal');
    break;
  case 'toggle-debug':
    emit('toggle-debug');
    break;
  default: {
    const _ex: never = action;
    throw new Error(`Unhandled header action: ${_ex}`);
  }
  }
  showMoreMenu.value = false;
}

function emitTitleAction() {
  ignoreTitleHover.value = true;
  emit('title-action');
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDownEvent);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDownEvent);
});


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-1.5 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
    <div class="flex items-center gap-3 overflow-hidden min-h-[34px]">
      <div class="flex flex-col overflow-hidden">
        <template v-if="currentChat">
          <div class="flex items-center gap-2">
            <button
              v-if="currentChat.originChatId"
              @click="emit('jump-origin')"
              class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600 transition-colors"
              title="Jump to original chat"
              data-testid="jump-to-origin-button"
            >
              <ArrowUpIcon class="w-4 h-4" />
            </button>
            <h2 class="text-xs sm:text-sm font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">{{ currentChat.title || 'New Chat' }}</h2>
            <button
              v-if="activeMessageCount > 0"
              @click="emitTitleAction"
              @mouseleave="ignoreTitleHover = false"
              class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600 transition-all disabled:opacity-50 group/title"
              :disabled="isCurrentChatStreaming"
              :title="generatingTitle ? 'Stop Title Generation' : 'Regenerate Title'"
              data-testid="regenerate-title-button"
            >
              <div class="relative w-3.5 h-3.5 flex items-center justify-center">
                <RefreshCwIcon
                  class="w-full h-full transition-all"
                  :class="{
                    'animate-spin': generatingTitle,
                    'group-hover/title:opacity-0 group-hover/title:scale-75': generatingTitle && !ignoreTitleHover
                  }"
                />
                <XIcon
                  v-if="generatingTitle"
                  class="w-3.5 h-3.5 absolute opacity-0 transition-all text-red-500 scale-75"
                  :class="{ 'group-hover/title:opacity-100 group-hover/title:scale-100': !ignoreTitleHover }"
                />
              </div>
            </button>
          </div>

          <div class="flex items-center gap-1.5 min-w-0">
            <div
              v-if="currentChatGroupBadge"
              class="min-w-0 max-w-[120px] sm:max-w-[180px] px-1.5 py-0.5 rounded-md text-[9px] font-bold transition-colors flex items-center text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/70 border border-gray-100 dark:border-gray-800"
              :title="`Group: ${currentChatGroupBadge.name}`"
              data-testid="chat-group-badge"
            >
              <span class="truncate">{{ currentChatGroupBadge.name }}</span>
            </div>

            <button
              @click="emit('update:show-chat-settings', !showChatSettings)"
              class="flex items-center gap-1.5 min-w-0 w-fit group"
              title="Chat Settings & Model Override"
              data-testid="model-trigger"
            >
              <div
                class="px-2 py-0.5 rounded-full text-[9px] font-bold transition-all flex items-center gap-1.5 min-w-0"
                :class="showChatSettings
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 group-hover:bg-gray-200 dark:group-hover:bg-gray-700 group-hover:text-gray-700 dark:group-hover:text-gray-200'"
              >
                <span class="truncate max-w-[120px] sm:max-w-[200px]">
                  {{ modelLabel }}
                </span>
                <Settings2Icon class="w-3 h-3 shrink-0" :class="{ 'animate-pulse': showChatSettings }" />
              </div>
              <div
                v-if="hasOverrides"
                class="w-1 h-1 rounded-full bg-blue-500 animate-pulse shrink-0"
                title="Custom overrides active"
                data-testid="custom-overrides-indicator"
              ></div>
            </button>
          </div>
        </template>
      </div>
    </div>

    <div ref="actionsMenuRoot" class="flex items-center gap-0.5 relative">
      <div v-if="currentChat" class="flex items-center gap-0.5">
        <button
          v-if="activeMessageCount > 0"
          @click="emit('fork-last-message')"
          class="p-1.5 rounded-lg transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          title="Fork Chat from last message"
          data-testid="fork-chat-button"
        >
          <GitForkIcon class="w-4.5 h-4.5" />
        </button>

        <div class="relative">
          <button
            @click="showMoveMenu = !showMoveMenu"
            class="p-1.5 rounded-lg transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
            :class="showMoveMenu ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'"
            title="Move to Group"
            data-testid="move-to-group-button"
          >
            <FolderInputIcon class="w-4.5 h-4.5" />
          </button>

          <Transition name="dropdown">
            <div
              v-if="showMoveMenu"
              class="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden origin-top-right"
            >
              <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
                Move to Group
              </div>
              <div class="max-h-64 overflow-y-auto">
                <button
                  @click="emitMoveToGroup({ groupId: null })"
                  class="w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors"
                  :class="!currentChat.groupId ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
                >
                  <div class="flex items-center gap-2">
                    <XIcon class="w-4 h-4 opacity-50" />
                    <span>Top Level</span>
                  </div>
                  <ChevronRightIcon v-if="!currentChat.groupId" class="w-4 h-4" />
                </button>

                <button
                  v-for="group in chatGroups"
                  :key="group.id"
                  @click="emitMoveToGroup({ groupId: group.id })"
                  class="w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors"
                  :class="currentChat.groupId === group.id ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
                >
                  <div class="flex items-center gap-2 overflow-hidden">
                    <FolderIcon class="w-4 h-4 opacity-50 shrink-0" />
                    <span class="truncate">{{ group.name }}</span>
                  </div>
                  <ChevronRightIcon v-if="currentChat.groupId === group.id" class="w-4 h-4" />
                </button>
              </div>
            </div>
          </Transition>
        </div>

        <button
          v-if="activeMessageCount > 0"
          @click="emit('toggle-outline')"
          class="p-1.5 rounded-lg transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
          :class="outlineVisibility === 'visible' ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'"
          title="Conversation Outline"
          data-testid="conversation-outline-button"
        >
          <ListIcon class="w-4.5 h-4.5" />
        </button>

        <button
          @click="showMoreMenu = !showMoreMenu"
          class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          title="More Actions"
          data-testid="more-actions-button"
        >
          <MoreVerticalIcon class="w-4.5 h-4.5" />
        </button>
      </div>

      <Transition name="dropdown">
        <div
          v-if="showMoreMenu"
          class="absolute right-0 top-full mt-2 w-56 bg-white/95 dark:bg-gray-800/95 backdrop-blur-md border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 origin-top-right"
        >
          <button
            @click="emitMoreAction({ action: 'print' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-green-600 dark:hover:text-green-400"
            title="Open print dialog (can be used to Save as PDF)"
            data-testid="print-chat-button"
          >
            <PrinterIcon class="w-4 h-4" />
            <span>Print</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'search-chat' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-indigo-600 dark:hover:text-indigo-400"
            data-testid="search-in-chat-button"
          >
            <SearchIcon class="w-4 h-4" />
            <span>Search in Chat</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'open-history' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-orange-500 dark:hover:text-orange-400"
            title="Super Edit (Full History Manipulation)"
            data-testid="super-edit-button"
          >
            <HammerIcon class="w-4 h-4" />
            <span>Super Edit</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'export-chat' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
            title="Export as Markdown"
            data-testid="export-markdown-button"
          >
            <DownloadIcon class="w-4 h-4" />
            <span>Export Markdown</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'toggle-media-shelf' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
            :class="mediaShelfVisibility === 'visible'
              ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
            "
            data-testid="toggle-media-gallery-button"
          >
            <ImageIcon class="w-4 h-4" />
            <span>Media Gallery</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'share-url' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
            title="Copy a shareable URL containing this chat"
            data-testid="export-url-button"
          >
            <LinkIcon class="w-4 h-4" />
            <span>Export as URL</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'toggle-wesh-terminal' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
            :class="isChatWeshTerminalOpen
              ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
            "
            data-testid="open-chat-wesh-terminal-button"
          >
            <TerminalIcon class="w-4 h-4" />
            <span>Wesh Terminal</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'toggle-debug' })"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
            :class="currentChat?.debugEnabled
              ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
            "
            data-testid="toggle-debug-button"
          >
            <BugIcon class="w-4 h-4" />
            <span>Debug Mode</span>
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>
