<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, defineAsyncComponent } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../composables/useChat';
import { useChatDraft } from '../composables/useChatDraft';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';
import MessageItem from './MessageItem.vue';
import WelcomeScreen from './WelcomeScreen.vue';
import ModelSelector from './ModelSelector.vue';
import ChatToolsMenu from './ChatToolsMenu.vue';
import BinaryObjectPreviewModal from './BinaryObjectPreviewModal.vue';
import { naturalSort } from '../utils/string';
import { useImagePreview } from '../composables/useImagePreview';
import { useBinaryActions } from '../composables/useBinaryActions';

const ChatSettingsPanel = defineAsyncComponent(() => import('./ChatSettingsPanel.vue'));
const HistoryManipulationModal = defineAsyncComponent(() => import('./HistoryManipulationModal.vue'));
import { 
  Square, Minimize2, Maximize2, Send,
  Paperclip, X, GitFork, RefreshCw,
  ArrowUp, Settings2, Download, MoreVertical, Bug,
  Folder, FolderInput, ChevronRight, Hammer, Image
} from 'lucide-vue-next';
import type { Attachment } from '../models/types';


const chatStore = useChat();
const { getDraft, saveDraft, clearDraft } = useChatDraft();
const { state: previewState, closePreview } = useImagePreview(true); // Scoped instance
const { deleteBinaryObject, downloadBinaryObject } = useBinaryActions();
const {
  currentChat,
  streaming,
  generatingTitle,
  activeMessages,
  fetchingModels,
  availableModels,
  resolvedSettings,
  inheritedSettings,
  isProcessing,
  isImageMode: _isImageMode,
  toggleImageMode: _toggleImageMode,
  getResolution,
  updateResolution: _updateResolution,
  getCount,
  updateCount: _updateCount,
  getPersistAs,
  updatePersistAs: _updatePersistAs,
  setImageModel,
  getSelectedImageModel,
  getSortedImageModels,
} = chatStore;
const sortedAvailableModels = computed(() => naturalSort(availableModels?.value || []));
const { activeFocusArea, setActiveFocusArea } = useLayout();

const isImageMode = computed({
  get: () => currentChat.value ? _isImageMode({ chatId: currentChat.value.id }) : false,
  set: () => {
    if (currentChat.value) {
      _toggleImageMode({ chatId: currentChat.value.id });
    }
  }
});

const currentResolution = computed(() => {
  return currentChat.value ? getResolution({ chatId: currentChat.value.id }) : { width: 512, height: 512 };
});

function updateResolution(width: number, height: number) {
  if (currentChat.value) {
    _updateResolution({ chatId: currentChat.value.id, width, height });
  }
}

const currentCount = computed(() => {
  return currentChat.value ? getCount({ chatId: currentChat.value.id }) : 1;
});

function updateCount(count: number) {
  if (currentChat.value) {
    _updateCount({ chatId: currentChat.value.id, count });
  }
}

const currentPersistAs = computed(() => {
  return currentChat.value ? getPersistAs({ chatId: currentChat.value.id }) : 'original';
});

function updatePersistAs(format: 'original' | 'webp' | 'jpeg' | 'png') {
  if (currentChat.value) {
    _updatePersistAs({ chatId: currentChat.value.id, format });
  }
}

const availableImageModels = computed(() => {
  return getSortedImageModels({ availableModels: availableModels.value });
});

const selectedImageModel = computed(() => {
  return currentChat.value ? getSelectedImageModel({ chatId: currentChat.value.id, availableModels: availableModels.value }) : undefined;
});

function handleUpdateImageModel(modelId: string) {
  if (currentChat.value) {
    setImageModel({ chatId: currentChat.value.id, modelId });
  }
}

useSettings();
const router = useRouter();

const props = defineProps<{
  autoSendPrompt?: string
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void
}>();

const input = ref('');

