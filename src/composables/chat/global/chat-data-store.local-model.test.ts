import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { storageService, StorageService } from '@/00-storage/service';
import { LocalStorageProvider } from '@/00-storage/service/local-storage';
import { DEFAULT_SETTINGS, type ChatMeta, type ChatGroup } from '@/01-models/types';
import { idToRaw, toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { LOCK_METADATA, STORAGE_KEY_PREFIX } from '@/constants';
import { createChatDataStore } from './chat-data-store';
vi.mock('@/strings', () => ({ ensureStrings: new Proxy({}, { get: () => async () => 'storage error' }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));
const chatId = toChatId({ raw: 'existing-local-chat' });
const chatGroupId = toChatGroupId({ raw: 'existing-local-chat-group' });
const modelId = 'temp/actual-files:Q4_K_M';
const titleGeneration = { endpoint: 'same_scope' as const, model: 'same_scope' as const, lmParameters: 'same_scope' as const };
const originalLocks = navigator.locks;

function simulatedWebLocks() {
  const lanes = new Map<string, Promise<void>>();
  return {
    async request(name: string, operation: () => Promise<unknown>) {
      const previous = lanes.get(name) ?? Promise.resolve();
      const finished = Promise.withResolvers<void>();
      const tail = previous.then(() => finished.promise);
      lanes.set(name, tail);
      await previous;
      try {
        return await operation();
      } finally {
        finished.resolve();
        if (lanes.get(name) === tail) {
          lanes.delete(name);
        }
      }
    },
  };
}

async function fixture({ chatOverrides, chatGroupOverrides }: { chatOverrides: Partial<ChatMeta> | undefined, chatGroupOverrides: Partial<ChatGroup> | undefined }): Promise<StorageService> {
  const service = storageService;
  await service.init({ type: 'local' });
  await service.updateSettings({ updater: () => ({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: 'https://global.invalid' }, defaultModelId: 'global-model' }) });
  await service.updateChatGroup({ id: chatGroupId, updater: () => ({ id: chatGroupId, name: 'Existing chat group', isCollapsed: false, items: [], updatedAt: 1, endpoint: { type: 'ollama', url: 'https://chat-group.invalid' }, titleGeneration: 'inherit', ...chatGroupOverrides }) });
  await service.updateChatMeta({ id: chatId, updater: () => ({ id: chatId, title: 'Existing chat', createdAt: 1, updatedAt: 1, debugEnabled: false, groupId: chatGroupId, modelId: 'chat-model', systemPrompt: { content: 'Keep this prompt', behavior: 'append' }, ...chatOverrides }) });
  await service.updateChatContent({ id: chatId, write: service.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => ({ root: { items: [] } }) });
  await service.updateHierarchy({ updater: () => ({ items: [{ type: 'chat_group', id: chatGroupId, chat_ids: [chatId] }] }) });
  return service;
}


function createStore() {
  return createChatDataStore({ pruneVolatileAssistantErrorsForChat: vi.fn(), hasActiveGeneration: () => false, isTaskRunning: () => false, onExternalGenerationStarted: vi.fn(), onExternalGenerationStopped: vi.fn(), onExternalGenerationAbortRequest: vi.fn(), onMigration: vi.fn() });
}

function apply({ store, isCurrent }: { store: ReturnType<typeof createStore>, isCurrent(): boolean }) {
  return store.updateEmptyChatScopedSettings({
    chatId,
    isCurrent,
    changes: [
      { field: 'endpoint', behavior: 'override', value: { type: 'llama_cpp_browser' } },
      { field: 'model_id', behavior: 'override', value: modelId },
      { field: 'title_generation', behavior: 'override', value: titleGeneration },
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: simulatedWebLocks() });
});

afterEach(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks }));

