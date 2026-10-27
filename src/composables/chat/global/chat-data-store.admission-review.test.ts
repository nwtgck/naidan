import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, ChatContent, ChatGroup, Settings } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { idToRaw, toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';
import { createChatContentWrite } from '@/00-storage/service/chat-content-binding';
import { rememberSavedLocalModelReference, TEST_ONLY as localReferences, type LocalModelPromotion } from '@/00-storage/service/local-model-references';

const state = vi.hoisted(() => ({
  loadChat: vi.fn(),
  promotions: new Set<({ promotion }: { promotion: LocalModelPromotion }) => void>(),
  settings: undefined as Settings | undefined,
}));
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      get value() {
        if (state.settings === undefined) {
          throw new Error('Missing review settings');
        }
        return state.settings;
      },
    },
  }),
}));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    subscribeLocalModelPromotions: ({ listener }: { listener({ promotion }: { promotion: LocalModelPromotion }): void }) => {
      state.promotions.add(listener);
      return () => state.promotions.delete(listener);
    },
    subscribeToChanges: () => () => {},
    loadChat: state.loadChat,
    loadChatForModelBinding: async ({ id }: { id: Chat['id'] }) => ({ status: 'loaded', chat: await state.loadChat({ id }), isCurrent: () => true }),
    createChatContentWrite: ({ id, content }: { id: Chat['id'], content: ChatContent | undefined }) => createChatContentWrite({ id, content, binding: undefined, isCurrent: () => true }),
    getSidebarStructure: async () => [],
    listChatGroups: async () => [],
  },
}));

import { createChatDataStore } from './chat-data-store';

const sourceModelId = '~user/Repo/Model';
const savedModelId = 'user/Repo/Model';

function originalChat(): Chat {
  return { id: toChatId({ raw: 'review-chat' }), title: 'Original title', createdAt: 1, updatedAt: 1, debugEnabled: false, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, root: { items: [] } };
}

async function setupChat() {
  const store = createChatDataStore({
    pruneVolatileAssistantErrorsForChat: () => {},
    hasActiveGeneration: () => false,
    isTaskRunning: () => false,
    onExternalGenerationStarted: () => {},
    onExternalGenerationStopped: () => {},
    onExternalGenerationAbortRequest: () => {},
    onMigration: () => {},
  });
  const original = originalChat();
  state.loadChat.mockResolvedValueOnce(structuredClone(original));
  const live = await store.openChat({ id: original.id, leafId: undefined });
  if (live === null) {
    throw new Error('Missing review chat');
  }
  return { store, original, live };
}

function publishSavedModel({ chatId }: { chatId: Chat['id'] }): void {
  const reference = { sourceModelId, modelId: savedModelId, isCurrent: () => true, isIdentityCurrent: () => true, retain: () => ({ release() {} }), withCurrentFiles: async ({ operation }: { operation(): Promise<void> }) => operation() };
  rememberSavedLocalModelReference({ reference });
  const promotion: LocalModelPromotion = { owner: { kind: 'chat', id: chatId }, changes: [{ slot: 'model', ...reference }], isCurrent: () => true };
  for (const listener of state.promotions) {
    listener({ promotion });
  }
}

beforeEach(() => {
  state.loadChat.mockReset();
  state.promotions.clear();
  localReferences.reset();
  state.settings = { ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'memory' };
});