function formatLabel(value: string | undefined, source: 'chat' | 'chat_group' | 'global' | undefined) {
  if (!value) return 'Default';
  switch (source) {
  case 'chat_group':
    return `${value} (Group)`;
  case 'global':
    return `${value} (Global)`;
  case 'chat':
  case undefined:
    return value;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled source: ${_ex}`);
  }  
  }
}

const isCurrentChatStreaming = computed(() => {
  return currentChat.value ? isProcessing(currentChat.value.id) : false;
});

const container = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isMaximized = ref(false); // New state for maximize button
const isOverLimit = ref(false); // New state to show maximize button only when content is long
const isAnimatingHeight = ref(false);

const attachments = ref<Attachment[]>([]);
const attachmentUrls = ref<Record<string, string>>({});
const isDragging = ref(false);

watch(attachments, (newAtts) => {
  // Revoke URLs for removed attachments
  Object.keys(attachmentUrls.value).forEach(id => {
    if (!newAtts.find(a => a.id === id)) {
      const url = attachmentUrls.value[id];
      if (url) {
        URL.revokeObjectURL(url);
      }
      delete attachmentUrls.value[id];
    }
  });

  // Create URLs for new attachments
  newAtts.forEach(att => {
    if (att.status === 'memory' && !attachmentUrls.value[att.id]) {
      attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
    }
  });
}, { deep: true });

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

const showChatSettings = ref(false);
const showHistoryModal = ref(false);
const showMoreMenu = ref(false);
const showMoveMenu = ref(false);

async function handleMoveToGroup(groupId: string | null) {
  if (!currentChat.value) return;
  await chatStore.moveChatToGroup(currentChat.value.id, groupId);
  showMoveMenu.value = false;
}

function triggerFileInput() {
  fileInputRef.value?.click();
}

async function processFiles(files: File[]) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    
    const attachmentId = crypto.randomUUID();
    const attachment: Attachment = {
      id: attachmentId,
      binaryObjectId: crypto.randomUUID(),
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: file,
    };
    attachments.value.push(attachment);
  }
  nextTick(adjustTextareaHeight);
}

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files) return;

  await processFiles(Array.from(target.files));
  target.value = ''; // Reset input
}

async function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;

  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }

  if (files.length > 0) {
    await processFiles(files);
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
    await processFiles(Array.from(event.dataTransfer.files));
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id);
  nextTick(adjustTextareaHeight);
}

function applySuggestion(text: string) {
  input.value = text;
  nextTick(() => {
    adjustTextareaHeight();
    focusInput();
  });
}

function adjustTextareaHeight() {
  if (textareaRef.value) {
    const target = textareaRef.value;
    
    // Temporarily reset height to auto to measure content height
    if (!isAnimatingHeight.value) {
      target.style.height = 'auto';
    }
    
    const currentScrollHeight = target.scrollHeight;
    const computedStyle = getComputedStyle(target);
    const lineHeight = parseFloat(computedStyle.lineHeight);
    const paddingTop = parseFloat(computedStyle.paddingTop);
    const paddingBottom = parseFloat(computedStyle.paddingBottom);
    const borderTop = parseFloat(computedStyle.borderTopWidth);
    const borderBottom = parseFloat(computedStyle.borderBottomWidth);
    const verticalPadding = paddingTop + paddingBottom + borderTop + borderBottom;
    
    const minHeight = lineHeight + verticalPadding;
    const maxSixLinesHeight = (lineHeight * 6) + verticalPadding;

    isOverLimit.value = currentScrollHeight > maxSixLinesHeight;

    let finalHeight: number;
    if (isMaximized.value) {
      finalHeight = window.innerHeight * 0.7;
    } else {
      finalHeight = Math.max(minHeight, Math.min(currentScrollHeight, maxSixLinesHeight));
    }

    target.style.height = finalHeight + 'px';
    target.style.overflowY = (isMaximized.value ? currentScrollHeight > finalHeight : currentScrollHeight > maxSixLinesHeight) ? 'auto' : 'hidden';

    // Only auto-scroll if we are near the bottom AND not animating maximization
    if (container.value && !isAnimatingHeight.value) {
      const { scrollTop, scrollHeight, clientHeight } = container.value;
      if (scrollHeight - scrollTop - clientHeight < 150) {
        nextTick(scrollToBottom);
      }
    }
  }
}

function toggleMaximized() {
  if (textareaRef.value) {
    // 1. Capture current height and set it explicitly to ensure transition works
    const startHeight = textareaRef.value.getBoundingClientRect().height;
    textareaRef.value.style.height = startHeight + 'px';
    
    // 2. Enable animation state
    isAnimatingHeight.value = true;
    
    // 3. Trigger state change in next frames to allow CSS transition to catch the change
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isMaximized.value = !isMaximized.value;
      });
    });
    
    // 4. Cleanup after animation
    setTimeout(() => {
      isAnimatingHeight.value = false;
    }, 400); // Slightly longer than 300ms transition
  }
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

function focusInput() {
  switch (activeFocusArea.value) {
  case 'sidebar':
    return;
  case 'chat':
  case 'chat-group-settings':
  case 'chat-settings':
  case 'settings':
  case 'onboarding':
  case 'dialog':
  case 'none':
    break;
  default: {
    const _ex: never = activeFocusArea.value;
    throw new Error(`Unhandled focus area: ${_ex}`);
  }
  }
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

function scrollToBottom() {
  if (container.value) {
    container.value.scrollTop = container.value.scrollHeight;
  }
}

// Expose for testing
defineExpose({ scrollToBottom, container, handleSend, isMaximized, adjustTextareaHeight, attachments, input });

async function fetchModels() {
  if (currentChat.value) {
    await chatStore.fetchAvailableModels(currentChat.value.id);
  }
}

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

function toggleImageMode() {
  isImageMode.value = !isImageMode.value;
}

async function handleGenerateImage() {
  if (!currentChat.value || (!input.value.trim() && attachments.value.length === 0) || isCurrentChatStreaming.value) return;
  
  const prompt = input.value;
  const currentAttachments = [...attachments.value];
  const sendingChatId = currentChat.value.id;
  const { width, height } = currentResolution.value;
  const count = currentCount.value;
  const success = await chatStore.sendImageRequest({ 
    prompt, 
    width, 
    height,
    count,
    persistAs: currentPersistAs.value,
    attachments: currentAttachments
  });
  if (success) {
    if (currentChat.value?.id === sendingChatId) {
      input.value = '';
      attachments.value = [];
    }
    clearDraft(sendingChatId);
    nextTick(adjustTextareaHeight);
  }
}

async function handleSend() {
  if ((!input.value.trim() && attachments.value.length === 0) || isCurrentChatStreaming.value) return;

  if (isImageMode.value) {
    await handleGenerateImage();
    return;
  }

  const text = input.value;
  const currentAttachments = [...attachments.value];
  const sendingChatId = currentChat.value?.id;
  
  if (isMaximized.value && textareaRef.value) {
    const startHeight = textareaRef.value.getBoundingClientRect().height;
    textareaRef.value.style.height = startHeight + 'px';
    isAnimatingHeight.value = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isMaximized.value = false;
      });
    });
    setTimeout(() => {
      isAnimatingHeight.value = false;
    }, 400);
  } else {
    isMaximized.value = false; // Reset maximized state immediately
  }
  
  const success = await chatStore.sendMessage(text, undefined, currentAttachments);
  
  if (success) {
    if (currentChat.value?.id === sendingChatId) {
      input.value = '';
      attachments.value = [];
    }
    clearDraft(sendingChatId);
    
    nextTick(() => { // Ensure textarea is cleared before adjusting height
      adjustTextareaHeight();
      scrollToBottom();
    });
  }

  focusInput();
}

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

watch(input, () => {
  adjustTextareaHeight();
}, { flush: 'post' }); // Ensure DOM is updated before recalculating

watch(isMaximized, () => {
  nextTick(() => {
    adjustTextareaHeight();
  });
});

watch(
  () => currentChat.value?.id,
  (newId, oldId) => {
    // Save previous draft
    saveDraft(oldId, { 
      input: input.value, 
      attachments: attachments.value,
      attachmentUrls: attachmentUrls.value
    });

    // Load new draft
    const draft = getDraft(newId);
    input.value = draft.input;
    attachments.value = draft.attachments;
    attachmentUrls.value = draft.attachmentUrls;

    if (currentChat.value) {
      isMaximized.value = false;
      fetchModels();
      nextTick(() => {
        scrollToBottom();
        focusInput();
        adjustTextareaHeight();
      });
    }
  },
  { immediate: true }
);

onMounted(async () => {
  window.addEventListener('resize', adjustTextareaHeight);
  if (currentChat.value) {
    fetchModels();
  }

  if (props.autoSendPrompt) {
    const doAutoSend = async () => {
      await nextTick();
      input.value = props.autoSendPrompt!;
      await handleSend();
      emit('auto-sent');
    };

    if (currentChat.value) {
      doAutoSend();
    } else {
      const unwatch = watch(() => currentChat.value, (chat) => {
        if (chat) {
          unwatch();
          doAutoSend();
        }
      });
    }
  }

  nextTick(() => {
    scrollToBottom();
    adjustTextareaHeight(); // Call adjustTextareaHeight on mount
    if (currentChat.value) {
      focusInput();
    }
  });
});

import { onUnmounted } from 'vue';
onUnmounted(() => {
  window.removeEventListener('resize', adjustTextareaHeight);
  
  // Save final state
  saveDraft(currentChat.value?.id, {
    input: input.value,
    attachments: attachments.value,
    attachmentUrls: attachmentUrls.value
  });

  // Revoke all created URLs across all drafts to prevent leaks
  const { revokeAll } = useChatDraft();
  revokeAll();
});
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
                  {{ formatLabel(resolvedSettings?.modelId, resolvedSettings?.sources.modelId) }}
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
        class="absolute inset-0 overflow-y-auto overscroll-contain"
        style="overflow-anchor: none; padding-bottom: 300px;"
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
              :available-image-models="availableImageModels"
              @fork="handleFork"
              @edit="handleEdit"
              @switch-version="handleSwitchVersion"
              @regenerate="handleRegenerate"
            />
          </div>
          <WelcomeScreen 
            v-else 
            :has-input="input.trim().length > 0"
            @select-suggestion="applySuggestion" 
          />
        </template>
        
        <!-- Conditional spacer: only large when maximized or animating to allow scrolling hidden content -->
        <div 
          v-if="isMaximized || isAnimatingHeight"
          class="h-[75vh] shrink-0 pointer-events-none"
          data-testid="maximized-spacer"
        ></div>
      </div>

      <!-- Chat State Inspector (Debug Mode) -->
      <div 
        v-if="currentChat?.debugEnabled" 
        class="absolute right-0 top-0 bottom-0 w-96 border-l dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-y-auto p-4 font-mono text-[10px] animate-in slide-in-from-right duration-300 shadow-xl z-20"
        data-testid="chat-inspector"
      >
        <div class="flex items-center justify-between mb-4 pb-2 border-b dark:border-gray-800">
          <div class="flex items-center gap-2 text-indigo-500 uppercase font-bold tracking-widest">
            <Bug class="w-3.5 h-3.5" />
            <span>Chat Inspector</span>
          </div>
          <button @click="chatStore.toggleDebug" class="text-gray-400 hover:text-white">
            <Square class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="space-y-4">
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Metadata</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ JSON.stringify({ id: currentChat.id, title: currentChat.title, currentLeafId: currentChat.currentLeafId }, null, 2) }}</pre>
          </section>
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Active Branch Path</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ activeMessages.map(m => `[${m.role.slice(0,1).toUpperCase()}] ${m.id.slice(0,8)}...`).join(' -> ') }}</pre>
          </section>
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Full Tree Structure</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ JSON.stringify(currentChat.root.items, null, 2) }}</pre>
          </section>
        </div>
      </div>
    </div>

    <!-- Input Layer (Overlay) -->
    <div 
      v-if="currentChat"
      class="absolute bottom-0 left-0 right-0 p-4 sm:p-6 bg-transparent pointer-events-none z-30"
    >
      <!-- Glass Zone behind the input card (Full width blur) -->
      <div class="absolute inset-0 -z-10 glass-zone-mask"></div>

      <div 
        class="max-w-4xl mx-auto w-full pointer-events-auto relative group border border-gray-100 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all duration-300 flex flex-col"
        :class="isMaximized || isAnimatingHeight ? 'shadow-2xl ring-1 ring-black/5 dark:ring-white/10' : 'shadow-lg group-hover:shadow-xl'"
      >
        
        <!-- Attachment Previews -->
        <div v-if="attachments.length > 0" class="flex flex-wrap gap-2 px-4 pt-4" data-testid="attachment-preview">
          <div v-for="att in attachments" :key="att.id" class="relative group/att">
            <img 
              :src="attachmentUrls[att.id]" 
              class="w-20 h-20 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
            />
            <button 
              @click="removeAttachment(att.id)"
              class="absolute -top-2 -right-2 p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-sm opacity-0 group-hover/att:opacity-100 transition-opacity"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        </div>

        <textarea
          ref="textareaRef"
          v-model="input"
          @input="adjustTextareaHeight"
          @paste="handlePaste"
          @focus="setActiveFocusArea('chat')"
          @click="setActiveFocusArea('chat')"
          @keydown.enter.ctrl.prevent="handleSend"
          @keydown.enter.meta.prevent="handleSend"
          @keydown.esc.prevent="isCurrentChatStreaming ? chatStore.abortChat() : null"
          placeholder="Type a message..."
          class="w-full text-base pl-5 pr-12 pt-4 pb-2 focus:outline-none bg-transparent text-gray-800 dark:text-gray-100 resize-none min-h-[60px] transition-colors"
          :class="{ 'animate-height': isAnimatingHeight }"
          data-testid="chat-input"
        ></textarea>

        <!-- Maximize/Minimize Button inside input area -->
        <button
          v-if="isOverLimit || isMaximized"
          @click="toggleMaximized"
          class="absolute right-4 top-4 p-1.5 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors z-20 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm shadow-sm border border-gray-100 dark:border-gray-700"
          :title="isMaximized ? 'Minimize Input' : 'Maximize Input'"
          data-testid="maximize-button"
        >
          <Minimize2 v-if="isMaximized" class="w-4 h-4" />
          <Maximize2 v-else class="w-4 h-4" />
        </button>

        <div class="flex items-center justify-between px-4 pb-4">
          <div class="flex items-center gap-2">
            <div class="w-[100px] sm:w-[180px]">
              <ModelSelector 
                :model-value="currentChat.modelId"
                @update:model-value="val => currentChat && chatStore.updateChatModel(currentChat.id, val!)"
                :models="sortedAvailableModels"
                :placeholder="formatLabel(inheritedSettings?.modelId, inheritedSettings?.sources.modelId)"
                :loading="fetchingModels"
                allow-clear
                @refresh="fetchModels"
                data-testid="model-override-select"
              />
            </div>

            <input 
              ref="fileInputRef"
              type="file" 
              accept="image/*" 
              multiple 
              class="hidden" 
              @change="handleFileSelect"
            />
            <button 
              @click="triggerFileInput"
              class="p-2 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              title="Attach images"
            >
              <Paperclip class="w-5 h-5" />
            </button>

            <ChatToolsMenu 
              :can-generate-image="canGenerateImage && hasImageModel"
              :is-processing="isCurrentChatStreaming"
              :is-image-mode="isImageMode"
              :selected-width="currentResolution.width"
              :selected-height="currentResolution.height"
              :selected-count="currentCount"
              :selected-persist-as="currentPersistAs"
              :available-image-models="availableImageModels"
              :selected-image-model="selectedImageModel"
              @toggle-image-mode="toggleImageMode"
              @update:resolution="updateResolution"
              @update:count="updateCount"
              @update:persist-as="updatePersistAs"
              @update:model="handleUpdateImageModel"
            />
          </div>

          <button 
            @click="isCurrentChatStreaming ? chatStore.abortChat() : handleSend()"
            :disabled="!isCurrentChatStreaming && !input.trim() && attachments.length === 0"
            class="px-4 py-2.5 text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all shadow-lg shadow-blue-500/30 whitespace-nowrap"
            :title="isCurrentChatStreaming ? 'Stop generating (Esc)' : 'Send message (' + sendShortcutText + ')'"
            :data-testid="isCurrentChatStreaming ? 'abort-button' : 'send-button'"
          >
            <template v-if="isCurrentChatStreaming">
              <span class="text-xs font-medium opacity-90 hidden sm:inline">Esc</span>
              <Square class="w-4 h-4 fill-white text-white" />
            </template>
            <template v-else>
              <span class="text-[10px] font-bold opacity-90 hidden sm:inline tracking-wider">{{ sendShortcutText }}</span>
              <Image v-if="isImageMode" class="w-4 h-4 text-white" />
              <Send v-else class="w-4 h-4" />
            </template>
          </button>
        </div>
      </div>
    </div>

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

/* Simplified animations */
.animate-in {
  animation-fill-mode: forwards;
}

.animate-height {
  transition: height 0.3s ease-in-out !important;
}

.glass-zone-mask {
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
  /* Keep top 35% clear for a tighter focus around the actual input card */
  mask-image: linear-gradient(to bottom, transparent, black 35%);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black 35%);
  /* Start background fade later to match */
  background: linear-gradient(
    to bottom, 
    transparent 25%, 
    rgba(255, 255, 255, 0.5) 60%, 
    rgba(255, 255, 255, 1) 95%
  );
}

.dark .glass-zone-mask {
  background: linear-gradient(
    to bottom, 
    transparent 25%, 
    rgba(17, 24, 39, 0.5) 60%, 
    rgba(17, 24, 39, 1) 95%
  );
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in {
  animation-name: zoom-in;
}
</style>
