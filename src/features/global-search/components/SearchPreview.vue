<script setup lang="ts">
import { ref, shallowRef, watch, computed, onUnmounted } from 'vue';
import type { ContentMatch, SearchResultItem } from '@/features/global-search/composables/useChatSearch';
import { GitBranchIcon, Loader2Icon, MessageSquareIcon } from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import { getChatBranchIterator } from '@/logic/chat-tree';
import type { MessageNode, ChatContent } from '@/01-models/types';
import { useSettings } from '@/composables/useSettings';
import { lazyStrings } from '@/strings';
import MessageItem from '@/components/MessageItem.vue';
import { idToRaw, toChatId, toMessageId } from '@/01-models/ids';
import type { ChatId } from '@/01-models/ids';
import { resolveSearchPreviewMessageWindow } from '@/features/global-search/logic/preview-context';

const props = defineProps<{
  match?: ContentMatch,
  chat?: Extract<SearchResultItem, { type: 'chat' }>,
}>();

const { searchContextSize } = useSettings();
const isLoading = ref(false);
const branchMessages = shallowRef<MessageNode[]>([]);
const matchedIndex = ref(-1);

let activeRequestId = 0;

async function loadContext() {
  const requestId = ++activeRequestId;
  const chatId = props.match?.chatId || props.chat?.chatId;
  branchMessages.value = [];
  matchedIndex.value = -1;

  if (!chatId) {
    isLoading.value = false;
    return;
  }

  isLoading.value = true;
  try {
    const content = await storageService.loadChatContent({ id: toChatId({ raw: chatId }) });
    if (requestId !== activeRequestId || content === null) {
      return;
    }

    const targetLeafId = props.match?.targetLeafId === undefined
      ? content.currentLeafId
      : toMessageId({ raw: props.match.targetLeafId });
    const virtualContent: ChatContent = {
      ...content,
      currentLeafId: targetLeafId,
    };
    const branch = Array.from(getChatBranchIterator({ chat: virtualContent }));
    if (requestId !== activeRequestId) {
      return;
    }

    branchMessages.value = branch;
    matchedIndex.value = props.match === undefined
      ? -1
      : branch.findIndex(message => idToRaw({ id: message.id }) === props.match?.messageId);
  } catch (error) {
    if (requestId === activeRequestId) {
      console.error('Failed to load context for search preview:', error);
    }
  } finally {
    if (requestId === activeRequestId) {
      isLoading.value = false;
    }
  }
}

watch(
  () => [
    props.match?.chatId,
    props.match?.messageId,
    props.match?.targetLeafId,
    props.chat?.chatId,
  ] as const,
  loadContext,
  { immediate: true },
);

onUnmounted(() => {
  activeRequestId++;
  branchMessages.value = [];
});

const visibleMessageWindow = computed(() => resolveSearchPreviewMessageWindow({
  messageCount: branchMessages.value.length,
  matchedIndex: props.match === undefined ? undefined : matchedIndex.value,
  contextSize: searchContextSize.value,
}));

const visibleMessages = computed(() => branchMessages.value.slice(
  visibleMessageWindow.value.start,
  visibleMessageWindow.value.end,
));

const hasPreviousMessages = computed(() => visibleMessageWindow.value.start > 0);

const hasFollowingMessages = computed(() => (
  visibleMessageWindow.value.end < branchMessages.value.length
));

const previewChatId = computed<ChatId | undefined>(() => {
  const raw = props.match?.chatId || props.chat?.chatId;
  return raw === undefined ? undefined : toChatId({ raw });
});

// Dummy handlers for MessageItem
const handleDummy = () => {};


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="h-full flex flex-col bg-gray-50 dark:bg-gray-900">
    <div v-if="!match && !chat" tw-class="flex-1 flex items-center justify-center text-gray-500 dark:text-gray-400 p-6 text-center">
      <div tw-class="flex flex-col items-center gap-3">
        <div tw-class="p-3 bg-gray-100 dark:bg-gray-800 rounded-xl">
          <MessageSquareIcon tw-class="w-6 h-6 text-gray-400 dark:text-gray-500" />
        </div>
        <span tw-class="text-sm leading-relaxed">{{ lazyStrings.SearchPreview__select_an_item_to_preview() }}</span>
      </div>
    </div>

    <!-- Loading State -->
    <div v-else-if="isLoading" tw-class="flex-1 flex items-center justify-center text-gray-400">
      <Loader2Icon tw-class="w-6 h-6 animate-spin" />
    </div>

    <!-- Message Preview (Both for Match and Chat) -->
    <div v-else-if="match || chat" tw-class="flex-1 flex flex-col overflow-hidden">
      <!-- Context Header -->
      <div tw-class="px-4 py-3 border-b border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900 flex flex-wrap justify-between items-center gap-2 shrink-0">
        <div tw-class="flex flex-col gap-1 min-w-0 overflow-hidden">
          <h3 v-if="chat" tw-class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{{ chat.title || lazyStrings.SHARED__new_chat() }}</h3>
          <div tw-class="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{{ match ? lazyStrings.SearchPreview__conversation_match() : lazyStrings.SearchPreview__recent_history() }}</span>
            <span tw-class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[11px] tabular-nums">{{ lazyStrings.SearchPreview__message_count({ count: visibleMessages.length }) }}</span>
          </div>
        </div>

        <div v-if="match && !match.isCurrentThread" tw-class="flex items-center gap-1.5 text-[11px] bg-amber-50 dark:bg-amber-400/5 text-amber-700 dark:text-amber-400/80 px-2 py-1 rounded-md border border-amber-200/60 dark:border-amber-400/15">
          <GitBranchIcon tw-class="w-3 h-3" />
          <span>{{ lazyStrings.SearchPreview__alt_branch() }}</span>
        </div>
      </div>

      <div tw-class="flex-1 overflow-y-auto bg-white dark:bg-gray-900">
        <div v-if="hasPreviousMessages" tw-class="p-4 text-center">
          <span tw-class="text-xs text-gray-400 dark:text-gray-500">{{ lazyStrings.SearchPreview__previous_messages() }}</span>
        </div>

        <div v-for="msg in visibleMessages" :key="idToRaw({ id: msg.id })" tw-class="relative">
          <div v-if="match && idToRaw({ id: msg.id }) === match.messageId" tw-class="absolute inset-0 bg-blue-50/60 dark:bg-blue-400/5 border-y border-blue-200/60 dark:border-blue-400/15 pointer-events-none z-0"></div>
          <MessageItem
            :chat-id="previewChatId!"
            :message="msg"
            :endpoint="undefined"
            :tw-class="['relative z-10', { 'opacity-65': match && idToRaw({ id: msg.id }) !== match.messageId }]"
            @fork="handleDummy"
            @edit="handleDummy"
            @switch-version="handleDummy"
            @regenerate="handleDummy"
          />
        </div>

        <div v-if="hasFollowingMessages" tw-class="p-4 text-center">
          <span tw-class="text-xs text-gray-400 dark:text-gray-500">{{ lazyStrings.SearchPreview__following_messages() }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../../style.css";

/* Ensure the preview area looks distinct but matches the main chat style */
:deep(.group) {
  @apply !border-none;
}
</style>
