import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';

// --- Mocks ---
const mockRootItems: any[] = [];
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn().mockResolvedValue(null),
    saveChat: vi.fn().mockResolvedValue(undefined),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    saveChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
    canPersistBinary: true,
    getFile: vi.fn(),
    saveFile: vi.fn(),
  },
}));

const mockSettings = { 
  value: { 
    endpointType: 'openai', 
    endpointUrl: 'http://localhost', 
    storageType: 'local', 
    autoTitleEnabled: false, 
    defaultModelId: 'gpt-4',
    lmParameters: {},
    providerProfiles: [],
  } 
};

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

const mockLlmChat = vi.fn();
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: function() {
      return {
        chat: mockLlmChat,
        listModels: vi.fn().mockResolvedValue(['gpt-4']),
      };
    },
    OllamaProvider: function() {
      return {
        chat: mockLlmChat,
        listModels: vi.fn().mockResolvedValue(['gpt-4']),
      };
    },
  };
});

describe('useChat Streaming State Logic', () => {
  const chatStore = useChat();
  const { currentChat, activeGenerations, streaming, sendMessage, createNewChat, abortChat } = chatStore;

  const waitForRegistry = async (id: string) => {
    await vi.waitUntil(() => activeGenerations.has(id), { timeout: 2000 });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentChat.value = null;
    activeGenerations.clear();
  });

  it('should correctly set streaming state when generation starts and ends', async () => {
    await createNewChat();
    const chat = currentChat.value!;
    
    let resolveGen: () => void;
    const p = new Promise<void>(r => resolveGen = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Start');
      await p;
      onChunk('End');
    });

    const sendPromise = sendMessage('Hello');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chat.id);

    expect(streaming.value).toBe(true);
    expect(activeGenerations.has(chat.id)).toBe(true);

    resolveGen!();
    await sendPromise;

    expect(streaming.value).toBe(false);
    expect(activeGenerations.has(chat.id)).toBe(false);
  });

  it('should clear streaming state when aborted', async () => {
    await createNewChat();
    const chat = currentChat.value!;
    
    let resolveGen: () => void;
    const p = new Promise<void>(r => resolveGen = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, _on, _p, signal) => {
      await p;
      if (signal?.aborted) throw new Error('Aborted');
    });

    const sendPromise = sendMessage('Hello');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chat.id);

    expect(streaming.value).toBe(true);

    abortChat();
    resolveGen!();
    
    // activeGenerations should be cleared immediately or after promise rejection
    try {
      await sendPromise;
    } catch {
      // Expected error due to abortion
    }

    expect(streaming.value).toBe(false);
    expect(activeGenerations.has(chat.id)).toBe(false);
  });
});
