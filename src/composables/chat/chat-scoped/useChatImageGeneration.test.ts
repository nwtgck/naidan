import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAvailableModels,
  mockIsImageMode,
  mockToggleImageMode,
  mockGetResolution,
  mockUpdateResolution,
  mockGetCount,
  mockUpdateCount,
  mockGetPersistAs,
  mockUpdatePersistAs,
  mockGetSteps,
  mockUpdateSteps,
  mockGetSeed,
  mockUpdateSeed,
  mockSetImageModel,
  mockGetSelectedImageModel,
  mockSendImageRequestForChat,
  mockSendMessage,
} = vi.hoisted(() => ({
  mockAvailableModels: { value: ['model-a', 'model-b'] as string[] },
  mockIsImageMode: vi.fn(),
  mockToggleImageMode: vi.fn(),
  mockGetResolution: vi.fn(),
  mockUpdateResolution: vi.fn(),
  mockGetCount: vi.fn(),
  mockUpdateCount: vi.fn(),
  mockGetPersistAs: vi.fn(),
  mockUpdatePersistAs: vi.fn(),
  mockGetSteps: vi.fn(),
  mockUpdateSteps: vi.fn(),
  mockGetSeed: vi.fn(),
  mockUpdateSeed: vi.fn(),
  mockSetImageModel: vi.fn(),
  mockGetSelectedImageModel: vi.fn(),
  mockSendImageRequestForChat: vi.fn(),
  mockSendMessage: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  availableModels: mockAvailableModels,
}));

vi.mock('@/composables/useImageGeneration', () => ({
  useImageGeneration: () => ({
    isImageMode: mockIsImageMode,
    toggleImageMode: mockToggleImageMode,
    getResolution: mockGetResolution,
    updateResolution: mockUpdateResolution,
    getCount: mockGetCount,
    updateCount: mockUpdateCount,
    getPersistAs: mockGetPersistAs,
    updatePersistAs: mockUpdatePersistAs,
    getSteps: mockGetSteps,
    updateSteps: mockUpdateSteps,
    getSeed: mockGetSeed,
    updateSeed: mockUpdateSeed,
    setImageModel: mockSetImageModel,
    getSelectedImageModel: mockGetSelectedImageModel,
  }),
}));

vi.mock('./chat-image-helpers', () => ({
  sendImageRequestForChat: mockSendImageRequestForChat,
}));

vi.mock('@/composables/chat/ui/useChatConversationActions', () => ({
  useChatConversationActions: () => ({
    sendMessage: mockSendMessage,
  }),
}));

import { useChatImageGeneration } from './useChatImageGeneration';

