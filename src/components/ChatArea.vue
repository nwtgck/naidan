<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';

// IMPORTANT: MessageItem is the core of the chat experience. We import it synchronously
// to ensure the chat history displays immediately and smoothly without individual components popping in.
import MessageItem from './MessageItem.vue';
// IMPORTANT: WelcomeScreen is the first thing users see in a new chat. We import it synchronously for an instant landing.
import WelcomeScreen from './WelcomeScreen.vue';
import ChatInput from './ChatInput.vue';

// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const BinaryObjectPreviewModal = defineAsyncComponentAndLoadOnMounted(() => import('./BinaryObjectPreviewModal.vue'));
import { useImagePreview } from '../composables/useImagePreview';
import { useBinaryActions } from '../composables/useBinaryActions';

// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatSettingsPanel = defineAsyncComponentAndLoadOnMounted(() => import('./ChatSettingsPanel.vue'));
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const HistoryManipulationModal = defineAsyncComponentAndLoadOnMounted(() => import('./HistoryManipulationModal.vue'));
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatDebugInspector = defineAsyncComponentAndLoadOnMounted(() => import('./ChatDebugInspector.vue'));
import {
  Paperclip, X, GitFork, RefreshCw,
  ArrowUp, Settings2, Download, MoreVertical, Bug,
  Folder, FolderInput, ChevronRight, Hammer, Search
} from 'lucide-vue-next';
import { useGlobalSearch } from '../composables/useGlobalSearch';


const chatStore = useChat();
const { state: previewState, closePreview } = useImagePreview(true);
const { deleteBinaryObject, downloadBinaryObject } = useBinaryActions();
const {
  currentChat,
  streaming,
  generatingTitle,
  activeMessages,
  availableModels,
  resolvedSettings,
  isProcessing,
  getSortedImageModels,
} = chatStore;

const availableImageModels = computed(() => {
  return getSortedImageModels({ availableModels: availableModels.value });
});

const { setActiveFocusArea } = useLayout();
const isSubmerged = ref(false);
const isAnimatingHeight = ref(false);
const isDragging = ref(false);

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

