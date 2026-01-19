import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { nextTick, reactive } from 'vue';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    saveChatMeta: vi.fn(),
    saveChatContent: vi.fn(),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn(),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

import type { MessageNode } from '../models/types';

// Mock LLM
let onChunkCallback: (chunk: string) => void;
vi.mock('../services/llm', () => {
  class MockOpenAI {
    chat = vi.fn().mockImplementation(async (_msg: MessageNode[], _model: string, _url: string, onChunk: (c: string) => void) => {
      onChunkCallback = onChunk;
      return new Promise<void>(() => {}); 
    });
    listModels = vi.fn().mockResolvedValue([]);
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn(),
  };
});

describe('useChat Reactivity', () => {
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.currentChat.value = reactive({
      id: '1',
      title: 'Test',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    });
  });

  it('should reflect streamed chunks in activeMessages immediately', async () => {
    // Start sending
    chatStore.sendMessage('Hello');
    
    // Initial async setup - need enough ticks to pass through fetchAvailableModels
    await nextTick();
    await nextTick();
    await nextTick();
    await nextTick();

    expect(chatStore.activeMessages.value).toHaveLength(2);
    expect(chatStore.activeMessages.value[1]?.content).toBe('');

    // Ensure onChunkCallback is defined before calling it
    if (typeof onChunkCallback !== 'function') {
      // Wait a bit more if needed
      await new Promise(r => setTimeout(r, 10));
    }

    // Simulate chunk
    onChunkCallback('A');
    await nextTick();
    expect(chatStore.activeMessages.value[1]?.content).toBe('A');

    onChunkCallback('B');
    await nextTick();
    expect(chatStore.activeMessages.value[1]?.content).toBe('AB');
  });
});