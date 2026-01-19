import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';

// Mock dependencies
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    saveFile: vi.fn(),
    getFile: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    canPersistBinary: true,
  },
}));

// Mock LLM with classes
const mockChat = vi.fn();
const mockListModels = vi.fn().mockResolvedValue(['gpt-4']);

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: class {
      listModels = mockListModels;
      chat = mockChat;
    },
    OllamaProvider: class {
      listModels = mockListModels;
      chat = mockChat;
    },
  };
});

describe('useChat Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChat.mockReset();
    mockListModels.mockResolvedValue(['gpt-4']);
    
    const { settings } = useSettings();
    settings.value = {
      endpointType: 'openai',
      endpointUrl: 'https://api.openai.com',
      defaultModelId: 'gpt-4',
      autoTitleEnabled: false,
      storageType: 'local',
      providerProfiles: [],
      heavyContentAlertDismissed: true,
    };
  });

  it('should set error state on assistant node when generation fails', async () => {
    const { createNewChat, sendMessage, activeMessages } = useChat();
    await createNewChat();

    // Setup failure
    mockChat.mockRejectedValue(new Error('API Error'));

    await sendMessage('Hello');

    const assistantMsg = activeMessages.value.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.error).toBe('API Error');
    expect(assistantMsg?.content).toBe('');
  });

  it('should retry message by creating a sibling node', async () => {
    const { createNewChat, sendMessage, activeMessages, regenerateMessage, currentChat } = useChat();
    await createNewChat();

    // 1. Fail first
    mockChat.mockRejectedValueOnce(new Error('First Fail'));

    await sendMessage('Hello');
    const failedMsg = activeMessages.value.find(m => m.role === 'assistant');
    expect(failedMsg?.error).toBe('First Fail');

    // 2. Retry (Success)
    // The next call to mockChat (for retry) should succeed
    mockChat.mockImplementation(async (_msgs, _model, _url, onChunk) => {
      onChunk('Success');
    });

    await regenerateMessage(failedMsg!.id);

    // Should have a NEW assistant message at the end
    const newMsg = activeMessages.value[activeMessages.value.length - 1];
    expect(newMsg?.id).not.toBe(failedMsg?.id);
    expect(newMsg?.role).toBe('assistant');
    expect(newMsg?.content).toBe('Success');
    expect(newMsg?.error).toBeUndefined();

    // Verify sibling structure
    const userMsg = activeMessages.value[0]!;
    const userNode = currentChat.value?.root.items.find(n => n.id === userMsg.id);
    expect(userNode).toBeDefined();
    expect(userNode?.replies.items[0]!.error).toBe('First Fail');
    expect(userNode?.replies.items[1]!.content).toBe('Success');
  });
});