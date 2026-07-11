import { toChatId } from '@/01-models/ids';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNotify,
  mockAbortTitleGeneration,
  mockGetActiveGeneration,
  mockDeleteActiveGeneration,
  mockHasExternalGeneration,
  mockGetActiveContextCompaction,
  mockActiveGenerations,
  mockActiveTitleGenerations,
  mockExternalGenerations,
  mockActiveContextCompactions,
} = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockAbortTitleGeneration: vi.fn(),
  mockGetActiveGeneration: vi.fn(),
  mockDeleteActiveGeneration: vi.fn(),
  mockHasExternalGeneration: vi.fn(),
  mockGetActiveContextCompaction: vi.fn(),
  mockActiveGenerations: new Map<unknown, unknown>(),
  mockActiveTitleGenerations: new Map<unknown, unknown>(),
  mockExternalGenerations: new Set<unknown>(),
  mockActiveContextCompactions: new Map<unknown, unknown>(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    notify: mockNotify,
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    activeGenerations: mockActiveGenerations,
    activeTitleGenerations: mockActiveTitleGenerations,
    externalGenerations: mockExternalGenerations,
    getActiveGeneration: mockGetActiveGeneration,
    deleteActiveGeneration: mockDeleteActiveGeneration,
    hasExternalGeneration: mockHasExternalGeneration,
  },
  contextCompactRuntime: {
    activeContextCompactions: mockActiveContextCompactions,
    getActiveContextCompaction: mockGetActiveContextCompaction,
  },
}));

vi.mock('@/composables/chat/chat-scoped/chat-title-flow', () => ({
  abortTitleGenerationForChat: mockAbortTitleGeneration,
}));

import {
  abortAllChatProcessingForStorageTransition,
  abortProcessingForChat,
} from './chat-processing-abort';

describe('abortProcessingForChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockActiveGenerations.clear();
    mockActiveTitleGenerations.clear();
    mockExternalGenerations.clear();
    mockActiveContextCompactions.clear();
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
      chatId: toChatId({ raw: 'chat-1' }),
    });
    await vi.runAllTimersAsync();

    expect(abortGeneration).toHaveBeenCalledTimes(1);
    expect(mockDeleteActiveGeneration).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
    });
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
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
      chatId: toChatId({ raw: 'chat-2' }),
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
      chatId: toChatId({ raw: 'chat-2' }),
    });
  });
  it('aborts every chat with active work before a storage transition', () => {
    const chat1 = toChatId({ raw: 'chat-1' });
    const chat2 = toChatId({ raw: 'chat-2' });
    const chat3 = toChatId({ raw: 'chat-3' });
    const chat4 = toChatId({ raw: 'chat-4' });
    mockActiveGenerations.set(chat1, {});
    mockActiveTitleGenerations.set(chat2, {});
    mockExternalGenerations.add(chat3);
    mockActiveContextCompactions.set(chat4, {});

    abortAllChatProcessingForStorageTransition();

    expect(mockGetActiveGeneration).toHaveBeenCalledWith({ chatId: chat1 });
    expect(mockGetActiveGeneration).toHaveBeenCalledWith({ chatId: chat2 });
    expect(mockGetActiveGeneration).toHaveBeenCalledWith({ chatId: chat3 });
    expect(mockGetActiveGeneration).toHaveBeenCalledWith({ chatId: chat4 });
    expect(mockAbortTitleGeneration).toHaveBeenCalledTimes(4);
  });

});
