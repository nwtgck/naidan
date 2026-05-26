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
  mockSendImageRequest,
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
  mockSendImageRequest: vi.fn(),
}));

vi.mock('@/composables/chat/ui/useChatImageActions', () => ({
  useChatImageActions: () => ({
    availableModels: mockAvailableModels,
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
    sendImageRequest: mockSendImageRequest,
  }),
}));

import { useChatMedia } from './useChatMedia';

describe('useChatMedia', () => {
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
    mockSendImageRequest.mockResolvedValue(true);
  });

  it('returns defaults and no-ops when chatId is undefined', () => {
    const chatMedia = useChatMedia({
      chatId: computed(() => undefined),
    });

    expect(chatMedia.availableModels.value).toEqual(['model-a', 'model-b']);
    expect(chatMedia.isImageMode.value).toBe(false);
    expect(chatMedia.resolution.value).toEqual({ width: 512, height: 512 });
    expect(chatMedia.count.value).toBe(1);
    expect(chatMedia.persistAs.value).toBe('original');
    expect(chatMedia.steps.value).toBeUndefined();
    expect(chatMedia.seed.value).toBeUndefined();
    expect(chatMedia.selectedImageModel.value).toBeUndefined();

    chatMedia.toggleImageMode({});
    chatMedia.updateResolution({ width: 1024, height: 768 });
    chatMedia.updateCount({ count: 2 });
    chatMedia.updatePersistAs({ format: 'png' });
    chatMedia.updateSteps({ steps: 28 });
    chatMedia.updateSeed({ seed: 42 });
    chatMedia.setImageModel({ modelId: 'model-b' });

    expect(mockToggleImageMode).not.toHaveBeenCalled();
    expect(mockUpdateResolution).not.toHaveBeenCalled();
    expect(mockUpdateCount).not.toHaveBeenCalled();
    expect(mockUpdatePersistAs).not.toHaveBeenCalled();
    expect(mockUpdateSteps).not.toHaveBeenCalled();
    expect(mockUpdateSeed).not.toHaveBeenCalled();
    expect(mockSetImageModel).not.toHaveBeenCalled();
  });

  it('returns false for image requests when chatId is undefined', async () => {
    const chatMedia = useChatMedia({
      chatId: computed(() => undefined),
    });

    await expect(chatMedia.sendImageRequest({
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: undefined,
      seed: undefined,
      persistAs: 'original',
      attachments: [],
    })).resolves.toBe(false);

    expect(mockSendImageRequest).not.toHaveBeenCalled();
  });

  it('binds image settings to the scoped chatId', () => {
    mockIsImageMode.mockReturnValue(true);
    mockGetResolution.mockReturnValue({ width: 1024, height: 768 });
    mockGetCount.mockReturnValue(3);
    mockGetPersistAs.mockReturnValue('png');
    mockGetSteps.mockReturnValue(30);
    mockGetSeed.mockReturnValue(99);
    mockGetSelectedImageModel.mockReturnValue('model-b');

    const chatMedia = useChatMedia({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatMedia.isImageMode.value).toBe(true);
    expect(chatMedia.resolution.value).toEqual({ width: 1024, height: 768 });
    expect(chatMedia.count.value).toBe(3);
    expect(chatMedia.persistAs.value).toBe('png');
    expect(chatMedia.steps.value).toBe(30);
    expect(chatMedia.seed.value).toBe(99);
    expect(chatMedia.selectedImageModel.value).toBe('model-b');
    expect(mockGetSelectedImageModel).toHaveBeenCalledWith({ chatId: 'chat-1' });

    chatMedia.toggleImageMode({});
    chatMedia.updateResolution({ width: 640, height: 480 });
    chatMedia.updateCount({ count: 4 });
    chatMedia.updatePersistAs({ format: 'jpeg' });
    chatMedia.updateSteps({ steps: 12 });
    chatMedia.updateSeed({ seed: 'browser_random' });
    chatMedia.setImageModel({ modelId: 'model-a' });

    expect(mockToggleImageMode).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateResolution).toHaveBeenCalledWith({ chatId: 'chat-1', width: 640, height: 480 });
    expect(mockUpdateCount).toHaveBeenCalledWith({ chatId: 'chat-1', count: 4 });
    expect(mockUpdatePersistAs).toHaveBeenCalledWith({ chatId: 'chat-1', format: 'jpeg' });
    expect(mockUpdateSteps).toHaveBeenCalledWith({ chatId: 'chat-1', steps: 12 });
    expect(mockUpdateSeed).toHaveBeenCalledWith({ chatId: 'chat-1', seed: 'browser_random' });
    expect(mockSetImageModel).toHaveBeenCalledWith({ chatId: 'chat-1', modelId: 'model-a' });
  });

  it('binds image requests to the scoped chatId', async () => {
    const chatMedia = useChatMedia({
      chatId: computed(() => 'chat-1'),
    });

    await expect(chatMedia.sendImageRequest({
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: 20,
      seed: 42,
      persistAs: 'png',
      attachments: [],
    })).resolves.toBe(true);

    expect(mockSendImageRequest).toHaveBeenCalledWith({
      chatId: 'chat-1',
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: 20,
      seed: 42,
      persistAs: 'png',
      attachments: [],
    });
  });
});
