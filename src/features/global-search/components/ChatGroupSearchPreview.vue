<script setup lang="ts">
import { useDocumentMetadata } from '@/composables/useDocumentMetadata';
import { ref, watch, computed, nextTick } from 'vue';
import { FolderIcon, MessageSquareIcon, ChevronRightIcon } from 'lucide-vue-next';
import type { ChatSummary } from '@/01-models/types';
import type { SearchResultItem } from '@/features/global-search/composables/useChatSearch';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import { useRouter } from 'vue-router';
import { scrollIntoViewSafe } from '@/utils/dom';
import SearchPreview from './SearchPreview.vue';
import { idToRaw } from '@/01-models/ids';
import type { ChatId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  groupId: string,
  groupName: string,
}>();

const router = useRouter();
const { openChat } = useChatNavigation();
const documentMetadata = useDocumentMetadata();
const { closeSearch, isSearchOpen, searchRequestId } = useGlobalSearch();
const { sidebarItems } = useCurrentChatState();

const chats = computed<ChatSummary[]>(() => {
  for (const item of sidebarItems.value) {
    if (item.type !== 'chat_group' || idToRaw({ id: item.chatGroup.id }) !== props.groupId) {
      continue;
    }
    return item.chatGroup.items
      .map(chatItem => chatItem.chat)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }
  return [];
});
const selectedChatId = ref<ChatId | null>(null);
const chatListContainer = ref<HTMLElement | null>(null);
const exposedSelectedChatId = computed(() => selectedChatId.value === null ? null : idToRaw({ id: selectedChatId.value }));

const selectedChat = computed(() => chats.value.find(c => c.id === selectedChatId.value) || null);

async function selectAndNavigate({ chatId }: { chatId: ChatId }) {
  const requestId = searchRequestId.value;
  const isCurrent = () => isSearchOpen.value && searchRequestId.value === requestId;
  documentMetadata?.finishHomeIntroduction();
  await openChat({ chatId, isCurrent }).catch((error: unknown) => {
    if (isCurrent()) {
      throw error;
    }
  });
  if (!isCurrent()) {
    return;
  }
  router.push(`/chat/${idToRaw({ id: chatId })}`);
  closeSearch();
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

function formatTime({ timestamp }: { timestamp: number }) {
  return timeFormatter.format(new Date(timestamp));
}

function navigate({ direction }: { direction: 'up' | 'down' }) {
  if (chats.value.length === 0) {
    return;
  }
  const currentIndex = chats.value.findIndex(c => c.id === selectedChatId.value);
  let nextIndex = currentIndex;

  switch (direction) {
  case 'up':
    nextIndex = Math.max(0, currentIndex - 1);
    break;
  case 'down':
    nextIndex = Math.min(chats.value.length - 1, currentIndex + 1);
    break;
  default: {
    const _ex: never = direction;
    throw new Error(`Unhandled direction: ${_ex}`);
  }
  }

  const nextChat = chats.value[nextIndex];
  if (nextChat) {
    selectedChatId.value = nextChat.id;
    // Ensure the selected item is visible
    nextTick(() => {
      if (!chatListContainer.value) {
        return;
      }
      const el = chatListContainer.value.querySelector(`[data-group-chat-id="${idToRaw({ id: nextChat.id })}"]`);
      if (el instanceof HTMLElement) {
        scrollIntoViewSafe({
          container: chatListContainer.value,
          element: el,
          block: 'nearest',
          behavior: 'instant',
        });
      }
    });
  }
}

function handleEnter() {
  if (selectedChatId.value) {
    selectAndNavigate({ chatId: selectedChatId.value });
  }
}

defineExpose({
  navigate,
  handleEnter,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      selectedChatId: exposedSelectedChatId,
    },
  }) || {}),
});

const selectedSearchResultItem = computed<Extract<SearchResultItem, { type: 'chat' }> | undefined>(() => {
  if (!selectedChat.value) {
    return undefined;
  }
  return {
    type: 'chat',
    chatId: idToRaw({ id: selectedChat.value.id }),
    title: selectedChat.value.title,
    updatedAt: selectedChat.value.updatedAt,
    matchType: 'title',
    contentMatches: [],
  };
});