function exportChat() {
  if (!currentChat.value || !activeMessages.value) return;

  let markdownContent = `# ${currentChat.value.title || 'New Chat'}\n\n`;

  activeMessages.value.forEach(msg => {
    const role = (() => {
      switch (msg.role) {
      case 'user': return 'User';
      case 'assistant': return 'AI';
      case 'system': return 'System';
      default: {
        const _ex: never = msg.role;
        return _ex;
      }
      }
    })();
    markdownContent += `## ${role}:\n${msg.content}\n\n`;
  });

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

function scrollToBottom(force = true) {
  if (container.value) {
    const { scrollTop, scrollHeight, clientHeight } = container.value;
    // Only auto-scroll if forced (new message) or already near the bottom
    if (force || scrollHeight - scrollTop - clientHeight < 150) {
      container.value.scrollTop = scrollHeight;
    }
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

async function handleEdit(messageId: string, newContent: string) {
  await chatStore.editMessage(messageId, newContent);
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
  const lastMsg = activeMessages.value[activeMessages.value.length - 1];
  if (lastMsg) {
    handleFork(lastMsg.id);
  }
}

function jumpToOrigin() {
  if (currentChat.value?.originChatId) {
    router.push(`/chat/${currentChat.value.originChatId}`);
  }
}

watch(
  () => activeMessages.value.length,
  () => nextTick(scrollToBottom),
);

watch(
  () => activeMessages.value[activeMessages.value.length - 1]?.content,
  (newContent) => {
    if (streaming.value && newContent && newContent.length < 400 && container.value) {
      const { scrollTop, scrollHeight, clientHeight } = container.value;
      // Only auto-scroll if user is already at the bottom (within 50px)
      if (scrollHeight - scrollTop - clientHeight < 50) {
        nextTick(scrollToBottom);
      }
    }
  },
  { deep: true },
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
    <div class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
      <div class="flex items-center gap-3 overflow-hidden min-h-[44px]">
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
              <h2 class="text-base sm:text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">{{ currentChat.title || 'New Chat' }}</h2>
              <button
                v-if="activeMessages.length > 0"
                @click="currentChat && chatStore.generateChatTitle(currentChat.id)"
                class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600 transition-all disabled:opacity-50"
                :class="{ 'animate-spin': generatingTitle }"
                :disabled="generatingTitle || isCurrentChatStreaming"
                title="Regenerate Title"
                data-testid="regenerate-title-button"
              >
                <RefreshCw class="w-3.5 h-3.5" />
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
                class="px-2 py-0.5 rounded-full text-[10px] font-bold transition-all flex items-center gap-1.5"
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
                v-if="currentChat.endpointUrl || currentChat.endpointType || currentChat.modelId || currentChat.systemPrompt || (currentChat.lmParameters && Object.keys(currentChat.lmParameters).length > 0)"
                class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"
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

      <div class="flex items-center gap-1 relative">
        <div v-if="currentChat" class="flex items-center gap-1">
          <!-- Move to Group Dropdown -->
          <div class="relative">
            <button
              @click="showMoveMenu = !showMoveMenu"
              class="p-2 rounded-xl transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
              :class="showMoveMenu ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'"
              title="Move to Group"
              data-testid="move-to-group-button"
            >
              <FolderInput class="w-5 h-5" />
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
            class="p-2 rounded-xl transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            title="Fork Chat from last message"
            data-testid="fork-chat-button"
          >
            <GitFork class="w-5 h-5" />
          </button>

          <button
            @click="showHistoryModal = true"
            class="p-2 rounded-xl transition-all text-gray-400 hover:text-orange-500 dark:hover:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 group/hammer"
            title="Super Edit (Full History Manipulation)"
            data-testid="super-edit-button"
          >
            <Hammer class="w-5 h-5 group-hover/hammer:-rotate-12 transition-all" />
          </button>

          <button
            @click="exportChat"
            class="p-2 rounded-xl transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            title="Export Chat"
          >
            <Download class="w-5 h-5" />
          </button>

          <button
            @click="showMoreMenu = !showMoreMenu"
            class="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            title="More Actions"
            data-testid="more-actions-button"
          >
            <MoreVertical class="w-5 h-5" />
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
              @click="() => { if(currentChat) useGlobalSearch().openSearch({ chatId: currentChat.id }); showMoreMenu = false; }"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-indigo-600 dark:hover:text-indigo-400"
            >
              <Search class="w-4 h-4" />
              <span>Search in Chat</span>
            </button>
            <button
              @click="chatStore.toggleDebug(); showMoreMenu = false"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
              :class="currentChat?.debugEnabled
                ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
              "
            >
              <Bug class="w-4 h-4" />
              <span>Debug Mode</span>
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
        :style="{ paddingBottom: isSubmerged ? '48px' : '300px' }"
      >
        <div v-if="!currentChat" class="h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
          Select or create a chat to start
        </div>
        <template v-else>
          <div v-if="activeMessages.length > 0" class="relative p-2">
            <MessageItem
              v-for="msg in activeMessages"
              :key="msg.id"
              :message="msg"
              :siblings="chatStore.getSiblings(msg.id)"
              :can-generate-image="canGenerateImage && hasImageModel"
              :is-processing="isCurrentChatStreaming"
              :is-generating="isCurrentChatStreaming && msg.id === currentChat?.currentLeafId"
              :available-image-models="availableImageModels"
              @fork="handleFork"
              @edit="handleEdit"
              @switch-version="handleSwitchVersion"
              @regenerate="handleRegenerate"
              @abort="chatStore.abortChat()"
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
    <ChatInput
      v-if="currentChat"
      ref="chatInputRef"
      v-model:is-submerged="isSubmerged"
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
