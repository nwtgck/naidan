<script setup lang="ts">
import { ref } from 'vue';
import { GitForkIcon, PencilIcon, CopyIcon, CheckIcon, RefreshCwIcon, SendIcon, MoreVerticalIcon, HistoryIcon, MoreHorizontalIcon, LinkIcon } from 'lucide-vue-next';
import type { MessageNode, LmParameters } from '@/01-models/types';
import type { ChatId, MessageId } from '@/01-models/ids';
import { isImageGenerationPending } from '@/utils/image-generation';
import { generateMessageLink } from '@/utils/chat-links';
import { useToast } from '@/composables/useToast';
import { ensureStrings, lazyStrings } from '@/strings';
import SpeechControl from '../features/speech/components/SpeechControl.vue';
import MessageActionsMenu from './MessageActionsMenu.vue';
import SpeechLanguageSelector from '../features/speech/components/SpeechLanguageSelector.vue';

const props = defineProps<{
  chatId?: ChatId,
  message: MessageNode,
  isImageResponse: boolean,
  isUser: boolean,
  isGenerating: boolean,
  speechText: string,
  displayContent: string,
  showExtensions: boolean,
}>();

const emit = defineEmits<{
  (e: 'regenerate', messageId: MessageId): void,
  (e: 'edit', messageId: MessageId, content: string, lmParameters: LmParameters | undefined): void,
  (e: 'fork', messageId: MessageId): void,
  (e: 'enter-edit-mode'): void,
  (e: 'show-diff'): void,
  (e: 'update:showExtensions', val: boolean): void,
}>();

const copied = ref(false);
const showMoreMenu = ref(false);
const moreActionsTriggerRef = ref<HTMLElement | null>(null);
const { addToast } = useToast();

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

async function handleCopyLink() {
  if (!props.chatId) return;

  try {
    const url = generateMessageLink({ chatId: props.chatId, messageId: props.message.id });
    await navigator.clipboard.writeText(url);
    addToast({
      message: await ensureStrings.MessageActions__message_link_copied(),
      duration: 3000,
    });
  } catch (err) {
    console.error('Failed to copy message link: ', err);
    addToast({
      message: await ensureStrings.MessageActions__failed_to_copy_message_link(),
      duration: 5000,
    });
  }
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="flex items-center gap-1 group/msg-footer-tools">
    <!-- Generic More Button (Left Anchor for Footer) -->
    <button
      @click="emit('update:showExtensions', !showExtensions)"
      class="p-1.5 rounded-md transition-colors"
      :class="showExtensions ? 'text-blue-600 bg-blue-100/50 dark:bg-blue-800/50' : 'text-blue-600/40 dark:text-blue-400/40 hover:text-blue-600'"
      :title="lazyStrings.MessageActions__more_message_tools()"
    >
      <MoreHorizontalIcon class="w-3.5 h-3.5" />
    </button>

    <!-- Footer Extensions Slot (Seamless transition) -->
    <div v-if="showExtensions" class="flex items-center gap-1 mx-1 animate-in slide-in-from-right-1 fade-in duration-200">
      <SpeechLanguageSelector :message-id="message.id" :content="speechText" align="up" />
      <!-- Future tools here -->
    </div>

    <!-- Speech Controls -->
    <SpeechControl v-if="!isImageResponse && !isImageGenerationPending({ content: message.content || '' })" :message-id="message.id" :content="speechText" :is-generating="isGenerating" show-full-controls />

    <button
      v-if="!isUser"
      @click="emit('regenerate', message.id)"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      :title="lazyStrings.MessageActions__regenerate_response()"
      data-testid="regenerate-button"
    >
      <RefreshCwIcon class="w-3.5 h-3.5" />
    </button>
    <button
      v-if="isUser"
      @click="emit('edit', message.id, message.content || '', message.lmParameters)"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      :title="lazyStrings.MessageActions__resend_message()"
      data-testid="resend-button"
    >
      <SendIcon class="w-3.5 h-3.5" />
    </button>
    <button
      @click="handleCopy"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      :title="copied ? lazyStrings.MessageActions__copied() : lazyStrings.MessageActions__copy_message()"
      data-testid="copy-message-button"
    >
      <CheckIcon v-if="copied" class="w-3.5 h-3.5" />
      <CopyIcon v-else class="w-3.5 h-3.5" />
    </button>
    <button
      @click="emit('enter-edit-mode')"
      class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      :title="lazyStrings.MessageActions__edit_message()"
      data-testid="edit-message-button"
    >
      <PencilIcon class="w-3.5 h-3.5" />
    </button>

    <!-- More Actions Menu -->
    <div class="relative">
      <button
        ref="moreActionsTriggerRef"
        @click="showMoreMenu = !showMoreMenu"
        class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        :title="lazyStrings.MessageActions__more_actions()"
        data-testid="message-more-actions-button"
      >
        <MoreVerticalIcon class="w-3.5 h-3.5" />
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
          <GitForkIcon class="w-3.5 h-3.5" />
          <span>{{ lazyStrings.MessageActions__fork_chat() }}</span>
        </button>

        <button
          @click="handleCopyRaw(); showMoreMenu = false"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
          data-testid="copy-raw-button"
        >
          <CopyIcon class="w-3.5 h-3.5" />
          <span>{{ lazyStrings.MessageActions__copy_raw() }}</span>
        </button>

        <button
          v-if="chatId"
          @click="handleCopyLink(); showMoreMenu = false"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
          data-testid="copy-message-link-button"
        >
          <LinkIcon class="w-3.5 h-3.5" />
          <span>{{ lazyStrings.MessageActions__copy_link() }}</span>
        </button>

        <button
          @click="emit('show-diff'); showMoreMenu = false"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
          data-testid="compare-versions-button"
        >
          <HistoryIcon class="w-3.5 h-3.5" />
          <span>{{ lazyStrings.MessageActions__compare_versions() }}</span>
        </button>
      </MessageActionsMenu>
    </div>
  </div>
</template>
