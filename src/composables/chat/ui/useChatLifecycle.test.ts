import { autoTitleScheduler } from '@/composables/chat/global/auto-title-runtime';
import { chatRuntimeStore } from '@/composables/chat/global/chat-core-singletons';
import { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { Chat, ChatGroup } from '@/01-models/types';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddToast,
  mockEnsureChatWorkspaceMounted,
  mockGetEffectiveToolConfigsForChat,
  mockLoadData,
  mockRegisterLiveInstance,
  mockSetCurrentChatId,
  mockUpdateChatContent,
  mockUpdateChatMeta,
  mockUpdateHierarchy,
  mockCreatingChat,
  mockCurrentChatGroupRef,
  mockCurrentChatRef,
} = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockEnsureChatWorkspaceMounted: vi.fn().mockResolvedValue(undefined),
  mockGetEffectiveToolConfigsForChat: vi.fn(),
  mockLoadData: vi.fn().mockResolvedValue(undefined),
  mockRegisterLiveInstance: vi.fn(),
  mockSetCurrentChatId: vi.fn(),
  mockUpdateChatContent: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatMeta: vi.fn().mockResolvedValue(undefined),
  mockUpdateHierarchy: vi.fn(),
  mockCreatingChat: { value: false },
  mockCurrentChatGroupRef: { value: null as ChatGroup | null },
  mockCurrentChatRef: { value: null as Chat | null },
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    updateHierarchy: mockUpdateHierarchy,
    loadChat: vi.fn().mockResolvedValue(null),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    deleteChatGroup: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/features/tools/composables/useChatTools', () => ({
  getEffectiveToolConfigsForChat: mockGetEffectiveToolConfigsForChat,
  useChatTools: () => ({
    setCurrentChatId: mockSetCurrentChatId,
  }),
}));

vi.mock('@/features/tools/wesh/chat-workspace', () => ({
  ensureChatWorkspaceMounted: mockEnsureChatWorkspaceMounted,
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    addToast: mockAddToast,
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', async () => ({
  chatRuntimeStore: (await import('@/composables/chat/global/chat-runtime-store')).createChatRuntimeStore(),
  clearChatTmpDirectories: vi.fn(),
  creatingChat: mockCreatingChat,
  currentChatGroupRef: mockCurrentChatGroupRef,
  currentChatRef: mockCurrentChatRef,
  deleteChatTmpDirectory: vi.fn(),
  liveChatRegistry: new Map(),
  loadData: mockLoadData,
  registerLiveInstance: mockRegisterLiveInstance,
  updateChatContent: mockUpdateChatContent,
  updateChatMeta: mockUpdateChatMeta,
}));

vi.mock('./useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: vi.fn(),
  }),
}));

import { useChatLifecycle } from './useChatLifecycle';

