import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useRecentChats } from './useRecentChats';
import { useOverlay } from './useOverlay';
import { toChatId } from '@/01-models/ids';

const initialChats = [
  { id: toChatId({ raw: 'chat1' }), title: 'Chat 1', updatedAt: 1000 },
  { id: toChatId({ raw: 'chat2' }), title: 'Chat 2', updatedAt: 2000 },
  { id: toChatId({ raw: 'chat3' }), title: null, updatedAt: 3000 },
];
const mockChats = ref([...initialChats]);

vi.mock('@/composables/chat/ui/useChatListData', () => ({
  useChatListData: () => ({
    chats: mockChats,
    TEST_ONLY: {},
  }),
}));

describe('useRecentChats Composable', () => {
  const {
    isRecentOpen,
    recentChats,
    mostRecentChat,
    openRecent,
    closeRecent,
    toggleRecent,
    addRecentChat,
    TEST_ONLY,
  } = useRecentChats();
  const { closeOverlay } = useOverlay();

  beforeEach(() => {
    closeOverlay();
    TEST_ONLY.recentChatEntries.value = [];
    mockChats.value = [...initialChats];
  });

  it('should track recent chats and exclude the latest one from switcher list', () => {
    addRecentChat({ id: toChatId({ raw: 'chat1' }) });
    addRecentChat({ id: toChatId({ raw: 'chat2' }) });

    // allRecentChats should have both in reverse order
    expect(TEST_ONLY.allRecentChats.value.map(c => c.id)).toEqual(['chat2', 'chat1']);

    // switcherRecentChats (recentChats) should exclude the first one
    expect(recentChats.value.map(c => c.id)).toEqual(['chat1']);
  });

  it('should only return existing chats', () => {
    addRecentChat({ id: toChatId({ raw: 'chat1' }) });
    addRecentChat({ id: toChatId({ raw: 'non-existent' }) });
    addRecentChat({ id: toChatId({ raw: 'chat2' }) });

    // Latest is chat2 (excluded), then non-existent (filtered out), then chat1
    expect(recentChats.value.map(c => c.id)).toEqual(['chat1']);
  });

  it('returns the last accessed valid chat even when a newer history entry was deleted', () => {
    addRecentChat({ id: toChatId({ raw: 'chat2' }) });
    addRecentChat({ id: toChatId({ raw: 'chat1' }) });
    addRecentChat({ id: toChatId({ raw: 'non-existent' }) });

    expect(mostRecentChat.value?.id).toBe('chat1');
    expect(recentChats.value.map(chat => chat.id)).toEqual(['chat2']);
  });

  it('reactively falls back to the next valid recent chat after deletion', () => {
    addRecentChat({ id: toChatId({ raw: 'chat1' }) });
    addRecentChat({ id: toChatId({ raw: 'chat2' }) });
    expect(mostRecentChat.value?.id).toBe('chat2');

    mockChats.value = mockChats.value.filter(chat => chat.id !== toChatId({ raw: 'chat2' }));
    expect(mostRecentChat.value?.id).toBe('chat1');
    expect(recentChats.value).toEqual([]);
  });

  it('returns no latest conversation without a valid history entry', () => {
    expect(mostRecentChat.value).toBeUndefined();
    addRecentChat({ id: toChatId({ raw: 'non-existent' }) });
    expect(mostRecentChat.value).toBeUndefined();
  });

  it('should move an existing recent chat to the top', () => {
    addRecentChat({ id: toChatId({ raw: 'chat1' }) });
    addRecentChat({ id: toChatId({ raw: 'chat2' }) });
    addRecentChat({ id: toChatId({ raw: 'chat3' }) });

    expect(TEST_ONLY.allRecentChats.value.map(c => c.id)).toEqual(['chat3', 'chat2', 'chat1']);

    addRecentChat({ id: toChatId({ raw: 'chat1' }) }); // Re-visit chat1
    expect(TEST_ONLY.allRecentChats.value.map(c => c.id)).toEqual(['chat1', 'chat3', 'chat2']);
  });

  it('should limit the number of recent chats', () => {
    for (let i = 0; i < 40; i++) {
      addRecentChat({ id: toChatId({ raw: `chat-${i}` }) });
    }
    expect(TEST_ONLY.recentChatEntries.value.length).toBe(32);
  });

  it('should manage overlay state correctly', () => {
    expect(isRecentOpen.value).toBe(false);
    openRecent();
    expect(isRecentOpen.value).toBe(true);
    closeRecent();
    expect(isRecentOpen.value).toBe(false);
    toggleRecent();
    expect(isRecentOpen.value).toBe(true);
    toggleRecent();
    expect(isRecentOpen.value).toBe(false);
  });
});
