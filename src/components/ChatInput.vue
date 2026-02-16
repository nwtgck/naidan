<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, toRaw, onUnmounted } from 'vue';
import { useChat } from '../composables/useChat';
import { useChatDraft } from '../composables/useChatDraft';
import { useLayout } from '../composables/useLayout';
import { generateId } from '../utils/id';
import { naturalSort } from '../utils/string';
import ModelSelector from './ModelSelector.vue';
import ChatToolsMenu from './ChatToolsMenu.vue';

import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
const ImageEditor = defineAsyncComponentAndLoadOnMounted(() => import('./ImageEditor.vue'));
const AdvancedTextEditor = defineAsyncComponentAndLoadOnMounted(() => import('./AdvancedTextEditor.vue'));

import {
  Square, Minimize2, Maximize2, Send,
  Paperclip, X, Image,
  ChevronDown, ChevronUp, Edit2, FileEdit
} from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import type { Attachment, Chat } from '../models/types';

const chatStore = useChat();
const router = useRouter();
const { getDraft, saveDraft, clearDraft } = useChatDraft();
const {
  currentChat,
  availableModels,
  inheritedSettings,
  fetchingModels,
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
} = chatStore;

const { setActiveFocusArea, activeFocusArea } = useLayout();

const props = defineProps<{
  autoSendPrompt?: string;
  visibility: 'submerged' | 'peeking' | 'active';
  isStreaming: boolean;
  canGenerateImage: boolean;
  hasImageModel: boolean;
  availableImageModels: string[];
  isAnimatingHeight: boolean;
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void;
  (e: 'update:visibility', value: 'submerged' | 'peeking' | 'active'): void;
  (e: 'update:isAnimatingHeight', value: boolean): void;
  (e: 'scroll-to-bottom'): void;
}>();

const isFocused = ref(false);
const isHovered = ref(false);

const isCurrentChatStreaming = computed(() => props.isStreaming);
const canGenerateImage = computed(() => props.canGenerateImage);
const hasImageModel = computed(() => props.hasImageModel);
const availableImageModels = computed(() => props.availableImageModels);

const isAnimatingHeight = computed({
  get: () => props.isAnimatingHeight,
  set: (val) => emit('update:isAnimatingHeight', val)
});

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

function scrollToBottom() {
  emit('scroll-to-bottom');
}

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

const selectedImageModel = computed(() => {
  return currentChat.value ? getSelectedImageModel({ chatId: currentChat.value.id, availableModels: availableModels.value }) : undefined;
});

function handleUpdateImageModel(modelId: string) {
  if (currentChat.value) {
    setImageModel({ chatId: currentChat.value.id, modelId });
  }
}

async function fetchModels() {
  if (currentChat.value) {
    await chatStore.fetchAvailableModels(currentChat.value.id);
  }
}

function toggleImageMode() {
  isImageMode.value = !isImageMode.value;
}

const sortedAvailableModels = computed(() => naturalSort(availableModels?.value || []));

const input = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isMaximized = ref(false); // New state for maximize button
const isOverLimit = ref(false); // New state to show maximize button only when content is long
const isAdvancedEditorOpen = ref(false);

function openAdvancedEditor() {
  isAdvancedEditorOpen.value = true;
}

function closeAdvancedEditor() {
  isAdvancedEditorOpen.value = false;
}

function handleAdvancedEditorUpdate({ content: newContent }: { content: string }) {
  input.value = newContent;
}

const attachments = ref<Attachment[]>([]);
const attachmentUrls = ref<Record<string, string>>({});

// Image Editor integration
const editingAttachmentId = ref<string | undefined>(undefined);
const editingAttachment = computed(() => attachments.value.find(a => a.id === editingAttachmentId.value));

function openImageEditor({ id }: { id: string }) {
  editingAttachmentId.value = id;
}

function closeImageEditor() {
  editingAttachmentId.value = undefined;
}

