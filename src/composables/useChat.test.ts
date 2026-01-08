import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive } from 'vue';

// Mock storage service
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
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local' } }
  })
}));

// Mock LLM Provider
vi.mock('../services/llm', () => {
  class MockOpenAI {
    chat = vi.fn().mockImplementation(async (_msg: any, _model: any, _url: any, onChunk: any) => {
      onChunk('Hello');
      await new Promise(r => setTimeout(r, 10)); // Simulate network delay
      onChunk(' World');
    });
    listModels = vi.fn().mockResolvedValue(['gpt-4']);
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn()
  };
});

describe('useChat Composable Logic', () => {
  const { 
    deleteChat, undoDelete, deleteAllChats, lastDeletedChat, 
    activeMessages, sendMessage, currentChat 
  } = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    currentChat.value = null;
  });

  it('should update activeMessages in real-time during streaming', async () => {
    // Setup initial chat
    currentChat.value = {
      id: 'chat-1',
      title: 'Test',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    };

    // Start sending a message
    const sendPromise = sendMessage('Ping');
    
    // During streaming (after first chunk 'Hello'), check state
    // We use a small timeout to allow the async chat function to start and emit first chunk
    await new Promise(r => setTimeout(r, 5));
    
    expect(activeMessages.value).toHaveLength(2); // User + Assistant
    expect(activeMessages.value[1]?.content).toBe('Hello');

    await sendPromise; // Finish streaming

    expect(activeMessages.value[1]?.content).toBe('Hello World');
  });

  it('should store deleted chat in lastDeletedChat for undo', async () => {
    const mockChat = { id: '1', title: 'Test', root: { items: [] } };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat as any);
    vi.mocked(storageService.deleteChat).mockResolvedValue();

    await deleteChat('1');

    expect(storageService.loadChat).toHaveBeenCalledWith('1');
    expect(lastDeletedChat.value).toEqual(mockChat);
  });

  it('should restore chat on undoDelete', async () => {
    const mockChat = { id: '1', title: 'Test', root: { items: [] } };
    lastDeletedChat.value = mockChat as any;
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    await undoDelete();

    expect(storageService.saveChat).toHaveBeenCalledWith(mockChat);
    expect(lastDeletedChat.value).toBeNull();
  });

  it('should delete all chats when deleteAllChats is called', async () => {
    const mockSummaries = [{ id: '1' }, { id: '2' }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockSummaries as any);
    vi.mocked(storageService.deleteChat).mockResolvedValue();

    await deleteAllChats();

    expect(storageService.deleteChat).toHaveBeenCalledTimes(2);
    expect(lastDeletedChat.value).toBeNull();
  });

  it('should rename a chat and update storage', async () => {
    const { renameChat } = useChat();
    const mockChat = { id: '1', title: 'Old Title', root: { items: [] } };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat as any);
    vi.mocked(storageService.saveChat).mockResolvedValue();

    await renameChat('1', 'New Title');

    expect(storageService.loadChat).toHaveBeenCalledWith('1');
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      id: '1',
      title: 'New Title'
    }));
  });

  it('should fork a chat up to a specific message', async () => {
    const { forkChat, currentChat } = useChat();
    
    // Create a tree: m1 -> m2
    const m2 = { id: 'm2', role: 'assistant', content: 'Msg 2', replies: { items: [] } };
    const m1 = { id: 'm1', role: 'user', content: 'Msg 1', replies: { items: [m2] } };
    
    const mockChat = { 
      id: 'old-chat', 
      title: 'Original', 
      root: { items: [m1] },
      modelId: 'gpt-4'
    };
    
    currentChat.value = reactive(mockChat as any);
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    // Fork at message 'm1'
    const newId = await forkChat('m1');

    expect(newId).toBeDefined();
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fork of Original',
      root: { items: [expect.objectContaining({ id: 'm1' })] },
      currentLeafId: 'm1'
    }));
    
    const savedChat = vi.mocked(storageService.saveChat).mock.calls[0]?.[0] as any;
    expect(savedChat.root.items[0].replies.items).toHaveLength(0); // m2 should be gone
  });

  it('should support rewriting the very first message', async () => {
    const { sendMessage, editMessage, currentChat } = useChat();
    
    currentChat.value = reactive({
      id: 'chat-root-test',
      title: 'Root Test',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    }) as any;

    // 1. Send first message
    await sendMessage('First version');
    expect(currentChat.value?.root.items).toHaveLength(1);
    const firstId = currentChat.value?.root.items[0]?.id;

    // 2. Rewrite the first message
    await editMessage(firstId!, 'Second version');

    // 3. Verify
    expect(currentChat.value?.root.items).toHaveLength(2);
    expect(currentChat.value?.root.items[0]?.content).toBe('First version');
    expect(currentChat.value?.root.items[1]?.content).toBe('Second version');
    
    // The current leaf should be the assistant reply of the NEW version
    const secondVersionUserMsg = currentChat.value?.root.items[1];
    expect(currentChat.value?.currentLeafId).toBe(secondVersionUserMsg?.replies.items[0]?.id);
  });
});
