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
  mockSendImageRequestForChat,
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
  mockSendImageRequestForChat: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
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
    sendImageRequestForChat: mockSendImageRequestForChat,
  }),
}));

import { useChatImageActions } from './useChatImageActions';

describe('useChatImageActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailableModels.value = ['model-a', 'model-b'];
    mockIsImageMode.mockReturnValue(false);
    mockGetResolution.mockReturnValue({ width: 512, height: 512 });
    mockGetCount.mockReturnValue(1);
    mockGetPersistAs.mockReturnValue('original');
    mockGetSteps.mockReturnValue(undefined);
    mockGetSeed.mockReturnValue('browser_random');
    mockGetSelectedImageModel.mockReturnValue('model-a');
    mockSendImageRequest.mockResolvedValue(true);
    mockSendImageRequestForChat.mockResolvedValue(true);
  });

  it('returns defaults and uses fallback send when chatId is undefined', async () => {
    const chatImageActions = useChatImageActions();

    expect(chatImageActions.availableModels.value).toEqual(['model-a', 'model-b']);
    expect(chatImageActions.isImageMode({ chatId: undefined })).toBe(false);
    expect(chatImageActions.getResolution({ chatId: undefined })).toEqual({ width: 512, height: 512 });
    expect(chatImageActions.getCount({ chatId: undefined })).toBe(1);
    expect(chatImageActions.getPersistAs({ chatId: undefined })).toBe('original');
    expect(chatImageActions.getSteps({ chatId: undefined })).toBeUndefined();
    expect(chatImageActions.getSeed({ chatId: undefined })).toBeUndefined();
    expect(chatImageActions.getSelectedImageModel({ chatId: undefined })).toBeUndefined();

    chatImageActions.toggleImageMode({ chatId: undefined });
    chatImageActions.updateResolution({ chatId: undefined, width: 1024, height: 768 });
    chatImageActions.updateCount({ chatId: undefined, count: 2 });
    chatImageActions.updatePersistAs({ chatId: undefined, format: 'png' });
    chatImageActions.updateSteps({ chatId: undefined, steps: 28 });
    chatImageActions.updateSeed({ chatId: undefined, seed: 42 });
    chatImageActions.setImageModel({ chatId: undefined, modelId: 'model-b' });

    await expect(chatImageActions.sendImageRequest({
      chatId: undefined,
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: undefined,
      seed: undefined,
      persistAs: 'original',
      attachments: [],
    })).resolves.toBe(true);

    expect(mockToggleImageMode).not.toHaveBeenCalled();
    expect(mockUpdateResolution).not.toHaveBeenCalled();
    expect(mockUpdateCount).not.toHaveBeenCalled();
    expect(mockUpdatePersistAs).not.toHaveBeenCalled();
    expect(mockUpdateSteps).not.toHaveBeenCalled();
    expect(mockUpdateSeed).not.toHaveBeenCalled();
    expect(mockSetImageModel).not.toHaveBeenCalled();
    expect(mockSendImageRequest).toHaveBeenCalledWith({
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: undefined,
      seed: undefined,
      persistAs: 'original',
      attachments: [],
    });
  });

  it('uses scoped actions when chatId is available', async () => {
    mockIsImageMode.mockReturnValue(true);
    mockGetResolution.mockReturnValue({ width: 1024, height: 768 });
    mockGetCount.mockReturnValue(3);
    mockGetPersistAs.mockReturnValue('png');
    mockGetSteps.mockReturnValue(30);
    mockGetSeed.mockReturnValue(99);
    mockGetSelectedImageModel.mockReturnValue('model-b');

    const chatImageActions = useChatImageActions();

    expect(chatImageActions.isImageMode({ chatId: 'chat-1' })).toBe(true);
    expect(chatImageActions.getResolution({ chatId: 'chat-1' })).toEqual({ width: 1024, height: 768 });
    expect(chatImageActions.getCount({ chatId: 'chat-1' })).toBe(3);
    expect(chatImageActions.getPersistAs({ chatId: 'chat-1' })).toBe('png');
    expect(chatImageActions.getSteps({ chatId: 'chat-1' })).toBe(30);
    expect(chatImageActions.getSeed({ chatId: 'chat-1' })).toBe(99);
    expect(chatImageActions.getSelectedImageModel({ chatId: 'chat-1' })).toBe('model-b');

    chatImageActions.toggleImageMode({ chatId: 'chat-1' });
    chatImageActions.updateResolution({ chatId: 'chat-1', width: 640, height: 480 });
    chatImageActions.updateCount({ chatId: 'chat-1', count: 4 });
    chatImageActions.updatePersistAs({ chatId: 'chat-1', format: 'jpeg' });
    chatImageActions.updateSteps({ chatId: 'chat-1', steps: 12 });
    chatImageActions.updateSeed({ chatId: 'chat-1', seed: 'browser_random' });
    chatImageActions.setImageModel({ chatId: 'chat-1', modelId: 'model-a' });

    await expect(chatImageActions.sendImageRequest({
      chatId: 'chat-1',
      prompt: 'draw a cat',
      width: 512,
      height: 512,
      count: 1,
      steps: 20,
      seed: 42,
      persistAs: 'png',
      attachments: [],
    })).resolves.toBe(true);

    expect(mockGetSelectedImageModel).toHaveBeenCalledWith({
      chatId: 'chat-1',
      availableModels: ['model-a', 'model-b'],
    });
    expect(mockToggleImageMode).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateResolution).toHaveBeenCalledWith({ chatId: 'chat-1', width: 640, height: 480 });
    expect(mockUpdateCount).toHaveBeenCalledWith({ chatId: 'chat-1', count: 4 });
    expect(mockUpdatePersistAs).toHaveBeenCalledWith({ chatId: 'chat-1', format: 'jpeg' });
    expect(mockUpdateSteps).toHaveBeenCalledWith({ chatId: 'chat-1', steps: 12 });
    expect(mockUpdateSeed).toHaveBeenCalledWith({ chatId: 'chat-1', seed: 'browser_random' });
    expect(mockSetImageModel).toHaveBeenCalledWith({ chatId: 'chat-1', modelId: 'model-a' });
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
    });
  });
});