describe('useChatImageGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailableModels.value = ['model-a', 'model-b'];
    mockIsImageMode.mockReturnValue(false);
    mockGetResolution.mockReturnValue({ width: 512, height: 512 });
    mockGetCount.mockReturnValue(1);
    mockGetPersistAs.mockReturnValue('original');
    mockGetSteps.mockImplementation(({ chatId }) => (chatId === undefined ? undefined : 30));
    mockGetSeed.mockImplementation(({ chatId }) => (chatId === undefined ? undefined : 'browser_random'));
    mockGetSelectedImageModel.mockImplementation(({ chatId }) => (chatId === undefined ? undefined : 'model-a'));
    mockSendImageRequestForChat.mockResolvedValue(true);
  });

  it('returns defaults and no-ops when chatId is undefined', () => {
    const chatImageGeneration = useChatImageGeneration({
      chatId: computed(() => undefined),
    });

    expect(chatImageGeneration.availableModels.value).toEqual(['model-a', 'model-b']);
    expect(chatImageGeneration.isImageMode.value).toBe(false);
    expect(chatImageGeneration.resolution.value).toEqual({ width: 512, height: 512 });
    expect(chatImageGeneration.count.value).toBe(1);
    expect(chatImageGeneration.persistAs.value).toBe('original');
    expect(chatImageGeneration.steps.value).toBeUndefined();
    expect(chatImageGeneration.seed.value).toBeUndefined();
    expect(chatImageGeneration.selectedImageModel.value).toBeUndefined();

    chatImageGeneration.toggleImageMode({});
    chatImageGeneration.updateResolution({ width: 1024, height: 768 });
    chatImageGeneration.updateCount({ count: 2 });
    chatImageGeneration.updatePersistAs({ format: 'png' });
    chatImageGeneration.updateSteps({ steps: 28 });
    chatImageGeneration.updateSeed({ seed: 42 });
    chatImageGeneration.setImageModel({ modelId: 'model-b' });

    expect(mockToggleImageMode).not.toHaveBeenCalled();
    expect(mockUpdateResolution).not.toHaveBeenCalled();
    expect(mockUpdateCount).not.toHaveBeenCalled();
    expect(mockUpdatePersistAs).not.toHaveBeenCalled();
    expect(mockUpdateSteps).not.toHaveBeenCalled();
    expect(mockUpdateSeed).not.toHaveBeenCalled();
    expect(mockSetImageModel).not.toHaveBeenCalled();
  });

  it('returns false for image requests when chatId is undefined', async () => {
    const chatImageGeneration = useChatImageGeneration({
      chatId: computed(() => undefined),
    });

    await expect(chatImageGeneration.sendImageRequest({
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: undefined,
      seed: undefined,
      persistAs: 'original',
      attachments: [],
    })).resolves.toBe(false);

    expect(mockSendImageRequestForChat).not.toHaveBeenCalled();
  });

  it('binds image settings to the scoped chatId', () => {
    mockIsImageMode.mockReturnValue(true);
    mockGetResolution.mockReturnValue({ width: 1024, height: 768 });
    mockGetCount.mockReturnValue(3);
    mockGetPersistAs.mockReturnValue('png');
    mockGetSteps.mockReturnValue(30);
    mockGetSeed.mockReturnValue(99);
    mockGetSelectedImageModel.mockReturnValue('model-b');

    const chatImageGeneration = useChatImageGeneration({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatImageGeneration.isImageMode.value).toBe(true);
    expect(chatImageGeneration.resolution.value).toEqual({ width: 1024, height: 768 });
    expect(chatImageGeneration.count.value).toBe(3);
    expect(chatImageGeneration.persistAs.value).toBe('png');
    expect(chatImageGeneration.steps.value).toBe(30);
    expect(chatImageGeneration.seed.value).toBe(99);
    expect(chatImageGeneration.selectedImageModel.value).toBe('model-b');
    expect(mockGetSelectedImageModel).toHaveBeenCalledWith({
      chatId: 'chat-1',
      availableModels: ['model-a', 'model-b'],
    });

    chatImageGeneration.toggleImageMode({});
    chatImageGeneration.updateResolution({ width: 640, height: 480 });
    chatImageGeneration.updateCount({ count: 4 });
    chatImageGeneration.updatePersistAs({ format: 'jpeg' });
    chatImageGeneration.updateSteps({ steps: 12 });
    chatImageGeneration.updateSeed({ seed: 'browser_random' });
    chatImageGeneration.setImageModel({ modelId: 'model-a' });

    expect(mockToggleImageMode).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateResolution).toHaveBeenCalledWith({ chatId: 'chat-1', width: 640, height: 480 });
    expect(mockUpdateCount).toHaveBeenCalledWith({ chatId: 'chat-1', count: 4 });
    expect(mockUpdatePersistAs).toHaveBeenCalledWith({ chatId: 'chat-1', format: 'jpeg' });
    expect(mockUpdateSteps).toHaveBeenCalledWith({ chatId: 'chat-1', steps: 12 });
    expect(mockUpdateSeed).toHaveBeenCalledWith({ chatId: 'chat-1', seed: 'browser_random' });
    expect(mockSetImageModel).toHaveBeenCalledWith({ chatId: 'chat-1', modelId: 'model-a' });
  });

  it('binds image requests to the scoped chatId', async () => {
    const chatImageGeneration = useChatImageGeneration({
      chatId: computed(() => 'chat-1'),
    });

    await expect(chatImageGeneration.sendImageRequest({
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: 20,
      seed: 42,
      persistAs: 'png',
      attachments: [],
    })).resolves.toBe(true);

    expect(mockSendImageRequestForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: 20,
      seed: 42,
      persistAs: 'png',
      attachments: [],
      availableModels: ['model-a', 'model-b'],
      sendMessage: expect.any(Function),
    });
  });
});
