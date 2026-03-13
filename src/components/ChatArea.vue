<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '@/composables/useChat';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// IMPORTANT: MessageItem is the core of the chat experience. We import it synchronously
// to ensure the chat history displays immediately and smoothly without individual components popping in.
import MessageItem from './MessageItem.vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import MessageThinking from './MessageThinking.vue';
import AssistantWaitingIndicator from './AssistantWaitingIndicator.vue';
import AssistantProcessSequence from './AssistantProcessSequence.vue';
// IMPORTANT: WelcomeScreen is the first thing users see in a new chat. We import it synchronously for an instant landing.
import WelcomeScreen from './WelcomeScreen.vue';
import ChatInput from './ChatInput.vue';
import TransformersJsLoadingIndicator from './TransformersJsLoadingIndicator.vue';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';

// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const BinaryObjectPreviewModal = defineAsyncComponentAndLoadOnMounted(() => import('./BinaryObjectPreviewModal.vue'));
import { useImagePreview } from '@/composables/useImagePreview';
import { useBinaryActions } from '@/composables/useBinaryActions';
import type { LmParameters } from '@/models/types';

// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatSettingsPanel = defineAsyncComponentAndLoadOnMounted(() => import('./ChatSettingsPanel.vue'));
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const HistoryManipulationModal = defineAsyncComponentAndLoadOnMounted(() => import('./HistoryManipulationModal.vue'));
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatDebugInspector = defineAsyncComponentAndLoadOnMounted(() => import('./ChatDebugInspector.vue'));
// Lazily load the media shelf, prefetch on mounted.
const ChatMediaShelf = defineAsyncComponentAndLoadOnMounted(() => import('./ChatMediaShelf.vue'));
import {
  Paperclip, X, GitFork, RefreshCw,
  ArrowUp, Settings2, Download, MoreVertical, Bug,
  Folder, FolderInput, ChevronRight, Hammer, Search, Image as ImageIcon, Zap,
  Printer, Link
} from 'lucide-vue-next';
import { usePrint } from '@/composables/usePrint';
import { useGlobalSearch } from '@/composables/useGlobalSearch';
import { hasChatOverrides } from '@/utils/chat-settings-resolver';
import { scrollIntoViewSafe } from '@/utils/dom';
import { generateChatShareURL } from '@/services/import-export/chat-url-share';
import { useToast } from '@/composables/useToast';
import { storageService } from '@/services/storage';


const chatStore = useChat();
const { settings, toggleMarkdownRendering } = useSettings();
const { addToast } = useToast();
const { state: previewState, closePreview } = useImagePreview(true);
const { deleteBinaryObject, downloadBinaryObject } = useBinaryActions();
const {
  mediaShelfVisibility,
  setMediaShelfVisibility,
  toggleMediaShelf
} = useLayout();
const {
  currentChat,
  generatingTitle,
  activeMessages,
  allMessages,
  availableModels,
  resolvedSettings,
  isProcessing,
  getSortedImageModels,
  abortTitleGeneration,
  chatFlow,
  isThinkingActive,
  isWaitingResponse,
} = chatStore;

const availableImageModels = computed(() => {
  return getSortedImageModels({ availableModels: availableModels.value });
});

const { setActiveFocusArea } = useLayout();
type ChatInputVisibility = 'submerged' | 'peeking' | 'active';
const inputVisibility = ref<ChatInputVisibility>('active');
const isAnimatingHeight = ref(false);
const isDragging = ref(false);
const ignoreTitleHover = ref(false);

function handleTitleAction() {
  if (!currentChat.value) return;
  if (generatingTitle.value) {
    abortTitleGeneration({ chatId: currentChat.value.id });
  } else {
    ignoreTitleHover.value = true;
    chatStore.generateChatTitle({ chatId: currentChat.value.id, signal: undefined });
  }
}

function handleDragOver(event: DragEvent) {
  event.preventDefault();
  isDragging.value = true;
}

