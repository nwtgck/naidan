import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNotify,
  mockAbortTitleGeneration,
  mockGetActiveGeneration,
  mockDeleteActiveGeneration,
  mockHasExternalGeneration,
  mockGetActiveContextCompaction,
  mockActiveGenerations,
} = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockAbortTitleGeneration: vi.fn(),
  mockGetActiveGeneration: vi.fn(),
  mockDeleteActiveGeneration: vi.fn(),
  mockHasExternalGeneration: vi.fn(),
  mockGetActiveContextCompaction: vi.fn(),
  mockActiveGenerations: new Map<string, unknown>(),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    notify: mockNotify,
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    activeGenerations: mockActiveGenerations,
    getActiveGeneration: mockGetActiveGeneration,
    deleteActiveGeneration: mockDeleteActiveGeneration,
    hasExternalGeneration: mockHasExternalGeneration,
  },
  contextCompactRuntime: {
    getActiveContextCompaction: mockGetActiveContextCompaction,
  },
}));

vi.mock('@/composables/chat/chat-scoped/chat-title-flow', () => ({
  abortTitleGenerationForChat: mockAbortTitleGeneration,
}));

import { abortProcessingForChat } from './chat-processing-abort';

describe('abortProcessingForChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockActiveGenerations.clear();
    mockGetActiveGeneration.mockReturnValue(undefined);
    mockHasExternalGeneration.mockReturnValue(false);
    mockGetActiveContextCompaction.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts local generation, compaction, and title generation', async () => {
    const abortGeneration = vi.fn();
    const abortCompaction = vi.fn();
    mockGetActiveGeneration.mockReturnValue({
      controller: {
        abort: abortGeneration,
      },
    });
    mockGetActiveContextCompaction.mockReturnValue({
      abort: abortCompaction,
    });

    abortProcessingForChat({
      chatId: 'chat-1',
    });
    await vi.runAllTimersAsync();

    expect(abortGeneration).toHaveBeenCalledTimes(1);
    expect(mockDeleteActiveGeneration).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockNotify).toHaveBeenCalledWith({
      event: {
        type: 'chat_content_generation',
        id: 'chat-1',
        status: 'abort_request',
        timestamp: expect.any(Number),
      },
    });
  });

  it('requests abort for external generations even without a local controller', () => {
    mockHasExternalGeneration.mockReturnValue(true);

    abortProcessingForChat({
      chatId: 'chat-2',
    });

    expect(mockDeleteActiveGeneration).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith({
      event: {
        type: 'chat_content_generation',
        id: 'chat-2',
        status: 'abort_request',
        timestamp: expect.any(Number),
      },
    });
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({
      chatId: 'chat-2',
    });
  });
});