describe('existing empty chat model updates with real storage', () => {
  it('patches the latest metadata without changing messages, global settings, hierarchy or chat groups', async () => {
    const service = await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const settings = await service.loadSettings();
    const hierarchy = await service.loadHierarchy();
    const chatGroup = await service.loadChatGroup({ id: chatGroupId });
    const content = await service.loadChatContent({ id: chatId });
    const store = createStore();
    store.registerLiveInstance({ chat: reactive((await service.loadChat({ id: chatId }))!) });
    expect(await apply({ store, isCurrent: () => true })).toBe(true);
    expect(await service.loadChatMeta({ id: chatId })).toMatchObject({ id: chatId, groupId: chatGroupId, modelId, endpoint: { type: 'llama_cpp_browser' }, titleGeneration, title: 'Existing chat', systemPrompt: { content: 'Keep this prompt', behavior: 'append' } });
    expect(store.getLiveChatById({ chatId })?.modelId).toBe(modelId);
    expect(await service.loadSettings()).toEqual(settings);
    expect(await service.loadHierarchy()).toEqual(hierarchy);
    const { items: _beforeItems, ...beforeChatGroup } = chatGroup!;
    const { items: _afterItems, ...afterChatGroup } = (await service.loadChatGroup({ id: chatGroupId }))!;
    expect(afterChatGroup).toEqual(beforeChatGroup);
    expect(await service.loadChatContent({ id: chatId })).toEqual(content);
  });

  it.each(['chat', 'chat-group', 'both'] as const)('accepts a live unset title after provider normalization: %s', async scope => {
    const service = await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const live = (await service.loadChat({ id: chatId }))!;
    if (scope !== 'chat-group') {
      live.titleGeneration = undefined;
    }
    const store = createStore();
    store.registerLiveInstance({ chat: reactive(live) });
    expect(await apply({ store, isCurrent: () => true })).toBe(true);
    expect(store.getLiveChatById({ chatId })?.modelId).toBe(modelId);
  });

  it('does not compare proxy-backed model or endpoint snapshots', async () => {
    const service = await fixture({ chatOverrides: { endpoint: { url: 'https://old.invalid', type: 'openai' } }, chatGroupOverrides: undefined });
    const store = createStore();
    store.registerLiveInstance({ chat: reactive((await service.loadChat({ id: chatId }))!) });
    await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: 'changed-before-use' }) });
    expect(await apply({ store, isCurrent: () => true })).toBe(true);
  });

  it.each(['model', 'title', 'chat-group', 'global', 'membership', 'runtime-context', 'runtime-destination', 'changed-and-restored'] as const)('allows unrelated or intentionally replaced settings: %s', async change => {
    const service = await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    switch (change) {
    case 'model': await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: 'different' }) });
      break;
    case 'title': await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, title: 'Latest title' }) });
      break;
    case 'chat-group': await service.updateChatGroup({ id: chatGroupId, updater: ({ current }) => ({ ...current!, modelId: 'different' }) });
      break;
    case 'global': await service.updateSettings({ updater: ({ current }) => ({ ...current!, defaultModelId: 'different', experimental: { locale: 'ja' } }) });
      break;
    case 'membership': await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, groupId: undefined }) });
      break;
    case 'runtime-context': case 'runtime-destination': await service.updateSettings({ updater: ({ current }) => ({ ...current!, experimental: { llamaCppBrowser: { contextTokens: 4096 } } }) });
      break;
    case 'changed-and-restored':
      await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: 'different' }) });
      await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: 'chat-model' }) });
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    const before = (await service.loadChatMeta({ id: chatId }))!;
    expect(await apply({ store: createStore(), isCurrent: () => true })).toBe(true);
    expect(await service.loadChatMeta({ id: chatId })).toMatchObject({ ...before, endpoint: { type: 'llama_cpp_browser' }, modelId, titleGeneration, updatedAt: expect.any(Number) });
  });

  it.each(['nonempty-root', 'deleted', 'missing-content', 'source', 'provider'] as const)('does not write an unavailable target: %s', async change => {
    const service = await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    let current = true;
    const providerCurrent = service.captureSettingsStorage();
    switch (change) {
    case 'nonempty-root': await service.updateChatContent({ id: chatId, write: service.createChatContentWrite({ id: chatId, content: (await service.loadChatContent({ id: chatId }))!, binding: undefined }), updater: () => ({ root: { items: [{ id: toMessageId({ raw: 'hidden-branch' }), role: 'user', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } }] } }) });
      break;
    case 'deleted': await service.deleteChat({ id: chatId });
      break;
    case 'missing-content': localStorage.removeItem(`${STORAGE_KEY_PREFIX}lsp:chat_content:${idToRaw({ id: chatId })}`);
      break;
    case 'source': current = false;
      break;
    case 'provider': await service.init({ type: 'memory' });
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    using _save = vi.spyOn(LocalStorageProvider.prototype, 'saveChatMeta');
    expect(await apply({ store: createStore(), isCurrent: () => current && providerCurrent() })).toBe(false);
    expect(_save).not.toHaveBeenCalled();
  });

  it('checks messages after waiting for the same metadata lock as content writers', async () => {
    await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using _cleanup = {
      [Symbol.dispose]() {
        release.resolve();
      },
    };
    const blocker = navigator.locks.request(LOCK_METADATA, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = apply({ store: createStore(), isCurrent: () => true });
    const provider = new LocalStorageProvider();
    await provider.init();
    await provider.saveChatContent({ id: chatId, content: { root: { items: [{ id: toMessageId({ raw: 'external-message' }), role: 'user', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } }] } } });
    release.resolve();
    await blocker;
    expect(await pending).toBe(false);
  });

  it('retries definite write failures without rolling back the latest metadata', async () => {
    const service = await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const store = createStore();
    using _save = vi.spyOn(LocalStorageProvider.prototype, 'saveChatMeta').mockRejectedValueOnce(new Error('write failed'));
    await expect(apply({ store, isCurrent: () => true })).rejects.toThrow('write failed');
    await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, title: 'Concurrent title' }) });
    expect(await apply({ store, isCurrent: () => true })).toBe(true);
    expect((await service.loadChatMeta({ id: chatId }))?.title).toBe('Concurrent title');
  });

  it('uses the latest metadata again after a lost write acknowledgement', async () => {
    const service = await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const store = createStore();
    const original = LocalStorageProvider.prototype.saveChatMeta;
    using _save = vi.spyOn(LocalStorageProvider.prototype, 'saveChatMeta').mockImplementationOnce(async function(this: LocalStorageProvider, { meta }) {
      await original.call(this, { meta });
      throw new Error('lost acknowledgement');
    });
    await expect(apply({ store, isCurrent: () => true })).rejects.toThrow('lost acknowledgement');
    expect(await apply({ store, isCurrent: () => true })).toBe(true);
    expect((await service.loadChatMeta({ id: chatId }))?.modelId).toBe(modelId);
  });

  it('rechecks source validity after reading content immediately before writing', async () => {
    await fixture({ chatOverrides: undefined, chatGroupOverrides: undefined });
    let current = true;
    const original = LocalStorageProvider.prototype.loadChatContentWithoutAttachments;
    using _read = vi.spyOn(LocalStorageProvider.prototype, 'loadChatContentWithoutAttachments').mockImplementationOnce(async function(this: LocalStorageProvider, args) {
      const result = await original.call(this, args);
      current = false;
      return result;
    });
    expect(await apply({ store: createStore(), isCurrent: () => current })).toBe(false);
  });

  it('supports memory-only chats without Web Locks', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await storageService.init({ type: 'memory' });
    await storageService.updateChatMeta({ id: chatId, updater: () => ({ id: chatId, title: null, createdAt: 1, updatedAt: 1, debugEnabled: false }) });
    await storageService.updateChatContent({ id: chatId, write: storageService.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => ({ root: { items: [] } }) });
    expect(await apply({ store: createStore(), isCurrent: () => true })).toBe(true);
  });
});