function handleDragLeave(event: DragEvent) {
  // Only set to false if we are leaving the main container
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (
    event.clientX <= rect.left ||
    event.clientX >= rect.right ||
    event.clientY <= rect.top ||
    event.clientY >= rect.bottom
  ) {
    isDragging.value = false;
  }
}

async function handleDrop(event: DragEvent) {
  event.preventDefault();
  isDragging.value = false;

  if (event.dataTransfer?.files) {
    await chatInputRef.value?.processFiles(Array.from(event.dataTransfer.files));
  }
}

const container = ref<HTMLElement | null>(null);

useSettings();
const router = useRouter();

const props = defineProps<{
  autoSendPrompt?: string
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void
}>();

const isCurrentChatStreaming = computed(() => {
  return currentChat.value ? isProcessing(currentChat.value.id) : false;
});

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null);

const showChatSettings = ref(false);
const showHistoryModal = ref(false);
const showMoreMenu = ref(false);
const showMoveMenu = ref(false);

async function handleMoveToGroup(groupId: string | null) {
  if (!currentChat.value) return;
  await chatStore.moveChatToGroup(currentChat.value.id, groupId);
  showMoveMenu.value = false;
}

async function exportChat() {
  if (!currentChat.value || !chatFlow.value) return;

  let markdownContent = `# ${currentChat.value.title || 'New Chat'}\n\n`;

  const processFlowItems = async (items: ChatFlowItem[]) => {
    for (const item of items) {
      const itemType = item.type;
      switch (itemType) {
      case 'message': {
        const msg = item.node;
        const role = (() => {
          const r = msg.role;
          switch (r) {
          case 'user': return 'User';
          case 'assistant': return 'AI';
          case 'system': return 'System';
          case 'tool': return 'Tool';
          default: {
            const _ex: never = r;
            return (_ex as string);
          }
          }
        })();
        const prefix = (() => {
          const mode = item.mode;
          switch (mode) {
          case 'thinking': return '[Thought]: ';
          case 'content':
          case 'tool_calls':
          case 'waiting':
            return '';
          default: {
            const _ex: never = mode;
            return _ex;
          }
          }
        })();
        markdownContent += `## ${role}:\n${prefix}${item.partContent || msg.content}\n\n`;
        break;
      }
      case 'tool_group': {
        markdownContent += `## Tool Executions:\n`;
        for (const tc of item.toolCalls) {
          let resultStr = '';
          const status = tc.result.status;
          switch (status) {
          case 'success': {
            const contentType = tc.result.content.type;
            switch (contentType) {
            case 'text':
              resultStr = tc.result.content.text;
              break;
            case 'binary_object': {
              const blob = await storageService.getFile(tc.result.content.id);
              resultStr = blob ? await blob.text() : '[Error: Binary object missing]';
              break;
            }
            default: {
              const _ex: never = contentType;
              resultStr = `[Unknown content type: ${_ex}]`;
            }
            }
            break;
          }
          case 'error': {
            const messageType = tc.result.error.message.type;
            switch (messageType) {
            case 'text':
              resultStr = tc.result.error.message.text;
              break;
            case 'binary_object': {
              const blob = await storageService.getFile(tc.result.error.message.id);
              const detail = blob ? await blob.text() : 'Binary error detail missing';
              resultStr = `Error [${tc.result.error.code}]: ${detail}`;
              break;
            }
            default: {
              const _ex: never = messageType;
              resultStr = `[Unknown error message type: ${_ex}]`;
            }
            }
            break;
          }
          case 'executing':
            resultStr = '[Tool Still Executing]';
            break;
          default: {
            const _ex: never = status;
            resultStr = `[Unknown status: ${_ex}]`;
          }
          }
          markdownContent += `### ${tc.call.function.name}\nArgs: ${tc.call.function.arguments}\nResult: ${resultStr}\n\n`;
        }
        break;
      }
      case 'process_sequence':
        markdownContent += `## Process Sequence: ${item.summary}\n`;
        await processFlowItems(item.items);
        break;
      default: {
        const _ex: never = itemType;
        console.warn(`Unhandled ChatFlowItem type: ${_ex}`);
      }
      }
    }
  };

  await processFlowItems(chatFlow.value);

  const blob = new Blob([markdownContent], { type: 'text/plain;charset=utf-8' });
  const filename = `${currentChat.value.title || 'new_chat'}.txt`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

async function shareAsURL() {
  if (!currentChat.value) return;

  try {
    const url = await generateChatShareURL({ chatId: currentChat.value.id });
    await navigator.clipboard.writeText(url);
    addToast({
      message: 'Share URL copied to clipboard!',
      duration: 3000
    });
  } catch (err) {
    addToast({
      message: `Failed to generate share URL: ${err instanceof Error ? err.message : String(err)}`,
      duration: 5000
    });
  }
}

function handlePrint() {
  if (currentChat.value) {
    usePrint().print({
      title: currentChat.value.title || 'Chat',
      mode: 'chat'
    });
  }
}

function scrollToBottom(force = true) {
  if (container.value) {
    const { scrollTop, scrollHeight, clientHeight } = container.value;
    // Only auto-scroll if forced (new message) or already near the bottom
    if (force || scrollHeight - scrollTop - clientHeight < 150) {
      container.value.scrollTop = scrollHeight;
    }
  }
}

function jumpToMessage({ messageId }: { messageId: string }) {
  if (!container.value) return;
  const el = container.value.querySelector(`#message-${messageId}`);
  if (el instanceof HTMLElement) {
    scrollIntoViewSafe({
      container: container.value,
      element: el,
      behavior: 'smooth',
      block: 'center'
    });
    el.classList.add('bg-blue-50/50', 'dark:bg-blue-900/20');
    setTimeout(() => {
      el.classList.remove('bg-blue-50/50', 'dark:bg-blue-900/20');
    }, 2000);
  }
}

// Expose for testing
defineExpose({ scrollToBottom, container,
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});

const canGenerateImage = computed(() => {
  const type = resolvedSettings.value?.endpointType;
  if (!type) return false;

  const isOllama = (() => {
    switch (type) {
    case 'ollama':
      return true;
    case 'openai':
    case 'transformers_js':
      return false;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled endpoint type: ${_ex}`);
    }
    }
  })();

  if (!isOllama) return false;
  return availableImageModels.value.length > 0;
});
const hasImageModel = computed(() => availableImageModels.value.length > 0);

async function handleEdit(messageId: string, newContent: string, lmParameters?: LmParameters) {
  await chatStore.editMessage(messageId, newContent, lmParameters);
}

async function handleRegenerate(messageId: string) {
  await chatStore.regenerateMessage(messageId);
}

function handleSwitchVersion(messageId: string) {
  chatStore.switchVersion(messageId);
}

async function handleFork(messageId: string) {
  const newId = await chatStore.forkChat(messageId);
  if (newId) {
    router.push(`/chat/${newId}`);
  }
}

function handleForkLastMessage() {
  // We need to find the last message across all potential levels of nesting in chatFlow
  const findLastMessage = (items: ChatFlowItem[]): ChatFlowItem | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const type = item.type;
      switch (type) {
      case 'message': return item;
      case 'process_sequence': {
        const nested = findLastMessage(item.items);
        if (nested) return nested;
        break;
      }
      case 'tool_group':
        break;
      default: {
        const _ex: never = type;
        return _ex;
      }
      }
    }
    return null;
  };

  const lastMsgItem = findLastMessage(chatFlow.value);
  if (lastMsgItem && lastMsgItem.type === 'message') {
    handleFork(lastMsgItem.node.id);
  }
}

function jumpToOrigin() {
  if (currentChat.value?.originChatId) {
    router.push(`/chat/${currentChat.value.originChatId}`);
  }
}

async function scrollToLatestUserMessage() {
  if (!container.value || !chatFlow.value) return;

  // Find last user message
  const findLastUserMessage = (items: ChatFlowItem[]): ChatFlowItem | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const type = item.type;
      switch (type) {
      case 'message': {
        const role = item.node.role;
        switch (role) {
        case 'user': return item;
        case 'assistant':
        case 'system':
        case 'tool':
          break;
        default: {
          const _ex: never = role;
          return _ex;
        }
        }
        break;
      }
      case 'process_sequence': {
        const nested = findLastUserMessage(item.items);
        if (nested) return nested;
        break;
      }
      case 'tool_group':
        break;
      default: {
        const _ex: never = type;
        return _ex;
      }
      }
    }
    return null;
  };

  const lastUserMsgItem = findLastUserMessage(chatFlow.value);

  if (lastUserMsgItem && lastUserMsgItem.type === 'message') {
    const messageId = lastUserMsgItem.node.id;
    // Robustly find the element, waiting up to 5 ticks for DOM to settle
    let el: HTMLElement | null = null;
    for (let i = 0; i < 5; i++) {
      await nextTick();
      el = container.value.querySelector(`#message-${messageId}`) as HTMLElement | null;
      if (el) break;
    }

    if (el instanceof HTMLElement) {
      scrollIntoViewSafe({
        container: container.value,
        element: el,
        behavior: 'instant',
        block: 'start',
        offset: 50
      });
    } else {
      scrollToBottom();
    }
  } else {
    scrollToBottom();
  }
}

const isInitialLoad = ref(true);

watch(
  () => currentChat.value?.id,
  () => {
    isInitialLoad.value = true;
  }
);

watch(
  [() => chatFlow.value.length, () => currentChat.value?.id],
  async ([_newLen, newId], [_oldLen, oldId]) => {
    if (newId !== oldId) {
      isInitialLoad.value = true;
    }

    await nextTick();

    if (isInitialLoad.value) {
      await scrollToLatestUserMessage();
      isInitialLoad.value = false;
      return;
    }

    const lastItem = chatFlow.value[chatFlow.value.length - 1];
    if (!lastItem) return;

    const itemType = lastItem.type;
    switch (itemType) {
    case 'message': {
      const role = lastItem.node.role;
      switch (role) {
      case 'user':
        scrollToBottom();
        break;
      case 'assistant':
      case 'system':
      case 'tool': {
        if (container.value) {
          const messageId = lastItem.node.id;
          // Wait a tick for the new element
          await nextTick();
          const el = container.value.querySelector(`#message-${messageId}`);
          if (el instanceof HTMLElement) {
            scrollIntoViewSafe({
              container: container.value,
              element: el,
              behavior: 'smooth',
              block: 'start'
            });
          }
        }
        break;
      }
      default: {
        const _ex: never = role;
        throw new Error(`Unhandled role: ${_ex}`);
      }
      }
      break;
    }
    case 'tool_group':
    case 'process_sequence':
      // Auto scroll to new AI items
      scrollToBottom();
      break;
    default: {
      const _ex: never = itemType;
      throw new Error(`Unhandled ChatFlowItem type: ${_ex}`);
    }
    }
  },
);
</script>

<template>
  <div
    class="flex flex-col h-full bg-[#fcfcfd] dark:bg-gray-900 transition-colors relative"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
    @click="setActiveFocusArea('chat')"
  >
    <!-- Drag Overlay -->
    <div
      v-if="isDragging"
      class="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 pointer-events-none flex items-center justify-center"
      data-testid="drag-overlay"
    >
      <div class="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-xl flex items-center gap-3 animate-in zoom-in duration-200">
        <Paperclip class="w-6 h-6 text-blue-500" />
        <span class="text-lg font-bold text-gray-800 dark:text-gray-100">Drop images to attach</span>
      </div>
    </div>

    <!-- Header -->
    <div class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-1.5 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
      <div class="flex items-center gap-3 overflow-hidden min-h-[34px]">
        <div class="flex flex-col overflow-hidden">
          <template v-if="currentChat">
            <div class="flex items-center gap-2">
              <button
                v-if="currentChat.originChatId"
                @click="jumpToOrigin"
                class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600 transition-colors"
                title="Jump to original chat"
                data-testid="jump-to-origin-button"
              >
                <ArrowUp class="w-4 h-4" />
              </button>
              <h2 class="text-xs sm:text-sm font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">{{ currentChat.title || 'New Chat' }}</h2>
              <button
                v-if="activeMessages.length > 0"
                @click="handleTitleAction"
                @mouseleave="ignoreTitleHover = false"
                class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600 transition-all disabled:opacity-50 group/title"
                :disabled="isCurrentChatStreaming"
                :title="generatingTitle ? 'Stop Title Generation' : 'Regenerate Title'"
                data-testid="regenerate-title-button"
              >
                <div class="relative w-3.5 h-3.5 flex items-center justify-center">
                  <RefreshCw
                    class="w-full h-full transition-all"
                    :class="{
                      'animate-spin': generatingTitle,
                      'group-hover/title:opacity-0 group-hover/title:scale-75': generatingTitle && !ignoreTitleHover
                    }"
                  />
                  <X
                    v-if="generatingTitle"
                    class="w-3.5 h-3.5 absolute opacity-0 transition-all text-red-500 scale-75"
                    :class="{ 'group-hover/title:opacity-100 group-hover/title:scale-100': !ignoreTitleHover }"
                  />
                </div>
              </button>
            </div>

            <!-- Model Badge/Trigger -->
            <button
              @click="showChatSettings = !showChatSettings"
              class="flex items-center gap-1.5 w-fit group"
              title="Chat Settings & Model Override"
              data-testid="model-trigger"
            >
              <div
                class="px-2 py-0.5 rounded-full text-[9px] font-bold transition-all flex items-center gap-1.5"
                :class="showChatSettings
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 group-hover:bg-gray-200 dark:group-hover:bg-gray-700 group-hover:text-gray-700 dark:group-hover:text-gray-200'"
              >
                <span class="truncate max-w-[120px] sm:max-w-[200px]">
                  {{ chatInputRef?.formatLabel(resolvedSettings?.modelId, resolvedSettings?.sources.modelId) }}
                </span>
                <Settings2 class="w-3 h-3" :class="{ 'animate-pulse': showChatSettings }" />
              </div>
              <div
                v-if="currentChat && hasChatOverrides({ chat: currentChat })"
                class="w-1 h-1 rounded-full bg-blue-500 animate-pulse"
                title="Custom overrides active"
                data-testid="custom-overrides-indicator"
              ></div>
            </button>
          </template>
          <template v-else>
            <!-- Header empty when no chat is selected -->
          </template>
        </div>
      </div>

      <div class="flex items-center gap-0.5 relative">
        <div v-if="currentChat" class="flex items-center gap-0.5">
          <!-- Move to Group Dropdown -->
          <div class="relative">
            <button
              @click="showMoveMenu = !showMoveMenu"
              class="p-1.5 rounded-lg transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
              :class="showMoveMenu ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'"
              title="Move to Group"
              data-testid="move-to-group-button"
            >
              <FolderInput class="w-4.5 h-4.5" />
            </button>

            <Transition name="dropdown">
              <div
                v-if="showMoveMenu"
                class="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden origin-top-right"
                @mouseleave="showMoveMenu = false"
              >
                <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
                  Move to Group
                </div>
                <div class="max-h-64 overflow-y-auto">
                  <button
                    @click="handleMoveToGroup(null)"
                    class="w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors"
                    :class="!currentChat.groupId ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
                  >
                    <div class="flex items-center gap-2">
                      <X class="w-4 h-4 opacity-50" />
                      <span>Top Level</span>
                    </div>
                    <ChevronRight v-if="!currentChat.groupId" class="w-4 h-4" />
                  </button>

                  <button
                    v-for="group in chatStore.chatGroups.value"
                    :key="group.id"
                    @click="handleMoveToGroup(group.id)"
                    class="w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors"
                    :class="currentChat.groupId === group.id ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'"
                  >
                    <div class="flex items-center gap-2 overflow-hidden">
                      <Folder class="w-4 h-4 opacity-50 shrink-0" />
                      <span class="truncate">{{ group.name }}</span>
                    </div>
                    <ChevronRight v-if="currentChat.groupId === group.id" class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </Transition>
          </div>

          <button
            v-if="activeMessages.length > 0"
            @click="handleForkLastMessage"
            class="p-1.5 rounded-lg transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            title="Fork Chat from last message"
            data-testid="fork-chat-button"
          >
            <GitFork class="w-4.5 h-4.5" />
          </button>

          <button
            @click="showHistoryModal = true"
            class="p-1.5 rounded-lg transition-all text-gray-400 hover:text-orange-500 dark:hover:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 group/hammer"
            title="Super Edit (Full History Manipulation)"
            data-testid="super-edit-button"
          >
            <Hammer class="w-4.5 h-4.5 group-hover/hammer:-rotate-12 transition-all" />
          </button>

          <button
            @click="exportChat"
            class="p-1.5 rounded-lg transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            title="Export as Markdown"
            data-testid="export-markdown-button"
          >
            <Download class="w-4.5 h-4.5" />
          </button>

          <button
            @click="showMoreMenu = !showMoreMenu"
            class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            title="More Actions"
            data-testid="more-actions-button"
          >
            <MoreVertical class="w-4.5 h-4.5" />
          </button>
        </div>

        <!-- Kebab Menu Dropdown -->
        <Transition name="dropdown">
          <div
            v-if="showMoreMenu"
            class="absolute right-0 top-full mt-2 w-56 bg-white/95 dark:bg-gray-800/95 backdrop-blur-md border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 origin-top-right"
            @mouseleave="showMoreMenu = false"
          >
            <button
              @click="handlePrint(); showMoreMenu = false"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-green-600 dark:hover:text-green-400"
              title="Open print dialog (can be used to Save as PDF)"
              data-testid="print-chat-button"
            >
              <Printer class="w-4 h-4" />
              <span>Print</span>
            </button>
            <button
              @click="() => { if(currentChat) useGlobalSearch().openSearch({ chatId: currentChat.id }); showMoreMenu = false; }"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-indigo-600 dark:hover:text-indigo-400"
              data-testid="search-in-chat-button"
            >
              <Search class="w-4 h-4" />
              <span>Search in Chat</span>
            </button>
            <button
              @click="toggleMediaShelf(); showMoreMenu = false"
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
              @click="shareAsURL(); showMoreMenu = false"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
              title="Copy a shareable URL containing this chat"
              data-testid="export-url-button"
            >
              <Link class="w-4 h-4" />
              <span>Export as URL</span>
            </button>
            <button
              @click="chatStore.toggleDebug(); showMoreMenu = false"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
              :class="currentChat?.debugEnabled
                ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
              "
              data-testid="toggle-debug-button"
            >
              <Bug class="w-4 h-4" />
              <span>Debug Mode</span>
            </button>
            <div class="h-px bg-gray-100 dark:bg-gray-700 my-1"></div>
            <button
              @click="toggleMarkdownRendering(); showMoreMenu = false"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
              :class="!settings.experimental || settings.experimental.markdownRendering === 'block_markdown'
                ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
              "
              data-testid="toggle-experimental-renderer-menu"
            >
              <Zap class="w-4 h-4" :class="{ 'animate-pulse': !settings.experimental || settings.experimental.markdownRendering === 'block_markdown' }" />
              <span>Block Renderer</span>
            </button>
          </div>
        </Transition>
      </div>
    </div>

    <!-- Chat Settings Panel -->
    <ChatSettingsPanel
      :show="showChatSettings"
      @close="showChatSettings = false"
    />

    <!-- History Manipulation Modal -->
    <HistoryManipulationModal
      :is-open="showHistoryModal"
      @close="showHistoryModal = false"
    />

    <!-- Messages Layer -->
    <div class="flex-1 relative overflow-hidden">
      <div
        ref="container"
        data-testid="scroll-container"
        class="absolute inset-0 overflow-y-auto overscroll-contain transition-[padding-bottom] duration-500"
        style="overflow-anchor: none;"
        :style="{ paddingBottom: inputVisibility === 'submerged' ? '48px' : '300px' }"
      >
        <div v-if="!currentChat" class="h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
          Select or create a chat to start
        </div>
        <template v-else>
          <div v-if="activeMessages.length > 0" class="relative p-2">
            <template v-for="flowItem in chatFlow" :key="flowItem.type === 'process_sequence' ? flowItem.id : (flowItem.type === 'message' ? `${flowItem.node.id}-${flowItem.mode}` : flowItem.id)">
              <!-- AI Process Sequence (Collapsible Group) -->
              <AssistantProcessSequence
                v-if="flowItem.type === 'process_sequence'"
                :items="flowItem.items"
                :is-processing="isCurrentChatStreaming"
                :flow="flowItem.flow"
                :summary="flowItem.summary"
                :stats="flowItem.stats"
                :is-first-in-turn="flowItem.isFirstInTurn"
              >
                <template #peek>
                  <template v-if="flowItem.type === 'process_sequence' && flowItem.items.length > 0">
                    <template v-for="lastItem in ([flowItem.items[flowItem.items.length - 1]] as ChatFlowItem[])" :key="lastItem.type === 'message' ? lastItem.node.id : lastItem.id">
                      <!-- Active Thinking Peek -->
                      <MessageThinking
                        v-if="lastItem.type === 'message' && isThinkingActive({ item: lastItem })"
                        :message="lastItem.node"
                        :part-content="lastItem.partContent"
                        no-margin
                      />
                      <!-- Waiting Peek (Initial loading within sequence) -->
                      <AssistantWaitingIndicator
                        v-else-if="lastItem.type === 'message' && isWaitingResponse({ item: lastItem })"
                        no-padding
                      />
                    </template>
                  </template>
                </template>
                <template #default="{ isExpanded }">
                  <template v-for="subItem in (flowItem.items as ChatFlowItem[])" :key="subItem.type === 'message' ? `${subItem.node.id}-${subItem.mode}` : subItem.id">
                    <MessageItem
                      v-if="subItem.type === 'message' && isExpanded"
                      :id="'message-' + subItem.node.id"
                      :chat-id="currentChat!.id"
                      :message="subItem.node"
                      :siblings="chatStore.getSiblings(subItem.node.id)"
                      :can-generate-image="canGenerateImage && hasImageModel"
                      :is-processing="isCurrentChatStreaming"
                      :is-generating="isCurrentChatStreaming && subItem.node.id === currentChat?.currentLeafId"
                      :available-image-models="availableImageModels"
                      :endpoint-type="resolvedSettings?.endpointType"
                      :flow="subItem.flow"
                      :mode="subItem.mode"
                      :part-content="subItem.partContent"
                      :is-first-in-node="subItem.isFirstInNode"
                      :is-last-in-node="subItem.isLastInNode"
                      :is-first-in-turn="subItem.isFirstInTurn"
                      @fork="handleFork"
                      @edit="(id, content, params) => handleEdit(id, content, params)"
                      @switch-version="handleSwitchVersion"
                      @regenerate="handleRegenerate"
                      @abort="chatStore.abortChat({ chatId: undefined })"
                    />
                    <ToolCallGroupItem
                      v-else-if="subItem.type === 'tool_group' && isExpanded"
                      :tool-calls="subItem.toolCalls"
                      :flow="subItem.flow"
                      :is-first-in-turn="subItem.isFirstInTurn"
                    />
                  </template>
                </template>
              </AssistantProcessSequence>

              <!-- Standard Message -->
              <MessageItem
                v-else-if="flowItem.type === 'message'"
                :id="'message-' + flowItem.node.id"
                :chat-id="currentChat!.id"
                :message="flowItem.node"
                :siblings="chatStore.getSiblings(flowItem.node.id)"
                :can-generate-image="canGenerateImage && hasImageModel"
                :is-processing="isCurrentChatStreaming"
                :is-generating="isCurrentChatStreaming && flowItem.node.id === currentChat?.currentLeafId"
                :available-image-models="availableImageModels"
                :endpoint-type="resolvedSettings?.endpointType"
                :flow="flowItem.flow"
                :mode="flowItem.mode"
                :part-content="flowItem.partContent"
                :is-first-in-node="flowItem.isFirstInNode"
                :is-last-in-node="flowItem.isLastInNode"
                :is-first-in-turn="flowItem.isFirstInTurn"
                @fork="handleFork"
                @edit="(id, content, params) => handleEdit(id, content, params)"
                @switch-version="handleSwitchVersion"
                @regenerate="handleRegenerate"
                @abort="chatStore.abortChat({ chatId: undefined })"
              />

              <!-- Standalone Tool Group -->
              <ToolCallGroupItem
                v-else-if="flowItem.type === 'tool_group'"
                :tool-calls="flowItem.toolCalls"
                :flow="flowItem.flow"
                :is-first-in-turn="flowItem.isFirstInTurn"
              />
            </template>

            <!-- Global Transformers.js Loading Indicator in the scroll flow -->
            <TransformersJsLoadingIndicator
              v-if="resolvedSettings?.endpointType === 'transformers_js'"
              mode="full"
            />
          </div>
          <WelcomeScreen
            v-else
            :has-input="(chatInputRef?.input || '').trim().length > 0"
            @select-suggestion="(text) => chatInputRef?.applySuggestion(text)"
          />
        </template>

        <!-- Conditional spacer: only large when maximized or animating to allow scrolling hidden content -->
        <div
          v-if="chatInputRef?.isMaximized || isAnimatingHeight"
          class="h-[75vh] shrink-0 pointer-events-none"
          data-testid="maximized-spacer"
        ></div>
      </div>

      <!-- Chat State Inspector (Debug Mode) -->
      <ChatDebugInspector
        v-if="currentChat?.debugEnabled"
        :show="currentChat.debugEnabled"
        :chat="currentChat"
        :active-messages="activeMessages"
        @close="chatStore.toggleDebug"
        data-testid="chat-inspector"
      />
    </div>

    <!-- Input Layer -->
    <ChatMediaShelf
      v-if="currentChat && mediaShelfVisibility === 'visible'"
      :chat-id="currentChat.id"
      :messages="allMessages"
      @close="setMediaShelfVisibility({ visibility: 'hidden' })"
      @jump-to-message="(id) => jumpToMessage({ messageId: id })"
    />
    <ChatInput
      v-if="currentChat"
      ref="chatInputRef"
      v-model:visibility="inputVisibility"
      v-model:is-animating-height="isAnimatingHeight"
      :is-streaming="isCurrentChatStreaming"
      :can-generate-image="canGenerateImage"
      :has-image-model="hasImageModel"
      :available-image-models="availableImageModels"
      :auto-send-prompt="autoSendPrompt"
      @auto-sent="emit('auto-sent')"
      @scroll-to-bottom="scrollToBottom"
    />

    <!-- Preview Modal -->
    <BinaryObjectPreviewModal
      v-if="previewState"
      :objects="previewState.objects"
      :initial-id="previewState.initialId"
      @close="closePreview"
      @delete="(obj) => deleteBinaryObject(obj.id)"
      @download="(obj) => downloadBinaryObject(obj)"
    />
  </div>
</template>

<style scoped>
/* Dropdown Transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(-10px);
}
</style>
