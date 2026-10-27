import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idToRaw, toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS, type Chat, type ChatGroup, type ChatMeta, type Endpoint } from '@/01-models/types';
import type { ChatDataStore } from '@/composables/chat/global/chat-data-store';
import { createChatDataStore } from '@/composables/chat/global/chat-data-store';
import type { storageService } from '@/00-storage/service';
import { applyModelConnectionSelection } from './apply-model-connection';

const mocks = vi.hoisted(() => ({
  commitGlobal: vi.fn<({ endpoint, modelId, isCurrent }: { endpoint: Endpoint, modelId: string, isCurrent(): boolean }) => Promise<'applied' | 'changed'>>(),
  resumeModels: vi.fn(),
  applyChat: vi.fn<ChatDataStore['updateChatScopedSettings']>(),
  updateChatMeta: vi.fn<typeof storageService.updateChatMeta>(),
  loadChat: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: { value: { endpoint: { type: 'openai', url: '' } } }, commitGlobalModelConnection: mocks.commitGlobal, resumeModelRefresh: mocks.resumeModels }) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ updateChatScopedSettings: mocks.applyChat }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    subscribeLocalModelPromotions: vi.fn(() => () => {}),
    getSidebarStructure: vi.fn(async () => []),
    loadChat: mocks.loadChat,
    listChatGroups: vi.fn(async () => []),
    subscribeToChanges: vi.fn(() => () => {}),
    updateChatMeta: mocks.updateChatMeta,
  },
}));

const chatId = toChatId({ raw: 'selected-chat' });
const chatGroupId = toChatGroupId({ raw: 'selected-chat-group' });
let stored: ChatMeta | null;
let store: ChatDataStore;
let live: Chat;
let chatGroup: ChatGroup;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitGlobal.mockResolvedValue('applied');
  const meta: ChatMeta = {
    id: chatId,
    title: 'Keep this title',
    groupId: chatGroupId,
    createdAt: 1,
    updatedAt: 2,
    debugEnabled: true,
    titleGeneration: 'disabled',
    systemPrompt: { behavior: 'append', content: 'Keep this prompt' },
    lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.2, reasoning: { effort: 'high' } },
  };
  stored = structuredClone(meta);
  live = {
    ...meta,
    root: { items: [{ id: toMessageId({ raw: 'user-message' }), role: 'user', createdAt: 3, parts: [{ type: 'text', text: 'Keep this message', completeness: 'complete' }], modelId: undefined, lmParameters: undefined, replies: { items: [] } }] },
  };
  chatGroup = { id: chatGroupId, name: 'Keep this chat group', isCollapsed: false, items: [], updatedAt: 1, endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'chat-group-model' };
  store = createChatDataStore({
    pruneVolatileAssistantErrorsForChat: vi.fn(),
    hasActiveGeneration: () => false,
    isTaskRunning: () => false,
    onExternalGenerationStarted: vi.fn(),
    onExternalGenerationStopped: vi.fn(),
    onExternalGenerationAbortRequest: vi.fn(),
    onMigration: vi.fn(),
  });
  store.registerLiveInstance({ chat: live });
  store.rootItems.value = [{ id: idToRaw({ id: chatGroupId }), type: 'chat_group', chatGroup }];
  mocks.applyChat.mockImplementation(store.updateChatScopedSettings);
  mocks.updateChatMeta.mockImplementation(async ({ updater }) => {
    const updated = await updater({ current: stored });
    if (updated !== undefined) {
      stored = updated;
    }
  });
});