describe('generation admission review', () => {
  it('accepts a proven File-to-OPFS promotion that finishes during its stored snapshot read', async () => {
    const { store, original, live } = await setupChat();
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    publishSavedModel({ chatId: original.id });
    expect(live.modelId).toBe(savedModelId);
    read.resolve({ ...original, modelId: savedModelId });
    expect(await admission).toBe('synchronized');
    expect(live.modelId).toBe(savedModelId);
    expect(live.root.items).toEqual([]);
  });

  it('accepts the same promotion when it finishes before admission starts', async () => {
    const { store, original, live } = await setupChat();
    publishSavedModel({ chatId: original.id });
    state.loadChat.mockResolvedValueOnce({ ...original, modelId: savedModelId });
    expect(await store.synchronizeModelBindingContent({ chatId: original.id })).toBe('synchronized');
    expect(live.modelId).toBe(savedModelId);
  });

  it('does not reject sending because an unrelated title is edited during the read, and preserves that edit', async () => {
    const { store, original, live } = await setupChat();
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    live.title = 'A newer title';
    live.systemPrompt = { behavior: 'append', content: 'A newer prompt' };
    read.resolve({ ...original, currentLeafId: toMessageId({ raw: 'saved-leaf' }) });
    expect(await admission).toBe('synchronized');
    expect(live.title).toBe('A newer title');
    expect(live.systemPrompt).toEqual({ behavior: 'append', content: 'A newer prompt' });
    expect(live.currentLeafId).toBe('saved-leaf');
    expect(live.modelId).toBe(sourceModelId);
  });

  it('retains message node identity when the stored content is already current', async () => {
    const { store, original, live } = await setupChat();
    const root = live.root;
    state.loadChat.mockResolvedValueOnce(structuredClone(original));
    expect(await store.synchronizeModelBindingContent({ chatId: original.id })).toBe('synchronized');
    expect(live.root).toBe(root);
  });

  it('continues to preserve an unsaved content edit instead of replacing it', async () => {
    const { store, original, live } = await setupChat();
    live.currentLeafId = toMessageId({ raw: 'unsaved-selection' });
    expect(await store.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
    expect(live.currentLeafId).toBe('unsaved-selection');
    expect(state.loadChat).toHaveBeenCalledOnce();
  });

  it('does not replace a newer explicit model selection with a stale stored model', async () => {
    const { store, original, live } = await setupChat();
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    live.modelId = 'hf.co/Other/Repo:Q4';
    read.resolve(structuredClone(original));
    expect(await admission).toBe('changed');
    expect(live.modelId).toBe('hf.co/Other/Repo:Q4');
  });

  it('does not overwrite an endpoint edited in place during the read', async () => {
    const { store, original, live } = await setupChat();
    original.endpoint = { type: 'openai', url: 'https://old.example/v1' };
    live.endpoint = { ...original.endpoint };
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    live.endpoint.url = 'https://new.example/v1';
    read.resolve(original);
    expect(await admission).toBe('changed');
    expect(live.endpoint.url).toBe('https://new.example/v1');
  });

  it('does not overwrite a chat-group move made during the read', async () => {
    const { store, original, live } = await setupChat();
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    const chatGroupId = toChatGroupId({ raw: 'new-chat-group' });
    live.groupId = chatGroupId;
    read.resolve(original);
    expect(await admission).toBe('changed');
    expect(live.groupId).toBe(chatGroupId);
  });

  it('preserves a new inherited selection even when its current value matches the former override', async () => {
    const { store, original, live } = await setupChat();
    state.settings!.defaultModelId = sourceModelId;
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    live.modelId = undefined;
    read.resolve(original);
    expect(await admission).toBe('changed');
    expect(live.modelId).toBeUndefined();
  });

  it('accepts a proven promotion of an inherited global model without creating a chat override', async () => {
    const { store, original, live } = await setupChat();
    live.modelId = original.modelId = undefined;
    state.settings!.defaultModelId = sourceModelId;
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    publishSavedModel({ chatId: original.id });
    state.settings!.defaultModelId = savedModelId;
    read.resolve(original);
    expect(await admission).toBe('synchronized');
    expect(live.modelId).toBeUndefined();
  });

  it('does not reject an overridden binding when an unrelated global model changes during the read', async () => {
    const { store, original } = await setupChat();
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    state.settings!.defaultModelId = 'another-global-model';
    read.resolve(original);
    expect(await admission).toBe('synchronized');
  });

  it('rejects a genuinely changed inherited global model during the read', async () => {
    const { store, original, live } = await setupChat();
    live.modelId = original.modelId = undefined;
    state.settings!.defaultModelId = sourceModelId;
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    state.settings!.defaultModelId = 'another-global-model';
    read.resolve(original);
    expect(await admission).toBe('changed');
    expect(live.modelId).toBeUndefined();
  });

  it.each(['promotion', 'selection'] as const)('distinguishes an inherited chat-group model %s during the read', async change => {
    const { store, original, live } = await setupChat();
    const chatGroupId = toChatGroupId({ raw: 'model-chat-group' });
    live.groupId = original.groupId = chatGroupId;
    live.endpoint = original.endpoint = undefined;
    live.modelId = original.modelId = undefined;
    const chatGroup: ChatGroup = { id: chatGroupId, name: 'Models', isCollapsed: false, updatedAt: 1, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, items: [{ type: 'chat', id: idToRaw({ id: original.id }), chat: original }] };
    store.rootItems.value = [{ type: 'chat_group', id: idToRaw({ id: chatGroupId }), chatGroup }];
    const read = Promise.withResolvers<Chat>();
    state.loadChat.mockReturnValueOnce(read.promise);
    const admission = store.synchronizeModelBindingContent({ chatId: original.id });
    switch (change) {
    case 'promotion':
      publishSavedModel({ chatId: original.id });
      chatGroup.modelId = savedModelId;
      break;
    case 'selection': chatGroup.modelId = 'another-chat-group-model';
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    read.resolve(original);
    expect(await admission).toBe(change === 'promotion' ? 'synchronized' : 'changed');
    expect(live.modelId).toBeUndefined();
    expect(live.endpoint).toBeUndefined();
    expect(live.groupId).toBe(chatGroupId);
  });
});