function saveEditedImage({ blob }: { blob: Blob }) {
  if (!editingAttachment.value) return;

  const index = attachments.value.findIndex(a => a.id === editingAttachmentId.value);
  if (index !== -1) {
    const original = attachments.value[index]!;

    // Explicitly revoke old URL to ensure UI refresh
    const oldUrl = attachmentUrls.value[original.id];
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
      delete attachmentUrls.value[original.id];
    }

    // Update the attachment with the new blob and a new binary object identity
    attachments.value[index] = {
      ...original,
      binaryObjectId: generateId(),
      status: 'memory',
      blob,
      size: blob.size,
    };
  }
  closeImageEditor();
}

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

  // Create or refresh URLs for new/updated attachments
  newAtts.forEach(att => {
    const status = att.status;
    switch (status) {
    case 'memory': {
      const existingUrl = attachmentUrls.value[att.id];
      // If we don't have a URL (newly added or just revoked in saveEditedImage), create one
      if (!existingUrl) {
        attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
      }
      break;
    }
    case 'persisted':
    case 'missing':
      break;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled status: ${_ex}`);
    }
    }
  });
}, { deep: true });

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

function triggerFileInput() {
  fileInputRef.value?.click();
}

async function processFiles(files: File[]) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    const attachmentId = generateId();
    const attachment: Attachment = {
      id: attachmentId,
      binaryObjectId: generateId(),
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

    if (!isAnimatingHeight.value) {
      nextTick(() => emit('scroll-to-bottom'));
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
        if (isMaximized.value) {
          emit('update:visibility', 'active');
        }
      });
    });

    // 4. Cleanup after animation
    setTimeout(() => {
      isAnimatingHeight.value = false;
    }, 400); // Slightly longer than 300ms transition
  }
}

function handleMouseEnter() {
  isHovered.value = true;
  switch (props.visibility) {
  case 'submerged':
    emit('update:visibility', 'peeking');
    break;
  case 'peeking':
  case 'active':
    break;
  default: {
    const _ex: never = props.visibility;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }
}

function handleMouseLeave() {
  isHovered.value = false;
  switch (props.visibility) {
  case 'peeking':
    emit('update:visibility', 'submerged');
    break;
  case 'submerged':
  case 'active':
    break;
  default: {
    const _ex: never = props.visibility;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }
}

function toggleSubmerged() {
  const current = props.visibility;
  switch (current) {
  case 'submerged':
    emit('update:visibility', 'active');
    nextTick(() => textareaRef.value?.focus());
    break;
  case 'peeking':
  case 'active':
    emit('update:visibility', 'submerged');
    isMaximized.value = false;
    textareaRef.value?.blur();
    break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }
}

async function handleGenerateImage() {
  if (!currentChat.value || (!input.value.trim() && attachments.value.length === 0) || props.isStreaming) return;

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
  if ((!input.value.trim() && attachments.value.length === 0) || props.isStreaming) return;

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

import { findDeepestLeaf } from '../utils/chat-tree';

watch(
  () => currentChat.value?.currentLeafId,
  (newLeafId) => {
    if (!newLeafId || !currentChat.value) return;

    const currentLeafInUrl = router.currentRoute.value.query.leaf;
    if (newLeafId !== currentLeafInUrl) {
      const query = { ...router.currentRoute.value.query };

      // If we are at the deepest leaf, we don't need the leaf param in URL
      // Use toRaw and cast to Chat to avoid deep-readonly type issues with findDeepestLeaf
      const rawChat = toRaw(currentChat.value) as Chat | null;
      if (rawChat && rawChat.root.items.length > 0) {
        const deepestLeaf = findDeepestLeaf(rawChat.root.items[rawChat.root.items.length - 1]!);
        if (newLeafId === deepestLeaf.id) {
          delete query.leaf;
        } else {
          query.leaf = newLeafId;
        }
      } else if (newLeafId) {
        query.leaf = newLeafId;
      }

      // If we are just loading the chat or there's no leaf in URL, use replace to avoid polluting history
      const method = !currentLeafInUrl ? 'replace' : 'push';
      router[method]({
        query
      });
    }
  }
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
        const currentVis = props.visibility;
        switch (currentVis) {
        case 'active':
          focusInput();
          break;
        case 'submerged':
        case 'peeking':
          break;
        default: {
          const _ex: never = currentVis;
          throw new Error(`Unhandled visibility: ${_ex}`);
        }
        }
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

function handleFocus() {
  isFocused.value = true;
  setActiveFocusArea('chat');
  emit('update:visibility', 'active');
}

function handleBlur() {
  isFocused.value = false;
  // We no longer automatically submerge on blur to keep it 'active'
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

  const currentVis = props.visibility;
  switch (currentVis) {
  case 'submerged':
  case 'peeking':
    emit('update:visibility', 'active');
    break;
  case 'active':
    break;
  default: {
    const _ex: never = currentVis;
    throw new Error(`Unhandled visibility: ${_ex}`);
  }
  }

  if (document.activeElement !== textareaRef.value) {
    nextTick(() => {
      textareaRef.value?.focus();
    });
  }
}

defineExpose({ focus: focusInput, input, applySuggestion, isMaximized, adjustTextareaHeight, processFiles, formatLabel,
  __testOnly: {
    attachments,
    editingAttachmentId,
    editingAttachment,
  }, });
</script>

<template>
  <div
    v-if="currentChat"
    class="absolute bottom-0 left-0 right-0 p-2 sm:p-3 bg-transparent pointer-events-none z-30 transition-transform duration-500 ease-in-out will-change-transform"
    :class="visibility === 'submerged' ? 'translate-y-[calc(100%-32px)] sm:translate-y-[calc(100%-40px)]' : 'translate-y-0'"
  >
    <!-- Glass Zone behind the input card (Full width blur) -->
    <div class="absolute inset-0 -z-10 glass-zone-mask" :class="{ 'opacity-0': visibility === 'submerged' }"></div>

    <div
      class="max-w-4xl mx-auto w-full pointer-events-auto relative group border border-gray-100 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all duration-300 flex flex-col"
      :class="[
        isMaximized || isAnimatingHeight ? 'shadow-2xl ring-1 ring-black/5 dark:ring-white/10' : 'shadow-lg group-hover:shadow-xl',
        visibility === 'submerged' ? 'cursor-pointer' : ''
      ]"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
      @click="visibility === 'submerged' ? handleFocus() : null"
    >
      <!-- Hit area extension: expands the interaction zone around the card to prevent jittering during transitions -->
      <div class="absolute -inset-x-4 -top-4 -bottom-16 pointer-events-auto -z-10" data-testid="hit-area-extension"></div>

      <!-- Attachment Previews -->
      <div v-if="attachments.length > 0" class="flex flex-wrap gap-2 px-4 pt-4" data-testid="attachment-preview">
        <div v-for="att in attachments" :key="att.id" class="relative group/att">
          <div class="bg-transparency-grid rounded-lg overflow-hidden" style="--grid-size: 10px;">
            <img
              :src="attachmentUrls[att.id]"
              class="w-20 h-20 object-cover border border-gray-200 dark:border-gray-700"
            />
          </div>
          <div class="absolute -top-2 -right-2 flex gap-1 opacity-0 group-hover/att:opacity-100 transition-opacity z-10">
            <button
              @click="openImageEditor({ id: att.id })"
              class="p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-blue-500 shadow-sm transition-colors touch-visible"
              title="Edit Image"
            >
              <Edit2 class="w-3 h-3" />
            </button>
            <button
              @click="removeAttachment(att.id)"
              class="p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-sm transition-colors touch-visible"
              title="Remove"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      <textarea
        ref="textareaRef"
        v-model="input"
        @input="adjustTextareaHeight"
        @paste="handlePaste"
        @focus="handleFocus"
        @blur="handleBlur"
        @click="setActiveFocusArea('chat')"
        @keydown.enter.ctrl.prevent="handleSend"
        @keydown.enter.meta.prevent="handleSend"
        @keydown.esc.prevent="isCurrentChatStreaming ? chatStore.abortChat() : null"
        placeholder="Type a message..."
        class="w-full text-base pl-5 pr-20 pt-4 pb-2 focus:outline-none bg-transparent text-gray-800 dark:text-gray-100 resize-none min-h-[84px] transition-colors"
        :class="{ 'animate-height': isAnimatingHeight }"
        data-testid="chat-input"
      ></textarea>

      <!-- Control Buttons inside input area -->
      <div class="absolute right-3 top-3 flex flex-col items-center gap-1.5 z-20">
        <button
          v-if="isOverLimit || isMaximized"
          @click.stop="toggleMaximized"
          class="p-1 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-700/50 transition-colors"
          :title="isMaximized ? 'Minimize Input' : 'Maximize Input'"
          data-testid="maximize-button"
        >
          <Minimize2 v-if="isMaximized" class="w-4 h-4" />
          <Maximize2 v-else class="w-4 h-4" />
        </button>

        <button
          @click.stop="toggleSubmerged"
          class="p-1 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-700/50 transition-colors"
          :title="visibility === 'submerged' ? 'Show Input' : 'Hide Input'"
          data-testid="submerge-button"
        >
          <ChevronUp v-if="visibility === 'submerged'" class="w-4 h-4" />
          <ChevronDown v-else class="w-4 h-4" />
        </button>

        <button
          @click.stop="openAdvancedEditor"
          class="p-1 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50/50 dark:hover:bg-gray-700/50 transition-colors"
          title="Open Advanced Editor"
          data-testid="open-advanced-editor-button"
        >
          <FileEdit class="w-4 h-4" />
        </button>
      </div>

      <div class="flex items-center justify-between px-4 pb-2" :class="{ 'pointer-events-none invisible': visibility === 'submerged' }">
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

    <!-- Image Editor Overlay -->
    <Teleport to="body">
      <ImageEditor
        v-if="editingAttachment"
        :image-url="attachmentUrls[editingAttachment.id]!"
        :file-name="editingAttachment.originalName"
        :original-mime-type="editingAttachment.mimeType"
        @cancel="closeImageEditor"
        @save="saveEditedImage"
      />
      <div v-if="isAdvancedEditorOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-10 bg-black/50 backdrop-blur-sm">
        <div class="w-full max-w-5xl h-full max-h-[90vh]">
          <AdvancedTextEditor
            :initial-value="input"
            :title="undefined"
            @update:content="handleAdvancedEditorUpdate"
            @close="closeAdvancedEditor"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
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
