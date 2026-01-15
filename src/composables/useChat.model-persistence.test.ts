import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive, triggerRef } from 'vue';
import type { Chat, MessageNode, SidebarItem } from '../models/types';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    saveChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    saveSettings: vi.fn(),
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
const mockChat = vi.fn().mockImplementation(async (_msg: MessageNode[], _model: string, _url: string, onChunk: (chunk: string) => void) => {
  onChunk('Response from ' + _model);
});

vi.mock('../services/llm', () => {
  class MockOpenAI {
    chat = mockChat;
    listModels = vi.fn().mockResolvedValue(['gpt-3.5-turbo', 'gpt-4']);
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn(),
  };
});

describe('useChat Model Persistence', () => {
  const chatStore = useChat();
  const { sendMessage, currentChat, activeMessages } = chatStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRootItems.length = 0;
    
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.loadChat).mockImplementation((id) => {
      if (currentChat.value?.id === id) return Promise.resolve(currentChat.value);
      return Promise.resolve(null);
    });
  });

  it('should persist different modelIds for each assistant message when model is changed', async () => {
    // 1. Setup a chat with initial model
    const chatObj: Chat = {
      id: 'model-test-chat',
      title: 'Model Test',
      root: { items: [] },
      modelId: 'gpt-3.5-turbo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    currentChat.value = reactive(chatObj);

    // 2. Send first message with default model
    await sendMessage('Hello with 3.5');
    triggerRef(currentChat);
    
    expect(activeMessages.value).toHaveLength(2);
    expect(activeMessages.value[1]?.role).toBe('assistant');
    expect(activeMessages.value[1]?.modelId).toBe('gpt-3.5-turbo');
    expect(activeMessages.value[1]?.content).toContain('Response from gpt-3.5-turbo');

    // 3. Change the model for the chat
    currentChat.value.overrideModelId = 'gpt-4';
    
    // 4. Send second message with new model
    await sendMessage('Hello with 4');
    triggerRef(currentChat);

    expect(activeMessages.value).toHaveLength(4);
    
    // Check first assistant message still has old model
    expect(activeMessages.value[1]?.modelId).toBe('gpt-3.5-turbo');
    
    // Check second assistant message has new model
    expect(activeMessages.value[3]?.role).toBe('assistant');
    expect(activeMessages.value[3]?.modelId).toBe('gpt-4');
    expect(activeMessages.value[3]?.content).toContain('Response from gpt-4');

    // 5. Verify storage was called with correct modelIds in the tree
    expect(storageService.saveChat).toHaveBeenCalled();
    const lastSavedChat = vi.mocked(storageService.saveChat).mock.calls[vi.mocked(storageService.saveChat).mock.calls.length - 1]![0];
    
    // Path: root -> user1 -> assistant1 (gpt-3.5) -> user2 -> assistant2 (gpt-4)
    const assistant1 = lastSavedChat.root.items[0]?.replies.items[0];
    const assistant2 = assistant1?.replies.items[0]?.replies.items[0];
    
    expect(assistant1?.modelId).toBe('gpt-3.5-turbo');
    expect(assistant2?.modelId).toBe('gpt-4');
  });
});
