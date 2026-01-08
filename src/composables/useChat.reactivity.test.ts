import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { nextTick, reactive } from 'vue';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
  }
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost' } }
  })
}));

// Mock LLM
let onChunkCallback: (chunk: string) => void;
vi.mock('../services/llm', () => {
  class MockOpenAI {
    chat = vi.fn().mockImplementation(async (_msg: any, _model: any, _url: any, onChunk: any) => {
      onChunkCallback = onChunk;
      return new Promise(() => {}); 
    });
    listModels = vi.fn();
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn()
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
      debugEnabled: false
    });
  });

  it('should reflect streamed chunks in activeMessages immediately', async () => {
    // Start sending
    chatStore.sendMessage('Hello');
    
    // Initial async setup
    await nextTick();
    await nextTick();

    expect(chatStore.activeMessages.value).toHaveLength(2);
    expect(chatStore.activeMessages.value[1]?.content).toBe('');

    // Simulate chunk
    onChunkCallback('A');
    await nextTick();
    expect(chatStore.activeMessages.value[1]?.content).toBe('A');

    onChunkCallback('B');
    await nextTick();
    expect(chatStore.activeMessages.value[1]?.content).toBe('AB');
  });
});