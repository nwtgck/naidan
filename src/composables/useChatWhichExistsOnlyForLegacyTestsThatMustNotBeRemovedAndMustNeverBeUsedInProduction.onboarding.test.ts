import { storageService, type StorageService } from '@/00-storage/service';
import type { useSettings } from './useSettings';
import type { LmProvider } from '@/01-models/lm';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction.test-support';
import { reactive } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

const { mockRequestAppSettings } = vi.hoisted(() => ({ mockRequestAppSettings: vi.fn() }));
vi.mock('./useAppEntry', () => ({ requestAppSettings: mockRequestAppSettings }));

// Mock storage service
vi.mock('../00-storage/service', () => ({
  storageService: {
    subscribeLocalModelPromotions: vi.fn(() => () => {}),
    getModelLaunch: vi.fn<StorageService['getModelLaunch']>().mockReturnValue(undefined),
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(),
    loadChatMeta: vi.fn(),
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
    titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
  },
};
const mockIsOnboardingDismissed = { value: true };
const mockOnboardingDraft: { value: ReturnType<typeof useSettings>['onboardingDraft']['value'] } = { value: null };

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    synchronizeModelBindingSettings: async () => 'synchronized',
    settings: mockSettings,
    isOnboardingDismissed: mockIsOnboardingDismissed,
    onboardingDraft: mockOnboardingDraft,
    setOnboardingDraft: ({ draft }: { draft: typeof mockOnboardingDraft.value }) => {
      mockOnboardingDraft.value = draft;
    },
    setIsOnboardingDismissed: ({ dismissed }: { dismissed: boolean }) => {
      mockIsOnboardingDismissed.value = dismissed;
    },
  }),
}));

// Mock LM Provider
const mockListModels = vi.fn();
const mockLmChat = vi.fn<LmProvider['chat']>();
vi.mock('../features/lm/openai', () => {
  class MockOpenAI {
    chat = mockLmChat;
    listModels = mockListModels;
  }
  return {
    OpenAIProvider: MockOpenAI,
  };
});

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: vi.fn(),
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Missing Connection Settings', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const { TEST_ONLY, sendMessage, currentChat } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    TEST_ONLY.clearLiveChatRegistry();
    mockSettings.value.endpoint = { type: 'openai', url: '' };
    mockSettings.value.defaultModelId = '';
    mockIsOnboardingDismissed.value = true;
    mockOnboardingDraft.value = null;
    mockListModels.mockResolvedValue(['model-a', 'model-b']);
  });

  it('should request connection settings if endpointUrl is missing when sending a message', async () => {
    __testOnlySetCurrentChat({
      chat: reactive({
        id: 'chat-1',
        title: 'Test',
        root: { items: [] },
        modelId: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        debugEnabled: false,
      }) as any,
    });

    expect(await sendMessage({ content: 'Hello' })).toBe(false);

    expect(mockRequestAppSettings).toHaveBeenCalledWith({ tab: 'connection', opener: undefined });
    expect(mockIsOnboardingDismissed.value).toBe(true);
    expect(mockLmChat).not.toHaveBeenCalled();
  });

  it('should request connection settings and preserve an existing legacy draft if modelId is missing', async () => {
    mockSettings.value.endpoint = { type: 'openai', url: 'http://localhost:11434' };
    const legacyDraft = { url: 'https://legacy.example.invalid', type: 'ollama' as const, models: ['legacy-only-model'], selectedModel: 'legacy-only-model' };
    mockOnboardingDraft.value = structuredClone(legacyDraft);
    __testOnlySetCurrentChat({
      chat: reactive({
        id: 'chat-1',
        title: 'Test',
        root: { items: [] },
        modelId: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        debugEnabled: false,
      }) as any,
    });

    expect(await sendMessage({ content: 'Hello' })).toBe(false);

    expect(mockRequestAppSettings).toHaveBeenCalledWith({ tab: 'connection', opener: undefined });
    expect(mockIsOnboardingDismissed.value).toBe(true);
    expect(mockLmChat).not.toHaveBeenCalled();
    expect(mockOnboardingDraft.value).toEqual(legacyDraft);
    expect(currentChat.value!.root.items).toHaveLength(0);
    expect(storageService.updateChatContent).not.toHaveBeenCalled();
  });

  it('should NOT use gpt-3.5-turbo as fallback model anymore', async () => {
    mockSettings.value.endpoint = { type: 'openai', url: 'http://localhost:11434' };
    // No default model in settings and no model in chat
    __testOnlySetCurrentChat({
      chat: reactive({
        id: 'chat-1',
        title: 'Test',
        root: { items: [] },
        modelId: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        debugEnabled: false,
      }) as any,
    });

    expect(await sendMessage({ content: 'Hello' })).toBe(false);

    // Missing configuration opens connection settings before any message is saved.
    expect(mockRequestAppSettings).toHaveBeenCalledWith({ tab: 'connection', opener: undefined });
    expect(mockIsOnboardingDismissed.value).toBe(true);
    expect(mockLmChat).not.toHaveBeenCalled();
    // A fallback model would have allowed a user message to be appended.
    expect(currentChat.value!.root.items).toHaveLength(0);
  });

  it('should NOT reset isOnboardingDismissed when deleteAllChats is called', async () => {
    const { deleteAllChats } = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
    mockIsOnboardingDismissed.value = true;

    await deleteAllChats();

    expect(mockIsOnboardingDismissed.value).toBe(true);
  });
});
