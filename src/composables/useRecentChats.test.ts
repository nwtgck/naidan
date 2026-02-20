import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useRecentChats } from './useRecentChats';
import { useOverlay } from './useOverlay';

// Mock useChat
const mockChats = ref([
  { id: 'chat1', title: 'Chat 1', updatedAt: 1000 },
  { id: 'chat2', title: 'Chat 2', updatedAt: 2000 },
  { id: 'chat3', title: null, updatedAt: 3000 },
]);

vi.mock('./useChat', () => ({
  useChat: () => ({
    chats: mockChats,
    openChat: vi.fn(),
  }),
}));

describe('useRecentChats Composable', () => {
  const {
    isRecentOpen,
    recentChats,
    openRecent,
    closeRecent,
    toggleRecent,
    addRecentChat,
    __testOnly
  } = useRecentChats();
  const { closeOverlay } = useOverlay();

  beforeEach(() => {
    closeOverlay();
    __testOnly.recentChatEntries.value = [];
  });

  it('should track recent chats and exclude the latest one from switcher list', () => {
    addRecentChat({ id: 'chat1' });
    addRecentChat({ id: 'chat2' });

    // allRecentChats should have both in reverse order
    expect(__testOnly.allRecentChats.value.map(c => c.id)).toEqual(['chat2', 'chat1']);

    // switcherRecentChats (recentChats) should exclude the first one
    expect(recentChats.value.map(c => c.id)).toEqual(['chat1']);
  });

  it('should only return existing chats', () => {
    addRecentChat({ id: 'chat1' });
    addRecentChat({ id: 'non-existent' });
    addRecentChat({ id: 'chat2' });

    // Latest is chat2 (excluded), then non-existent (filtered out), then chat1
    expect(recentChats.value.map(c => c.id)).toEqual(['chat1']);
  });

  it('should move an existing recent chat to the top', () => {
    addRecentChat({ id: 'chat1' });
    addRecentChat({ id: 'chat2' });
    addRecentChat({ id: 'chat3' });

    expect(__testOnly.allRecentChats.value.map(c => c.id)).toEqual(['chat3', 'chat2', 'chat1']);

    addRecentChat({ id: 'chat1' }); // Re-visit chat1
    expect(__testOnly.allRecentChats.value.map(c => c.id)).toEqual(['chat1', 'chat3', 'chat2']);
  });

  it('should limit the number of recent chats', () => {
    for (let i = 0; i < 40; i++) {
      addRecentChat({ id: `chat-${i}` });
    }
    expect(__testOnly.recentChatEntries.value.length).toBe(32);
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