describe('model connection selection application', () => {
  it('commits a home selection globally without changing a chat or chat group', async () => {
    const beforeChat = structuredClone(live);
    const beforeChatGroup = structuredClone(chatGroup);
    await applyModelConnectionSelection({ target: { kind: 'home' }, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => true });
    expect(mocks.commitGlobal).toHaveBeenCalledWith({ endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: expect.any(Function) });
    expect(mocks.applyChat).not.toHaveBeenCalled();
    expect(mocks.resumeModels).toHaveBeenCalledOnce();
    expect(live).toEqual(beforeChat);
    expect(chatGroup).toEqual(beforeChatGroup);
  });

  it('sets both chat overrides while preserving inherited scopes and existing history', async () => {
    const beforeMetadata = structuredClone(stored);
    const beforeChatGroup = structuredClone(chatGroup);
    const beforeRoot = store.getLiveChatById({ chatId })?.root;
    await applyModelConnectionSelection({ target: { kind: 'chat', chatId }, endpoint: { type: 'openai', url: 'https://chosen.example/v1', httpHeaders: [['Authorization', 'Bearer token']] }, modelId: 'chosen-model', isCurrent: () => true });
    expect(stored).toEqual({ ...beforeMetadata, endpoint: { type: 'openai', url: 'https://chosen.example/v1', httpHeaders: [['Authorization', 'Bearer token']] }, modelId: 'chosen-model', updatedAt: expect.any(Number) });
    const selected = store.getLiveChatById({ chatId });
    expect(selected?.root).toBe(beforeRoot);
    expect(selected?.root.items[0]?.parts).toEqual([{ type: 'text', text: 'Keep this message', completeness: 'complete' }]);
    expect(selected?.titleGeneration).toBe('disabled');
    expect(selected?.lmParameters).toEqual(beforeMetadata?.lmParameters);
    expect(selected?.groupId).toBe(chatGroupId);
    expect(chatGroup).toEqual(beforeChatGroup);
    expect(mocks.commitGlobal).not.toHaveBeenCalled();
    expect(mocks.resumeModels).not.toHaveBeenCalled();
    expect(mocks.updateChatMeta).toHaveBeenCalledOnce();
    expect(mocks.loadChat).not.toHaveBeenCalled();
  });

  it('merges against the latest metadata instead of comparing all chat fields with an old snapshot', async () => {
    const gate = Promise.withResolvers<void>();
    mocks.updateChatMeta.mockImplementationOnce(async ({ updater }) => {
      await gate.promise;
      const updated = await updater({ current: stored });
      if (updated !== undefined) {
        stored = updated;
      }
    });
    const pending = applyModelConnectionSelection({ target: { kind: 'chat', chatId }, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => true });
    stored = { ...stored!, title: 'Concurrent title', modelId: 'another-model', lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.9, reasoning: { effort: 'low' } } };
    gate.resolve();
    await pending;
    expect(stored).toMatchObject({ title: 'Concurrent title', endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', lmParameters: { temperature: 0.9, reasoning: { effort: 'low' } } });
  });

  it.each(['home', 'chat'] as const)('does not save an expired %s selection', async kind => {
    const target = kind === 'home' ? { kind } : { kind, chatId };
    await expect(applyModelConnectionSelection({ target, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => false })).rejects.toThrow('no longer current');
    expect(mocks.commitGlobal).not.toHaveBeenCalled();
    expect(mocks.applyChat).not.toHaveBeenCalled();
    expect(mocks.resumeModels).not.toHaveBeenCalled();
  });

  it('rejects a queued chat selection when its owner or storage expires before the write', async () => {
    let current = true;
    const before = structuredClone(stored);
    const pending = applyModelConnectionSelection({ target: { kind: 'chat', chatId }, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => current });
    current = false;
    await expect(pending).rejects.toThrow('no longer current');
    expect(stored).toEqual(before);
    expect(mocks.updateChatMeta).not.toHaveBeenCalled();
  });

  it('rejects a missing chat without creating or changing another chat', async () => {
    stored = null;
    await expect(applyModelConnectionSelection({ target: { kind: 'chat', chatId }, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => true })).rejects.toThrow('Chat not found');
    expect(store.getLiveChatById({ chatId })?.endpoint).toBeUndefined();
    expect(mocks.commitGlobal).not.toHaveBeenCalled();
  });

  it('keeps the current chat settings when saving fails', async () => {
    mocks.updateChatMeta.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(applyModelConnectionSelection({ target: { kind: 'chat', chatId }, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => true })).rejects.toThrow('Storage unavailable');
    expect(store.getLiveChatById({ chatId })?.endpoint).toBeUndefined();
    expect(store.getLiveChatById({ chatId })?.modelId).toBeUndefined();
  });

  it('does not report a declined global write as a successful selection', async () => {
    mocks.commitGlobal.mockResolvedValueOnce('changed');
    await expect(applyModelConnectionSelection({ target: { kind: 'home' }, endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model', isCurrent: () => true })).rejects.toThrow('no longer current');
    expect(mocks.applyChat).not.toHaveBeenCalled();
    expect(mocks.resumeModels).not.toHaveBeenCalled();
  });

  it('does not release a model refresh after a failed global save', async () => {
    mocks.commitGlobal.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(applyModelConnectionSelection({ target: { kind: 'home' }, endpoint: { type: 'openai', url: 'https://chosen.example/v1' }, modelId: 'chosen-model', isCurrent: () => true })).rejects.toThrow('Storage unavailable');
    expect(mocks.resumeModels).not.toHaveBeenCalled();
  });

  it('does not release a model refresh if its owner expires while saving globally', async () => {
    let current = true;
    mocks.commitGlobal.mockImplementationOnce(async () => {
      current = false;
      return 'applied';
    });
    await expect(applyModelConnectionSelection({ target: { kind: 'home' }, endpoint: { type: 'openai', url: 'https://chosen.example/v1' }, modelId: 'chosen-model', isCurrent: () => current })).rejects.toThrow('no longer current');
    expect(mocks.resumeModels).not.toHaveBeenCalled();
  });
});