describe('useChatLifecycle', () => {
  const groupId = toChatGroupId({ raw: 'workspace-group' });
  const existingChatId = toChatId({ raw: 'existing-chat' });

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    autoTitleScheduler.reset();
    chatRuntimeStore.clearActiveTaskCounts();
    chatRuntimeStore.activeTitleGenerations.clear();
    vi.mocked(storageService.loadChat).mockResolvedValue(null);
    mockCreatingChat.value = false;
    mockCurrentChatGroupRef.value = null;
    mockCurrentChatRef.value = null;
    mockEnsureChatWorkspaceMounted.mockResolvedValue(undefined);
    mockGetEffectiveToolConfigsForChat.mockReturnValue([{
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'none' },
    }]);
    mockUpdateHierarchy.mockImplementation(async ({ updater }) => {
      const current = {
        items: [{
          type: 'chat_group',
          id: groupId,
          chat_ids: [existingChatId],
        }],
      };
      await updater({ current });
    });
  });

  afterEach(() => {
    autoTitleScheduler.reset();
    vi.useRealTimers();
  });

  it('cancels pending and active titles immediately during the deletion undo window', async () => {
    vi.useFakeTimers();
    const chat: Chat = { id: existingChatId, title: null, createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false };
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);
    const controller = new AbortController();
    chatRuntimeStore.setActiveTitleGeneration({ chatId: existingChatId, controller });
    const run = vi.fn().mockResolvedValue(undefined);
    autoTitleScheduler.schedule({ chatId: existingChatId, run });
    await useChatLifecycle().deleteChat({ id: existingChatId, injectAddToast: () => 'undo-toast' });
    expect(controller.signal.aborted).toBe(true);
    expect(chatRuntimeStore.getActiveTitleGeneration({ chatId: existingChatId })).toBeUndefined();
    expect(storageService.deleteChat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
  });

  it('clears every pending title and aborts title controllers when deleting all chats', async () => {
    vi.useFakeTimers();
    const other = toChatId({ raw: 'other-chat' });
    const first = new AbortController(); const second = new AbortController();
    chatRuntimeStore.setActiveTitleGeneration({ chatId: existingChatId, controller: first });
    chatRuntimeStore.setActiveTitleGeneration({ chatId: other, controller: second });
    const run = vi.fn().mockResolvedValue(undefined);
    autoTitleScheduler.schedule({ chatId: existingChatId, run });
    autoTitleScheduler.schedule({ chatId: other, run });
    await useChatLifecycle().deleteAllChats();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(chatRuntimeStore.activeTitleGenerations.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
  });

  it('provisions a workspace only for the newly created chat when Shell Execute is effectively enabled', async () => {
    const lifecycle = useChatLifecycle();

    const created = await lifecycle.createNewChat({
      groupId,
      modelId: undefined,
      systemPrompt: undefined,
    });

    expect(created).not.toBeNull();
    expect(created?.groupId).toBe(groupId);
    expect(mockGetEffectiveToolConfigsForChat).toHaveBeenCalledWith({ chat: created });
    expect(mockEnsureChatWorkspaceMounted).toHaveBeenCalledTimes(1);
    expect(mockEnsureChatWorkspaceMounted).toHaveBeenCalledWith({ chat: created });
    expect(mockEnsureChatWorkspaceMounted).not.toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ id: existingChatId }),
    }));
  });

  it('does not provision a workspace when Shell Execute is not effectively enabled', async () => {
    mockGetEffectiveToolConfigsForChat.mockReturnValue([]);
    const lifecycle = useChatLifecycle();

    const created = await lifecycle.createNewChat({
      groupId,
      modelId: undefined,
      systemPrompt: undefined,
    });

    expect(created).not.toBeNull();
    expect(mockEnsureChatWorkspaceMounted).not.toHaveBeenCalled();
  });
  it('creates a grouped assistant chat without replacing the selected regular chat or group', async () => {
    const existing: Chat = { id: existingChatId, title: 'Main chat', createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false };
    const group: ChatGroup = { id: groupId, name: 'Images', isCollapsed: false, updatedAt: 1, items: [] };
    mockCurrentChatRef.value = existing; mockCurrentChatGroupRef.value = group;
    const created = await useChatLifecycle().createChatWithoutSelecting({ groupId, modelId: 'custom-model', systemPrompt: undefined });
    expect(created).toMatchObject({ groupId, modelId: 'custom-model' });
    expect(mockCurrentChatRef.value).toBe(existing); expect(mockCurrentChatGroupRef.value).toBe(group);
    expect(mockSetCurrentChatId).not.toHaveBeenCalled();
    expect(mockUpdateHierarchy).toHaveBeenCalledOnce(); expect(mockLoadData).toHaveBeenCalledOnce();
    expect(mockRegisterLiveInstance).toHaveBeenCalledOnce(); expect(mockUpdateChatMeta).toHaveBeenCalledOnce();
    expect(mockCreatingChat.value).toBe(false);
  });
  it('releases the creation gate on failure while preserving main-chat navigation', async () => {
    mockUpdateChatContent.mockRejectedValueOnce(new Error('save failure'));
    await expect(useChatLifecycle().createChatWithoutSelecting({ groupId, modelId: undefined, systemPrompt: undefined })).rejects.toThrow('save failure');
    expect(mockCreatingChat.value).toBe(false); expect(mockSetCurrentChatId).not.toHaveBeenCalled();
  });

});
