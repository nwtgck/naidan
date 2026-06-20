import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/models/ids';
import type { Chat, ChatMeta } from '@/models/types';

const {
  mockGetSidebarStructure,
  mockLoadChat,
  mockSubscribeToChanges,
  mockUpdateChatMeta,
} = vi.hoisted(() => ({
  mockGetSidebarStructure: vi.fn().mockResolvedValue([]),
  mockLoadChat: vi.fn(),
  mockSubscribeToChanges: vi.fn(),
  mockUpdateChatMeta: vi.fn(),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    getSidebarStructure: mockGetSidebarStructure,
    loadChat: mockLoadChat,
    listChatGroups: vi.fn().mockResolvedValue([]),
    subscribeToChanges: mockSubscribeToChanges,
    updateChatContent: vi.fn(),
    updateChatMeta: mockUpdateChatMeta,
  },
}));

import { createChatDataStore } from './chat-data-store';

function createChatMeta(): ChatMeta {
  return {
    id: toChatId({ raw: 'chat-1' }),
    title: 'Chat',
    createdAt: 1,
    updatedAt: 2,
    debugEnabled: false,
    modelId: 'old-model',
    lmParameters: {
      temperature: 0.5,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: { effort: 'low' },
    },
  };
}

function createChat(): Chat {
  return {
    ...createChatMeta(),
    root: { items: [] },
  };
}

function createStore() {
  return createChatDataStore({
    applyVolatileAssistantErrorsToChat: vi.fn(),
    hasActiveGeneration: vi.fn().mockReturnValue(false),
    isTaskRunning: vi.fn().mockReturnValue(false),
    onExternalGenerationStarted: vi.fn(),
    onExternalGenerationStopped: vi.fn(),
    onExternalGenerationAbortRequest: vi.fn(),
    onMigration: vi.fn(),
  });
}

describe('chat data store scoped settings updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeToChanges.mockReturnValue(() => undefined);
  });

  it('updates current metadata without loading the message tree', async () => {
    let persisted = createChatMeta();
    mockUpdateChatMeta.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const store = createStore();
    const live = createChat();
    store.registerLiveInstance({ chat: live });

    await store.updateChatScopedSettings({
      chatId: live.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'new-model',
        },
      ],
    });

    expect(persisted.modelId).toBe('new-model');
    expect(store.getLiveChatById({ chatId: live.id })?.modelId).toBe('new-model');
    expect(mockLoadChat).not.toHaveBeenCalled();
  });

  it('does not mutate the live chat when persistence fails', async () => {
    mockUpdateChatMeta.mockRejectedValueOnce(new Error('storage failed'));

    const store = createStore();
    const live = createChat();
    store.registerLiveInstance({ chat: live });

    await expect(store.updateChatScopedSettings({
      chatId: live.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'new-model',
        },
      ],
    })).rejects.toThrow('storage failed');

    expect(store.getLiveChatById({ chatId: live.id })?.modelId).toBe('old-model');
  });

  it('serializes updates for the same chat and preserves their order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let persisted = createChatMeta();
    let callCount = 0;

    mockUpdateChatMeta.mockImplementation(async ({ updater }) => {
      callCount += 1;
      if (callCount === 1) await firstGate;
      persisted = await updater({ current: persisted });
    });

    const store = createStore();
    const live = createChat();
    store.registerLiveInstance({ chat: live });

    const first = store.updateChatScopedSettings({
      chatId: live.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'first-model',
        },
      ],
    });
    const second = store.updateChatScopedSettings({
      chatId: live.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'second-model',
        },
      ],
    });

    await vi.waitFor(() => {
      expect(mockUpdateChatMeta).toHaveBeenCalledTimes(1);
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(mockUpdateChatMeta).toHaveBeenCalledTimes(2);
    expect(persisted.modelId).toBe('second-model');
    expect(store.getLiveChatById({ chatId: live.id })?.modelId).toBe('second-model');
  });

  it('continues queued updates after an earlier update fails', async () => {
    let persisted = createChatMeta();
    mockUpdateChatMeta
      .mockRejectedValueOnce(new Error('first failed'))
      .mockImplementationOnce(async ({ updater }) => {
        persisted = await updater({ current: persisted });
      });

    const store = createStore();
    const live = createChat();
    store.registerLiveInstance({ chat: live });

    const first = store.updateChatScopedSettings({
      chatId: live.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'failed-model',
        },
      ],
    });
    const second = store.updateChatScopedSettings({
      chatId: live.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'successful-model',
        },
      ],
    });

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBeUndefined();

    expect(persisted.modelId).toBe('successful-model');
    expect(store.getLiveChatById({ chatId: live.id })?.modelId).toBe('successful-model');
  });

  it('never_moves_updatedAt_backwards', async () => {
    let persisted = {
      ...createChatMeta(),
      updatedAt: 5000,
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(1234);
    mockUpdateChatMeta.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const store = createStore();
    const live = {
      ...createChat(),
      updatedAt: 5000,
    };
    store.registerLiveInstance({ chat: live });

    await store.updateChatScopedSettings({
      chatId: live.id,
      changes: [{ field: 'model_id', behavior: 'override', value: 'new-model' }],
    });

    expect(persisted.updatedAt).toBe(5001);
    expect(store.getLiveChatById({ chatId: live.id })?.updatedAt).toBe(5001);
    now.mockRestore();
  });

});