watch(chats, nextChats => {
  if (nextChats.some(chat => chat.id === selectedChatId.value)) {
    return;
  }
  selectedChatId.value = nextChats[0]?.id ?? null;
}, { immediate: true });

</script>

<template>
  <div tw-class="h-full flex flex-col bg-white dark:bg-gray-900">
    <!-- Group Info Bar (Top) -->
    <div tw-class="px-4 py-3 border-b border-gray-200/80 dark:border-gray-800 flex flex-wrap items-center justify-between gap-2 bg-gray-50/80 dark:bg-gray-900 shrink-0">
      <div tw-class="flex items-center gap-2.5 min-w-0">
        <div tw-class="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg text-blue-500/60 shrink-0">
          <FolderIcon tw-class="w-5 h-5" />
        </div>
        <div tw-class="min-w-0">
          <h3 tw-class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{{ groupName }}</h3>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ lazyStrings.ChatGroupSearchPreview__group_preview() }}</p>
        </div>
      </div>
      <div tw-class="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-md shrink-0 tabular-nums">
        {{ lazyStrings.ChatGroupSearchPreview__chat_count({ count: chats.length }) }}
      </div>
    </div>

    <!-- Main Content Area -->
    <div tw-class="flex-1 flex overflow-hidden">
      <!-- Left: Chat List inside Group -->
      <div tw-class="w-64 border-r border-gray-200/80 dark:border-gray-800 flex flex-col overflow-hidden bg-gray-50/50 dark:bg-gray-950/20 shrink-0">
        <div v-if="chats.length === 0" tw-class="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <MessageSquareIcon tw-class="w-6 h-6 text-gray-400 dark:text-gray-500 mb-3" />
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ChatGroupSearchPreview__empty_group() }}</p>
        </div>
        <div v-else ref="chatListContainer" class="scrollbar-hide" tw-class="flex-1 overflow-y-auto p-2 space-y-1">
          <div
            v-for="chat in chats"
            :key="idToRaw({ id: chat.id })"
            @click="selectedChatId = chat.id"
            :data-group-chat-id="idToRaw({ id: chat.id })"
            :tw-class="['w-full min-h-14 flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors cursor-pointer group relative overflow-hidden shrink-0', selectedChatId === chat.id
              ? 'bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-600/70'
              : 'hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-transparent']"
          >
            <div tw-class="shrink-0 text-gray-400">
              <MessageSquareIcon tw-class="w-4 h-4" />
            </div>

            <div tw-class="flex-1 min-w-0 flex flex-col justify-center">
              <span :tw-class="['text-sm font-medium truncate', selectedChatId === chat.id ? 'text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300']">
                {{ chat.title || lazyStrings.SHARED__new_chat() }}
              </span>
              <span tw-class="text-[11px] text-gray-500 dark:text-gray-400 truncate tabular-nums mt-0.5">{{ formatTime({ timestamp: chat.updatedAt }) }}</span>
            </div>

            <!-- Action Button (Doesn't change layout height) -->
            <button
              @click.stop="selectAndNavigate({ chatId: chat.id })"
              tw-class="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-white dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 transition-opacity"
              :title="lazyStrings.ChatGroupSearchPreview__open_chat()"
            >
              <ChevronRightIcon tw-class="w-3.5 h-3.5" />
            </button>

            <!-- Selection Indicator -->
            <div v-if="selectedChatId === chat.id" tw-class="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-blue-500/70 dark:bg-blue-400/70"></div>
          </div>
        </div>
      </div>

      <!-- Right: Detailed Chat Preview -->
      <div tw-class="flex-1 overflow-hidden relative bg-white dark:bg-gray-900">
        <SearchPreview
          v-if="selectedSearchResultItem"
          :chat="selectedSearchResultItem"
        />
        <div v-else tw-class="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 p-6 text-center text-sm leading-relaxed">
          {{ lazyStrings.ChatGroupSearchPreview__select_a_chat_to_preview() }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
