<script setup lang="ts">
import { ref } from 'vue';
import { GitFork, Pencil, Copy, Check, RefreshCw, Send, MoreVertical, History, MoreHorizontal } from 'lucide-vue-next';
import type { MessageNode, LmParameters } from '../models/types';
import { isImageGenerationPending } from '../utils/image-generation';
import SpeechControl from './SpeechControl.vue';
import MessageActionsMenu from './MessageActionsMenu.vue';
import SpeechLanguageSelector from './SpeechLanguageSelector.vue';

const props = defineProps<{
  message: MessageNode;
  isImageResponse: boolean;
  isUser: boolean;
  isGenerating: boolean;
  speechText: string;
  displayContent: string;
  showExtensions: boolean;
}>();

const emit = defineEmits<{
  (e: 'regenerate', messageId: string): void;
  (e: 'edit', messageId: string, content: string, lmParameters: LmParameters | undefined): void;
  (e: 'fork', messageId: string): void;
  (e: 'enter-edit-mode'): void;
  (e: 'show-diff'): void;
  (e: 'update:showExtensions', val: boolean): void;
}>();

const copied = ref(false);
const showMoreMenu = ref(false);
const moreActionsTriggerRef = ref<HTMLElement | null>(null);

async function handleCopy() {
  try {
    await navigator.clipboard.writeText(props.displayContent);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
}

async function handleCopyRaw() {
  try {
    await navigator.clipboard.writeText(props.message.content || '');
    // Use a temporary visual feedback or just close the menu
    // For now, let's just close the menu which is handled by the click
  } catch (err) {
    console.error('Failed to copy raw text: ', err);
  }
}

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex items-center gap-1 group/msg-footer-tools">
    <!-- Generic More Button (Left Anchor for Footer) -->
    <button
      @click="emit('update:showExtensions', !showExtensions)"
      class="p-1.5 rounded-md transition-colors"
      :class="showExtensions ? 'text-blue-600 bg-blue-100/50 dark:bg-blue-800/50' : 'text-blue-600/40 dark:text-blue-400/40 hover:text-blue-600'"
      title="More Message Tools"
    >
      <MoreHorizontal class="w-3.5 h-3.5" />
    </button>

    <!-- Footer Extensions Slot (Seamless transition) -->
    <div v-if="showExtensions" class="flex items-center gap-1 mx-1 animate-in slide-in-from-right-1 fade-in duration-200">
      <SpeechLanguageSelector :message-id="message.id" :content="speechText" align="up" />
      <!-- Future tools here -->
    </div>

    <!-- Speech Controls -->
    <SpeechControl v-if="!isImageResponse && !isImageGenerationPending(message.content || '')" :message-id="message.id" :content="speechText" :is-generating="isGenerating" show-full-controls />

    <button
      v-if="!isUser"
      @click="emit('regenerate', message.id)"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      title="Regenerate response"
      data-testid="regenerate-button"
    >
      <RefreshCw class="w-3.5 h-3.5" />
    </button>
    <button
      v-if="isUser"
      @click="emit('edit', message.id, message.content || '', message.lmParameters)"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      title="Resend message"
      data-testid="resend-button"
    >
      <Send class="w-3.5 h-3.5" />
    </button>
    <button
      @click="handleCopy"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      :title="copied ? 'Copied!' : 'Copy message'"
      data-testid="copy-message-button"
    >
      <Check v-if="copied" class="w-3.5 h-3.5" />
      <Copy v-else class="w-3.5 h-3.5" />
    </button>
    <button
      @click="emit('enter-edit-mode')"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      title="Edit message"
      data-testid="edit-message-button"
    >
      <Pencil class="w-3.5 h-3.5" />
    </button>

    <!-- More Actions Menu -->
    <div class="relative">
      <button
        ref="moreActionsTriggerRef"
        @click="showMoreMenu = !showMoreMenu"
        class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        title="More actions"
        data-testid="message-more-actions-button"
      >
        <MoreVertical class="w-3.5 h-3.5" />
      </button>

      <MessageActionsMenu
        :is-open="showMoreMenu"
        :trigger-el="moreActionsTriggerRef"
        @close="showMoreMenu = false"
      >
        <button
          @click="emit('fork', message.id); showMoreMenu = false"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
          data-testid="fork-message-button"
        >
          <GitFork class="w-3.5 h-3.5" />
          <span>Fork Chat</span>
        </button>

        <button
          @click="handleCopyRaw(); showMoreMenu = false"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
          data-testid="copy-raw-button"
        >
          <Copy class="w-3.5 h-3.5" />
          <span>Copy Raw</span>
        </button>

        <button
          @click="emit('show-diff'); showMoreMenu = false"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
          data-testid="compare-versions-button"
        >
          <History class="w-3.5 h-3.5" />
          <span>Compare Versions</span>
        </button>
      </MessageActionsMenu>
    </div>
  </div>
</template>
