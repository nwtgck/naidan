import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { reactive } from 'vue';

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation(({ updater }) => Promise.resolve(updater({ current: null }))),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    deleteChat: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    deleteChatGroup: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    notify: vi.fn(),
  },
}));

// Mock settings
const mockSettings = {
  value: {
    endpoint: {
      type: 'openai' as const,
      url: '',
    },
    defaultModelId: '',
    storageType: 'local' as const,
    mounts: [],
    autoTitleEnabled: true,
  },
};
const mockIsOnboardingDismissed = { value: true };
const mockOnboardingDraft = { value: null };

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
    isOnboardingDismissed: mockIsOnboardingDismissed,
    onboardingDraft: mockOnboardingDraft,
    setOnboardingDraft: ({ draft }: { draft: any }) => {
      mockOnboardingDraft.value = draft;
    },
    setIsOnboardingDismissed: ({ dismissed }: { dismissed: boolean }) => {
      mockIsOnboardingDismissed.value = dismissed;
    },
  }),
}));

// Mock LM Provider
const mockListModels = vi.fn();
vi.mock('../services/lm/openai', () => {
  class MockOpenAI {
    chat = vi.fn();
    listModels = mockListModels;
  }
  return {
    OpenAIProvider: MockOpenAI,
  };
});

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: vi.fn(),
}));

describe('useChat Onboarding Trigger', () => {
  const chatStore = useChat();
  const { TEST_ONLY, sendMessage, currentChat } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.value.endpoint = { type: 'openai', url: '' };
    mockSettings.value.defaultModelId = '';
    mockIsOnboardingDismissed.value = true;
    mockOnboardingDraft.value = null;
    mockListModels.mockResolvedValue(['model-a', 'model-b']);
  });

  it('should trigger onboarding if endpointUrl is missing when sending a message', async () => {
    __testOnlySetCurrentChat({ chat: reactive({
      id: 'chat-1', title: 'Test', root: { items: [] }, modelId: '',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any });

    await sendMessage({ content: 'Hello' });

    expect(mockIsOnboardingDismissed.value).toBe(false);
  });

  it('should trigger onboarding and populate draft if modelId is missing when sending a message', async () => {
    mockSettings.value.endpoint = { type: 'openai', url: 'http://localhost:11434' };
    __testOnlySetCurrentChat({ chat: reactive({
      id: 'chat-1', title: 'Test', root: { items: [] }, modelId: '',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any });

    await sendMessage({ content: 'Hello' });

    expect(mockIsOnboardingDismissed.value).toBe(false);
    expect(mockOnboardingDraft.value).toEqual({
      url: 'http://localhost:11434',
      type: 'openai',
      models: ['model-a', 'model-b'],
      selectedModel: 'model-a',
    });
  });

  it('should NOT use gpt-3.5-turbo as fallback model anymore', async () => {
    mockSettings.value.endpoint = { type: 'openai', url: 'http://localhost:11434' };
    // No default model in settings and no model in chat
    __testOnlySetCurrentChat({ chat: reactive({
      id: 'chat-1', title: 'Test', root: { items: [] }, modelId: '',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any });

    await sendMessage({ content: 'Hello' });

    // It should have stopped and triggered onboarding instead of sending
    expect(mockIsOnboardingDismissed.value).toBe(false);
    // If it had used gpt-3.5-turbo, currentChat.value.root.items would have 1 item
    expect(currentChat.value!.root.items).toHaveLength(0);
  });

  it('should NOT reset isOnboardingDismissed when deleteAllChats is called', async () => {
    const { deleteAllChats } = useChat();
    mockIsOnboardingDismissed.value = true;

    await deleteAllChats();

    expect(mockIsOnboardingDismissed.value).toBe(true);
  });
});
