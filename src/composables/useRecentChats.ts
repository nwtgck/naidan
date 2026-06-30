import { ref, computed, type ComputedRef, type Ref } from 'vue';
import { useChatListData } from '@/composables/chat/ui/useChatListData';
import type { ChatId } from '@/01-models/ids';
import { useOverlay } from './useOverlay';
import type { ChatSummary } from '@/01-models/types';

export interface RecentChatEntry {
  id: ChatId,
  accessedAt: number,
}

export interface RecentChatWithAccess extends ChatSummary {
  accessedAt: number,
}

export interface UseRecentChatsResult {
  isRecentOpen: ComputedRef<boolean>,
  recentChats: ComputedRef<RecentChatWithAccess[]>,
  openRecent: () => void,
  closeRecent: () => void,
  toggleRecent: () => void,
  addRecentChat: ({ id }: { id: ChatId }) => void,
  TEST_ONLY: {
    recentChatEntries: Ref<RecentChatEntry[]>,
    allRecentChats: ComputedRef<RecentChatWithAccess[]>,
  },
}

const activeOverlay = useOverlay().activeOverlay;
const _openOverlay = useOverlay().openOverlay;
const _closeOverlay = useOverlay().closeOverlay;
const _toggleOverlay = useOverlay().toggleOverlay;

const isRecentOpen = computed(() => activeOverlay.value === 'recent');
const recentChatEntries = ref<RecentChatEntry[]>([]);
const MAX_RECENT_CHATS = 32;

export function useRecentChats(): UseRecentChatsResult {
  const { chats } = useChatListData();

  const openRecent = () => {
    _openOverlay({ type: 'recent' });
  };

  const closeRecent = () => {
    const overlay = activeOverlay.value;
    switch (overlay) {
    case 'recent':
      _closeOverlay();
      break;
    case 'search':
    case 'none':
      break;
    default: {
      const _ex: never = overlay;
      throw new Error(`Unhandled overlay: ${_ex}`);
    }
    }
  };

  const toggleRecent = () => {
    _toggleOverlay({ type: 'recent' });
  };

  const addRecentChat = ({ id }: { id: ChatId }) => {
    const now = Date.now();
    const index = recentChatEntries.value.findIndex(e => e.id === id);
    if (index !== -1) {
      recentChatEntries.value.splice(index, 1);
    }
    recentChatEntries.value.unshift({ id, accessedAt: now });
    if (recentChatEntries.value.length > MAX_RECENT_CHATS) {
      recentChatEntries.value.pop();
    }
  };

  const recentChats = computed(() => {
    // Filter to ensure only existing chats are returned and include accessedAt
    return recentChatEntries.value
      .map(entry => {
        const chat = chats.value.find(chat => chat.id === entry.id);
        return chat ? { ...chat, accessedAt: entry.accessedAt } : undefined;
      })
      .filter((chat): chat is RecentChatWithAccess => chat !== undefined);
  });

  const switcherRecentChats = computed(() => {
    // Exclude the most recent one (typically the current chat)
    return recentChats.value.slice(1);
  });

  return {
    isRecentOpen,
    recentChats: switcherRecentChats,
    openRecent,
    closeRecent,
    toggleRecent,
    addRecentChat,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        recentChatEntries,
        allRecentChats: recentChats,
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
