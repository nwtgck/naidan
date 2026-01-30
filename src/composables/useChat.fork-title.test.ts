import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { reactive } from 'vue';
import type { Chat, MessageNode } from '../models/types';
import { storageService } from '../services/storage';

vi.mock('../services/storage', () => ({
  storageService: {
    updateChatContent: vi.fn(),
    updateChatMeta: vi.fn(),
    updateHierarchy: vi.fn(async (cb) => {
      const mockHierarchy = { items: [] };
      return cb(mockHierarchy);
    }),
    loadChat: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    deleteChat: vi.fn(),
    saveSettings: vi.fn(),
    loadSettings: vi.fn().mockResolvedValue(null),
    updateChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    loadChatGroups: vi.fn().mockResolvedValue([]),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    notify: vi.fn(),
    updateChatContentImmediate: vi.fn(),
    updateChatMetaImmediate: vi.fn(),
    subscribeToChanges: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    loadChatMeta: vi.fn(),
    loadChatContent: vi.fn(),
  }
}));

// Mock useToast to avoid issues with dynamic imports/mocking
vi.mock('./useToast', () => ({
  useToast: () => ({
    addToast: vi.fn()
  })
}));

describe('useChat fork title fix', () => {
  const { forkChat, __testOnly } = useChat();
  const { __testOnlySetCurrentChat } = __testOnly;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use "Fork of New Chat" when the original chat title is null', async () => {
    const m1: MessageNode = { id: 'm1', role: 'user', content: 'hi', replies: { items: [] }, timestamp: 0 };
    const untitledChat: Chat = { 
      id: 'c1', 
      title: null, 
      root: { items: [m1] }, 
      createdAt: 0, 
      updatedAt: 0, 
      debugEnabled: false,
    };
    
    __testOnlySetCurrentChat(reactive(untitledChat) as any);
    
    const newId = await forkChat('m1');

    expect(newId).toBeDefined();
    
    // Find the updateChatMeta call for the new chat
    const updaterCall = vi.mocked(storageService.updateChatMeta).mock.calls.find((call: any[]) => call[0] === newId);
    expect(updaterCall).toBeDefined();
    
    const metaUpdater = updaterCall![1];
    const resultMeta = await (metaUpdater as any)({});
    
    expect(resultMeta.title).toBe('Fork of New Chat');
  });

  it('should still use the original title when it is present', async () => {
    const m1: MessageNode = { id: 'm1', role: 'user', content: 'hi', replies: { items: [] }, timestamp: 0 };
    const titledChat: Chat = { 
      id: 'c1', 
      title: 'Original Title', 
      root: { items: [m1] }, 
      createdAt: 0, 
      updatedAt: 0, 
      debugEnabled: false,
    };
    
    __testOnlySetCurrentChat(reactive(titledChat) as any);
    
    const newId = await forkChat('m1');

    const updaterCall = vi.mocked(storageService.updateChatMeta).mock.calls.find((call: any[]) => call[0] === newId);
    const metaUpdater = updaterCall![1];
    const resultMeta = await (metaUpdater as any)({});
    
    expect(resultMeta.title).toBe('Fork of Original Title');
  });
});