import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import type { Chat, Hierarchy } from '../models/types';

/**
 * Multi-Tab Scenario Tests
 * 
 * These tests focus on discovering and preventing bugs related to cross-tab 
 * concurrency and Read-Modify-Write race conditions.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    mockChatStorage: new Map<string, any>(),
    mockHierarchy: { items: [] } as Hierarchy,
  }
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockImplementation(() => Promise.resolve(Array.from(mocks.mockChatStorage.values()))),
    loadChat: vi.fn().mockImplementation(async (id) => {
      const chat = mocks.mockChatStorage.get(id);
      if (!chat) return null;
      return JSON.parse(JSON.stringify(chat));
    }),
    loadChatMeta: vi.fn().mockImplementation((id) => Promise.resolve(mocks.mockChatStorage.get(id) || null)),
    updateChatMeta: vi.fn().mockImplementation(async (id, updater) => {
      const current = mocks.mockChatStorage.get(id) || null;
      const updatedMeta = await updater(current ? JSON.parse(JSON.stringify(current)) : null);
      if (current) {
        const full = { ...current, ...updatedMeta };
        mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(full)));
      } else {
        mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(updatedMeta)));
      }
      return Promise.resolve();
    }),
    updateChatContent: vi.fn().mockImplementation(async (id, updater) => {
      const current = mocks.mockChatStorage.get(id) || null;
      const existingContent = current ? { root: current.root, currentLeafId: current.currentLeafId } : { root: { items: [] } };
      const updatedContent = await updater(existingContent);
      if (current) {
        const full = { ...current, ...updatedContent };
        mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(full)));
      } else {
        mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(updatedContent)));
      }
      return Promise.resolve();
    }),
    loadHierarchy: vi.fn().mockImplementation(() => Promise.resolve(JSON.parse(JSON.stringify(mocks.mockHierarchy)))),
    updateHierarchy: vi.fn().mockImplementation(async (updater) => {
      mocks.mockHierarchy = await updater(mocks.mockHierarchy);
      return Promise.resolve();
    }),
    deleteChat: vi.fn().mockImplementation((id) => {
      mocks.mockChatStorage.delete(id);
      return Promise.resolve();
    }),
    updateChatGroup: vi.fn().mockResolvedValue(undefined),
    getSidebarStructure: vi.fn().mockImplementation(async () => []),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: false, defaultModelId: 'gpt-4', lmParameters: {}, providerProfiles: [] } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('./useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock('./useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

vi.mock('../services/llm', () => ({
  OpenAIProvider: function() { return { chat: vi.fn().mockImplementation((_m, _mo, _u, onChunk) => onChunk('OK')), listModels: vi.fn().mockResolvedValue(['gpt-4']) }; },
  OllamaProvider: function() { return { chat: vi.fn(), listModels: vi.fn() }; },
}));

describe('useChat Multi-Tab Integration Scenarios (BUG FINDING)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockChatStorage.clear();
    mocks.mockHierarchy = { items: [] };
  });

  /**
   * BUG PROOF: This test demonstrates that two tabs editing the same chat 
   * will result in data loss because useChat uses a local Read-Modify-Write cycle.
   * 
   * Fixed by implementing storageService.updateChatContent(id, (current) => ...)
   * and using it in regenerateMessage, editMessage, and sendMessage.
   */
  it('Scenario: Two tabs branching from the same message simultaneously', async () => {
    const chatStoreA = useChat();
    const chatStoreB = useChat();

    // Setup Chat 1 with one user message and one assistant message
    const chat1: Chat = { 
      id: 'c1', title: 'C1', 
      root: { items: [{ 
        id: 'm1', role: 'user', content: 'Hi', timestamp: 0,
        replies: { items: [{ id: 'm2', role: 'assistant', content: 'Hello', replies: { items: [] }, timestamp: 0 }] } 
      }] },
      createdAt: 0, updatedAt: 0, debugEnabled: false, currentLeafId: 'm2'
    };
    mocks.mockChatStorage.set('c1', chat1);

    // Both tabs open Chat 1. They now both have a LOCAL COPY of the message tree.
    await chatStoreA.openChat('c1');
    await chatStoreB.openChat('c1');

    // 1. Tab A adds a branch (Branch A). It modifies its local currentChat and calls updateChatContent.
    await chatStoreA.regenerateMessage('m2'); 
    const chatAfterA = mocks.mockChatStorage.get('c1');
    expect(chatAfterA.root.items[0].replies.items).toHaveLength(2);
    const branchAId = chatAfterA.root.items[0].replies.items[1].id;

    // 2. Tab B adds a branch (Branch B). 
    await chatStoreB.regenerateMessage('m2');

    // 3. Verification: Branch A is lost.
    const finalChat = mocks.mockChatStorage.get('c1');
    
    // If fixed, this should be 3 (original m2 + Tab A's branch + Tab B's branch).
    expect(finalChat.root.items[0].replies.items).toHaveLength(3);
    expect(finalChat.root.items[0].replies.items.map((i: any) => i.id)).toContain(branchAId);
  });

  it('Scenario: Tab A renames chat while Tab B is generating response', async () => {
    const chatStoreA = useChat();
    const chatStoreB = useChat();

    const chat1: Chat = { 
      id: 'c1', title: 'Original Title', 
      root: { items: [{ id: 'm1', role: 'user', content: 'Hi', replies: { items: [] }, timestamp: 0 }] },
      createdAt: 0, updatedAt: 0, debugEnabled: false, currentLeafId: 'm1'
    };
    mocks.mockChatStorage.set('c1', chat1);

    await chatStoreA.openChat('c1');
    await chatStoreB.openChat('c1');

    // 1. Tab B starts generating (Slow)
    let resolveGen: () => void;
    const genP = new Promise<void>(r => resolveGen = r);
    vi.mocked(storageService.updateChatContent).mockImplementation(async (id, updater) => {
      await genP;
      const current = mocks.mockChatStorage.get(id) || null;
      const updated = await updater(current);
      mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(updated)));
    });

    const sendP = chatStoreB.sendMessage('Reply to me');

    // 2. Tab A renames the chat
    // This updates the ChatMeta
    await chatStoreA.renameChat('c1', 'New Title');
    expect(mocks.mockChatStorage.get('c1').title).toBe('New Title');

    // 3. Tab B finishes generating and saves content
    // BUG POTENTIAL: Does saveChatContent in useChat.ts also include meta?
    // In our implementation, sendMessage calls saveChatContent AND THEN saveChatMeta.
    resolveGen!();
    await sendP;

    // 4. Verification: Title should still be "New Title"
    const finalChat = mocks.mockChatStorage.get('c1');
    expect(finalChat.title).toBe('New Title');
  });
});