import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive, triggerRef } from 'vue';
import type { Chat, SidebarItem } from '../models/types';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))),
    loadChatContent: vi.fn().mockResolvedValue(null),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    notify: vi.fn(),
  },
}));

// Mock settings
const mockSettings = {
  endpointType: 'openai' as const,
  endpointUrl: 'http://localhost',
  storageType: 'local' as const,
  autoTitleEnabled: true,
  defaultModelId: 'gpt-3.5-turbo',
};

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: mockSettings },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

// Mock LLM Provider
const mockChat = vi.fn().mockImplementation(async (params: { model: string, onChunk: (chunk: string) => void }) => {
  params.onChunk('Response from ' + params.model);
});

vi.mock('../services/llm', () => {
  class MockOpenAI {
    constructor() {}
    chat = mockChat;
    listModels = vi.fn().mockResolvedValue(['gpt-3.5-turbo', 'gpt-4']);
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn(),
  };
});

describe('useChat Model ID Persistence & Resolution', () => {
  const chatStore = useChat();
  const { sendMessage, currentChat, activeMessages, __testOnly, updateChatModel } = chatStore;
  const { __testOnlySetCurrentChat } = __testOnly;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRootItems.length = 0;
    
    vi.mocked(storageService.loadChat).mockImplementation((id) => {
      if (id === 'c1') return Promise.resolve({ id: 'c1', title: 'C1', modelId: 'm1', root: { items: [] } } as any);
      return Promise.resolve(null);
    });
  });

  it('should persist different modelIds for each assistant message when model is changed', async () => {
    // 1. Setup a chat with initial model
    const chatObj: Chat = reactive({
      id: 'model-test-chat',
      title: 'Model Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat(chatObj);

    // 2. Send first message with default model
    await sendMessage('Hello with 3.5');
    await vi.waitUntil(() => !chatStore.streaming.value);
    triggerRef(currentChat);
    
    expect(activeMessages.value).toHaveLength(2);
    expect(activeMessages.value[1]?.role).toBe('assistant');
    expect(activeMessages.value[1]?.modelId).toBe('gpt-3.5-turbo');
    expect(activeMessages.value[1]?.content).toContain('Response from gpt-3.5-turbo');

    // 3. Change the model for the chat
    await updateChatModel(chatObj.id, 'gpt-4');
    
    // 4. Send second message with new model
    await sendMessage('Hello with 4');
    await vi.waitUntil(() => !chatStore.streaming.value);
    triggerRef(currentChat);

    expect(activeMessages.value).toHaveLength(4);
    
    // Check first assistant message still has old model
    expect(activeMessages.value[1]?.modelId).toBe('gpt-3.5-turbo');
    
    // Check second assistant message has new model
    expect(activeMessages.value[3]?.role).toBe('assistant');
    expect(activeMessages.value[3]?.modelId).toBe('gpt-4');
    expect(activeMessages.value[3]?.content).toContain('Response from gpt-4');

    // 5. Verify storage was called with correct modelIds in the tree
    expect(storageService.updateChatContent).toHaveBeenCalled();
    const lastCall = vi.mocked(storageService.updateChatContent).mock.calls[vi.mocked(storageService.updateChatContent).mock.calls.length - 1];
    const updater = lastCall![1];
    const lastSavedContent = await (updater as any)(null);
    
    // Path: root -> user1 -> assistant1 (gpt-3.5) -> user2 -> assistant2 (gpt-4)
    const assistant1 = lastSavedContent.root.items[0]?.replies.items[0];
    const assistant2 = assistant1?.replies.items[0]?.replies.items[0];
    
    expect(assistant1?.modelId).toBe('gpt-3.5-turbo');
    expect(assistant2?.modelId).toBe('gpt-4');
  });
});