import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { Chat, ChatContent, ChatMeta, UserMessageNode } from '@/01-models/types';
import { toChatId, toMessageId } from '@/01-models/ids';
import { ChatContentBindingChangedError, createChatContentWrite, snapshotChatContent, type ChatContentWrite } from '@/00-storage/service/chat-content-binding';
import { rememberSavedLocalModelReference, TEST_ONLY as localReferences, type LocalModelPromotion } from '@/00-storage/service/local-model-references';
import type { StorageChangeEvent } from '@/00-storage/service/synchronizer';

const { loadChat, updateContent, updateMeta, subscribe, promotions } = vi.hoisted(() => ({ promotions: new Set<({ promotion }: { promotion: LocalModelPromotion }) => void>(), loadChat: vi.fn(), updateContent: vi.fn(), updateMeta: vi.fn(), subscribe: vi.fn((_args: { listener: ({ event }: { event: StorageChangeEvent }) => void | Promise<void> }) => () => undefined) }));
vi.mock('@/composables/useSettings', async () => {
  const { ref } = await import('vue');
  const { DEFAULT_SETTINGS } = await import('@/01-models/types');
  const settings = ref({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
  return { useSettings: () => ({ settings }) };
});

vi.mock('@/00-storage/service', () => ({
  storageService: {
    subscribeLocalModelPromotions: ({ listener }: { listener({ promotion }: { promotion: LocalModelPromotion }): void }) => {
      promotions.add(listener);
      return () => {
        promotions.delete(listener);
      };
    },
    loadChat,
    loadChatForModelBinding: async ({ id }: { id: Chat['id'] }) => ({ status: 'loaded', chat: await loadChat({ id }), isCurrent: () => true }),
    createChatContentWrite: ({ id, content }: { id: Chat['id'], content: ChatContent | undefined }) => createChatContentWrite({ id, content, binding: undefined, isCurrent: () => true }),
    updateChatContent: updateContent,
    updateChatMeta: updateMeta,
    subscribeToChanges: subscribe,
    getSidebarStructure: vi.fn(async () => []),
    listChatGroups: vi.fn(async () => []),
  },
}));
import { createChatDataStore, type ChatDataStore } from './chat-data-store';

function chat(): Chat {
  return { id: toChatId({ raw: 'owner' }), title: 'Owner', createdAt: 1, updatedAt: 1, debugEnabled: false, root: { items: [] } };
}

function branchedChat({ modelId }: { modelId: string | undefined }): Chat {
  const firstLeaf: UserMessageNode = { id: toMessageId({ raw: 'first-leaf' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
  const secondLeaf: UserMessageNode = { ...firstLeaf, id: toMessageId({ raw: 'second-leaf' }) };
  const firstParent: UserMessageNode = { ...firstLeaf, id: toMessageId({ raw: 'first-parent' }), replies: { items: [firstLeaf] } };
  return { ...chat(), modelId, currentLeafId: secondLeaf.id, root: { items: [firstParent, secondLeaf] } };
}

function store() {
  return createChatDataStore({ pruneVolatileAssistantErrorsForChat: vi.fn(), hasActiveGeneration: () => false, isTaskRunning: () => false, onExternalGenerationStarted: vi.fn(), onExternalGenerationStopped: vi.fn(), onExternalGenerationAbortRequest: vi.fn(), onMigration: vi.fn() });
}

async function installSaved({ registry, value }: { registry: ChatDataStore, value: Chat }): Promise<Chat> {
  loadChat.mockResolvedValueOnce(structuredClone(value));
  const live = await registry.openChat({ id: value.id, leafId: undefined });
  expect(live).not.toBeNull();
  loadChat.mockClear();
  return live!;
}

function writeFor({ value }: { value: Chat }): ChatContentWrite {
  return createChatContentWrite({ id: value.id, content: value, binding: undefined, isCurrent: () => true });
}

beforeEach(() => {
  vi.resetAllMocks();
  promotions.clear();
  localReferences.reset();
});

it('reflects a captured local save in place without replacing streaming message nodes or overwriting newer selections', async () => {
  const registry = store();
  const value = branchedChat({ modelId: '~user/Repo/Model' });
  value.endpoint = { type: 'llama_cpp_browser' };
  value.systemPrompt = { behavior: 'append', content: 'Keep this prompt' };
  const live = await installSaved({ registry, value });
  const root = live.root;
  const firstNode = root.items[0];
  const currentLeafId = live.currentLeafId;
  const reference = { sourceModelId: '~user/Repo/Model', modelId: 'user/Repo-2/Model', isCurrent: () => true, isIdentityCurrent: () => true, retain: () => ({ release() {} }), withCurrentFiles: async ({ operation }: { operation(): Promise<void> }) => operation() };
  rememberSavedLocalModelReference({ reference });
  const promotion: LocalModelPromotion = { owner: { kind: 'chat', id: live.id }, changes: [{ slot: 'model', ...reference }], isCurrent: () => true };
  for (const listener of promotions) {
    listener({ promotion });
  }
  expect(live.modelId).toBe('user/Repo-2/Model');
  expect(live.root).toBe(root);
  expect(live.root.items[0]).toBe(firstNode);
  expect(live.currentLeafId).toBe(currentLeafId);
  expect(live.systemPrompt).toEqual({ behavior: 'append', content: 'Keep this prompt' });
  expect(updateContent).not.toHaveBeenCalled();
  live.modelId = 'hf.co/Other/New:Q4';
  for (const listener of promotions) {
    listener({ promotion });
  }
  expect(live.modelId).toBe('hf.co/Other/New:Q4');
});

describe('live chat model-binding content guards', () => {
  it('keeps both current and noncurrent stale registries unchanged when persisted promotion wins', async () => {
    const first = store();
    const second = store();
    const original = chat();
    await installSaved({ registry: first, value: original });
    const background = await installSaved({ registry: second, value: original });
    second.currentChatRef.value = null;
    await nextTick();
    second.registerLiveInstance({ chat: background });
    first.currentChatRef.value = first.getLiveChatById({ chatId: original.id });
    updateContent.mockRejectedValue(new ChatContentBindingChangedError());
    for (const registry of [first, second]) {
      const updater = vi.fn((): ChatContent => ({ root: { items: [] }, currentLeafId: toMessageId({ raw: 'stale-leaf' }) }));
      const write = writeFor({ value: original });
      await expect(registry.updateChatContent({ id: original.id, write, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
      expect(updateContent.mock.calls.at(-1)?.[0].write).toBe(write);
      expect(updater).not.toHaveBeenCalled();
      expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBeUndefined();
    }
  });

  it('retains the operation-start write even after live state advances', async () => {
    const registry = store();
    const original = chat();
    const write = writeFor({ value: original });
    const advanced = { ...original, modelId: 'user/saved', currentLeafId: toMessageId({ raw: 'newer-leaf' }) };
    await installSaved({ registry, value: advanced });
    updateContent.mockRejectedValueOnce(new ChatContentBindingChangedError());
    await expect(registry.updateChatContent({ id: original.id, write, updater: () => ({ root: { items: [] } }) })).rejects.toThrow();
    expect(updateContent.mock.calls[0]?.[0].write).toBe(write);
    expect(registry.getLiveChatById({ chatId: original.id })).toMatchObject(advanced);
  });

  it('synchronizes a clean old tree to promoted persisted content and metadata', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    loadChat.mockResolvedValueOnce({ ...original, modelId: 'user/saved', currentLeafId: toMessageId({ raw: 'saved-leaf' }) });
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('synchronized');
    expect(registry.getLiveChatById({ chatId: original.id })).toMatchObject({ modelId: 'user/saved', currentLeafId: 'saved-leaf' });
  });

  it('preserves accepted unsaved changes instead of replacing them during admission', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    registry.getLiveChatById({ chatId: original.id })!.currentLeafId = toMessageId({ raw: 'unsaved-leaf' });
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
    expect(loadChat).not.toHaveBeenCalled();
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBe('unsaved-leaf');
    registry.unregisterLiveInstance({ chatId: original.id });
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBe('unsaved-leaf');
  });

  it('does not discard an edit that arrives during the synchronization read', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    const pending = Promise.withResolvers<Chat>();
    loadChat.mockReturnValueOnce(pending.promise);
    const operation = registry.synchronizeModelBindingContent({ chatId: original.id });
    registry.getLiveChatById({ chatId: original.id })!.currentLeafId = toMessageId({ raw: 'arrived-during-read' });
    pending.resolve({ ...original, modelId: 'user/saved' });
    expect(await operation).toBe('changed');
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBe('arrived-during-read');
  });

  it('applies an external metadata hint without replacing unsaved content', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    registry.currentChatRef.value = registry.getLiveChatById({ chatId: original.id });
    registry.currentChatRef.value!.currentLeafId = toMessageId({ raw: 'unsaved' });
    loadChat.mockResolvedValueOnce({ ...original, currentLeafId: toMessageId({ raw: 'persisted' }), title: 'Remote title' });
    await subscribe.mock.calls.at(-1)![0].listener({ event: { type: 'chat_meta_and_chat_group', id: 'owner', timestamp: 1 } });
    expect(registry.currentChatRef.value).toMatchObject({ title: 'Remote title', currentLeafId: 'unsaved' });
  });

  it('keeps an unsaved tree when an external content hint arrives', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    registry.currentChatRef.value = registry.getLiveChatById({ chatId: original.id });
    registry.currentChatRef.value!.currentLeafId = toMessageId({ raw: 'unsaved' });
    await subscribe.mock.calls.at(-1)![0].listener({ event: { type: 'chat_content', id: 'owner', timestamp: 1 } });
    expect(loadChat).not.toHaveBeenCalled();
    expect(registry.currentChatRef.value?.currentLeafId).toBe('unsaved');
  });

  it.each([undefined, 'user/saved'])('persists message-link branch selection before the next admission for model %s', async modelId => {
    const registry = store();
    const original = branchedChat({ modelId });
    const extra: UserMessageNode = { id: toMessageId({ raw: 'persisted-only' }), role: 'user', createdAt: 2, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
    original.root.items.push(extra);
    await installSaved({ registry, value: original });
    let persisted: ChatContent = { root: structuredClone(original.root), currentLeafId: original.currentLeafId };
    updateContent.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatContent | null }): ChatContent | Promise<ChatContent> }) => {
      persisted = snapshotChatContent({ content: await updater({ current: persisted }) });
      return persisted;
    });
    loadChat.mockImplementation(async () => ({ ...original, ...persisted }));

    const opened = await registry.openChatAtMessage({ chatId: original.id, messageId: toMessageId({ raw: 'first-parent' }) });

    expect(updateContent).toHaveBeenCalledOnce();
    expect(persisted.currentLeafId).toBe('first-leaf');
    expect(persisted.root.items.map(node => node.id)).toContain(extra.id);
    expect(opened?.currentLeafId).toBe('first-leaf');
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('synchronized');
    expect(registry.currentChatRef.value?.root.items.map(node => node.id)).toContain(extra.id);
  });

  it('keeps the live branch unchanged when persisted promotion rejects a message-link selection', async () => {
    const registry = store();
    const original = branchedChat({ modelId: undefined });
    await installSaved({ registry, value: original });
    updateContent.mockRejectedValueOnce(new ChatContentBindingChangedError());

    await expect(registry.openChatAtMessage({ chatId: original.id, messageId: toMessageId({ raw: 'first-parent' }) })).rejects.toBeInstanceOf(ChatContentBindingChangedError);

    expect(registry.currentChatRef.value?.currentLeafId).toBe(original.currentLeafId);
    expect(registry.currentChatRef.value?.root).toEqual(original.root);
  });

  it.each(['message', 'leaf'] as const)('preserves an unsaved tree when %s navigation would switch branches', async navigation => {
    const registry = store();
    const original = branchedChat({ modelId: 'user/saved' });
    await installSaved({ registry, value: original });
    const live = registry.getLiveChatById({ chatId: original.id })!;
    const unsaved: UserMessageNode = { id: toMessageId({ raw: 'unsaved' }), role: 'user', createdAt: 3, modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: 'accepted unsaved edit', completeness: 'complete' }], replies: { items: [] } };
    live.root.items.push(unsaved);
    const dirtyRoot = structuredClone(original.root);
    dirtyRoot.items.push(structuredClone(unsaved));

    let operation: Promise<Chat | null>;
    switch (navigation) {
    case 'message': operation = registry.openChatAtMessage({ chatId: original.id, messageId: toMessageId({ raw: 'first-parent' }) });
      break;
    case 'leaf': operation = registry.openChat({ id: original.id, leafId: toMessageId({ raw: 'first-leaf' }) });
      break;
    default: {
      const exhaustive: never = navigation;
      throw new Error(String(exhaustive));
    }
    }
    await expect(operation).rejects.toBeInstanceOf(ChatContentBindingChangedError);

    expect(updateContent).not.toHaveBeenCalled();
    expect(live.currentLeafId).toBe(original.currentLeafId);
    expect(live.root).toEqual(dirtyRoot);
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
  });

  it('does not treat initial or repeated live registration as proof of persistence', async () => {
    const registry = store();
    const original = chat();
    const proposal = { ...original, currentLeafId: toMessageId({ raw: 'never-saved' }) };
    registry.registerLiveInstance({ chat: proposal });
    loadChat.mockResolvedValueOnce(original);
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
    registry.registerLiveInstance({ chat: original });
    registry.unregisterLiveInstance({ chatId: original.id });
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBe('never-saved');
  });

  it('establishes an unknown baseline only after confirming identical persisted content', async () => {
    const registry = store();
    const original = chat();
    registry.getLiveChat({ chat: original });
    loadChat.mockResolvedValueOnce(structuredClone(original));
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('synchronized');
    registry.unregisterLiveInstance({ chatId: original.id });
    expect(registry.getLiveChatById({ chatId: original.id })).toBeNull();
  });

  it('does not turn an existing dirty registry clean when registration repeats', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    live.currentLeafId = toMessageId({ raw: 'unsaved' });
    registry.registerLiveInstance({ chat: original });
    expect(registry.getLiveChat({ chat: original })).toBe(live);
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
    expect(loadChat).not.toHaveBeenCalled();
  });

  it('retains changes made during persistence and marks only the accepted snapshot saved', async () => {
    const registry = store();
    const original = branchedChat({ modelId: undefined });
    const live = await installSaved({ registry, value: original });
    const streamNode = live.root.items[0];
    const accepted = snapshotChatContent({ content: live });
    const pending = Promise.withResolvers<ChatContent>();
    updateContent.mockReturnValueOnce(pending.promise);
    const write = writeFor({ value: original });
    const operation = registry.updateChatContent({ id: live.id, write, updater: () => live });
    live.currentLeafId = toMessageId({ raw: 'still-streaming' });
    pending.resolve(accepted);
    expect(await operation).toEqual(accepted);
    expect(live.root.items[0]).toBe(streamNode);
    expect(live.currentLeafId).toBe('still-streaming');
    expect(await registry.synchronizeModelBindingContent({ chatId: live.id })).toBe('changed');
    expect(loadChat).not.toHaveBeenCalled();

    const complete = snapshotChatContent({ content: live });
    updateContent.mockResolvedValueOnce(complete);
    await registry.updateChatContent({ id: live.id, write, updater: () => live });
    loadChat.mockResolvedValueOnce({ ...original, ...complete });
    expect(await registry.synchronizeModelBindingContent({ chatId: live.id })).toBe('synchronized');
  });

  it('keeps stream node identity when the detached accepted snapshot matches live content', async () => {
    const registry = store();
    const original = branchedChat({ modelId: undefined });
    const live = await installSaved({ registry, value: original });
    const streamNode = live.root.items[0];
    updateContent.mockResolvedValueOnce(snapshotChatContent({ content: live }));
    await registry.updateChatContent({ id: live.id, write: writeFor({ value: original }), updater: () => live });
    expect(live.root.items[0]).toBe(streamNode);
  });

  it('does not advance the saved baseline when persistence rejects a live proposal', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    live.currentLeafId = toMessageId({ raw: 'failed-proposal' });
    updateContent.mockRejectedValueOnce(new ChatContentBindingChangedError());
    await expect(registry.updateChatContent({ id: live.id, write: writeFor({ value: original }), updater: () => live })).rejects.toThrow();
    expect(await registry.synchronizeModelBindingContent({ chatId: live.id })).toBe('changed');
    expect(loadChat).not.toHaveBeenCalled();
    expect(live.currentLeafId).toBe('failed-proposal');
  });

  it('does not replace a registry installed while synchronization was reading', async () => {
    const registry = store();
    const original = chat();
    const pending = Promise.withResolvers<Chat>();
    loadChat.mockReturnValueOnce(pending.promise);
    const operation = registry.synchronizeModelBindingContent({ chatId: original.id });
    const proposal = { ...original, currentLeafId: toMessageId({ raw: 'new-live-proposal' }) };
    registry.registerLiveInstance({ chat: proposal });
    pending.resolve(original);
    expect(await operation).toBe('changed');
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBe('new-live-proposal');
  });

  it('preserves metadata edited during a synchronization read', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    const pending = Promise.withResolvers<Chat>();
    loadChat.mockReturnValueOnce(pending.promise);
    const operation = registry.synchronizeModelBindingContent({ chatId: original.id });
    live.modelId = 'new-local-selection';
    pending.resolve(original);
    expect(await operation).toBe('changed');
    expect(live.modelId).toBe('new-local-selection');
  });

  it('updates metadata from the latest stored value without reading an old full chat', async () => {
    const registry = store();
    const original = { ...chat(), modelId: 'optimistic-selection' };
    const live = await installSaved({ registry, value: original });
    live.currentLeafId = toMessageId({ raw: 'unsaved-root' });
    let persisted: ChatMeta = { ...original, modelId: 'new-model', endpoint: { type: 'llama_cpp_browser' } };
    updateMeta.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      const updated = updater({ current: persisted });
      if (updated !== undefined) {
        persisted = updated;
      }
    });
    await registry.updateChatMeta({ id: live.id, updater: ({ current }) => ({ ...current!, title: 'Renamed', updatedAt: 2 }) });
    expect(persisted).toMatchObject({ title: 'Renamed', modelId: 'new-model', endpoint: { type: 'llama_cpp_browser' } });
    expect(live).toMatchObject({ title: 'Renamed', modelId: 'optimistic-selection', currentLeafId: 'unsaved-root' });
    expect(loadChat).not.toHaveBeenCalled();
  });

  it('does not recreate deleted metadata or apply a stale fallback to the live chat', async () => {
    const registry = store();
    const original = { ...chat(), modelId: 'selected-now' };
    const live = await installSaved({ registry, value: original });
    updateMeta.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      expect(updater({ current: null })).toBeUndefined();
    });
    const updater = vi.fn(() => ({ ...original, modelId: 'old-async-model', title: 'Old title' }));
    await registry.updateChatMeta({ id: live.id, updater });
    expect(updater).not.toHaveBeenCalled();
    expect(live).toMatchObject({ title: original.title, modelId: 'selected-now' });
  });

  it('allows explicit new-chat metadata creation and strips the content tree', async () => {
    const registry = store();
    const original = chat();
    registry.registerLiveInstance({ chat: original });
    updateMeta.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      const accepted = updater({ current: null });
      expect(accepted).toMatchObject({ id: original.id, title: original.title });
      expect(accepted).not.toHaveProperty('root');
    });
    await registry.updateChatMeta({ id: original.id, creation: 'new-chat', updater: () => original });
  });

  it('does not overwrite a later optimistic setting when a metadata write finishes', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    const pending = Promise.withResolvers<void>();
    updateMeta.mockImplementationOnce(async ({ updater }: { updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      updater({ current: { ...original, modelId: 'stored-selection' } });
      await pending.promise;
    });
    const operation = registry.updateChatMeta({ id: live.id, updater: ({ current }) => ({ ...current!, updatedAt: 3 }) });
    live.modelId = 'optimistic-selection';
    pending.resolve();
    await operation;
    expect(live.modelId).toBe('optimistic-selection');
  });

  it('does not replace a live proposal registered while a message-link save was pending', async () => {
    const registry = store();
    const original = branchedChat({ modelId: undefined });
    loadChat.mockResolvedValueOnce(structuredClone(original));
    const pending = Promise.withResolvers<ChatContent>();
    const entered = Promise.withResolvers<void>();
    updateContent.mockImplementationOnce(async () => {
      entered.resolve();
      return pending.promise;
    });
    const operation = registry.openChat({ id: original.id, leafId: toMessageId({ raw: 'first-leaf' }) });
    await entered.promise;
    const proposal = { ...original, currentLeafId: toMessageId({ raw: 'unsaved-proposal' }) };
    registry.registerLiveInstance({ chat: proposal });
    const accepted = { ...snapshotChatContent({ content: original }), currentLeafId: toMessageId({ raw: 'first-leaf' }) };
    loadChat.mockResolvedValueOnce({ ...original, ...accepted });
    pending.resolve(accepted);
    await expect(operation).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBe('unsaved-proposal');
    expect(registry.currentChatRef.value).toBeNull();
  });

  it('does not apply an old metadata read to a newly selected chat', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    const pending = Promise.withResolvers<Chat>();
    loadChat.mockReturnValueOnce(pending.promise);
    const hint = subscribe.mock.calls.at(-1)![0].listener({ event: { type: 'chat_meta_and_chat_group', id: 'owner', timestamp: 1 } });
    const selected = { ...chat(), id: toChatId({ raw: 'newly-selected' }), title: 'Newly selected' };
    registry.registerLiveInstance({ chat: selected });
    registry.currentChatRef.value = registry.getLiveChatById({ chatId: selected.id });
    pending.resolve({ ...original, title: 'Old read title' });
    await hint;
    expect(registry.currentChatRef.value).toMatchObject({ id: selected.id, title: selected.title });
  });

  it('does not overwrite existing metadata through the new-chat creation path', async () => {
    const registry = store();
    const original = chat();
    updateMeta.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => updater({ current: original }));
    const updater = vi.fn(() => ({ ...original, title: 'Collision' }));
    await expect(registry.updateChatMeta({ id: original.id, creation: 'new-chat', updater })).rejects.toThrow('Chat already exists');
    expect(updater).not.toHaveBeenCalled();
  });

  it('does not apply metadata when its persistence fails', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    updateMeta.mockImplementationOnce(async ({ updater }: { updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      updater({ current: original });
      throw new Error('metadata storage failed');
    });
    await expect(registry.updateChatMeta({ id: live.id, updater: ({ current }) => ({ ...current!, title: 'Not accepted' }) })).rejects.toThrow('metadata storage failed');
    expect(live.title).toBe(original.title);
  });

  it('passes the original content operation capability to its metadata update', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    const write = writeFor({ value: original });
    updateMeta.mockImplementationOnce(async ({ write: received, updater }: { write: ChatContentWrite, updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      expect(received).toBe(write);
      updater({ current: original });
    });
    await registry.updateChatMeta({ id: live.id, write, updater: ({ current }) => ({ ...current!, title: 'Accepted completion' }) });
    expect(live.title).toBe('Accepted completion');
  });

  it('does not apply an old metadata proposal after its operation capability is rejected', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    const write = writeFor({ value: original });
    updateMeta.mockImplementationOnce(async ({ write: received, updater }: { write: ChatContentWrite, updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      expect(received).toBe(write);
      updater({ current: original });
      throw new ChatContentBindingChangedError();
    });
    await expect(registry.updateChatMeta({ id: live.id, write, updater: ({ current }) => ({ ...current!, title: 'Stale completion' }) })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(live.title).toBe(original.title);
  });

  it('keeps the deleted metadata no-op when a current content capability is supplied', async () => {
    const registry = store();
    const original = chat();
    const live = await installSaved({ registry, value: original });
    const write = writeFor({ value: original });
    updateMeta.mockImplementationOnce(async ({ write: received, updater }: { write: ChatContentWrite, updater({ current }: { current: ChatMeta | null }): ChatMeta | undefined }) => {
      expect(received).toBe(write);
      expect(updater({ current: null })).toBeUndefined();
    });
    const updater = vi.fn(() => ({ ...original, title: 'Deleted completion' }));
    await registry.updateChatMeta({ id: live.id, write, updater });
    expect(updater).not.toHaveBeenCalled();
    expect(live.title).toBe(original.title);
  });

  it.each(['register', 'get-live'] as const)('does not inherit a cleared registry baseline through %s', async registration => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    registry.currentChatRef.value = null;
    registry.liveChatRegistry.clear();
    const changed = { ...original, currentLeafId: toMessageId({ raw: 'new-storage-version' }) };
    switch (registration) {
    case 'register': registry.registerLiveInstance({ chat: original });
      break;
    case 'get-live': registry.getLiveChat({ chat: original });
      break;
    default: {
      const exhaustive: never = registration;
      throw new Error(String(exhaustive));
    }
    }
    loadChat.mockResolvedValueOnce(changed);
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
    expect(registry.getLiveChatById({ chatId: original.id })).toMatchObject({ id: original.id, root: original.root });
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBeUndefined();
  });

  it('resets current refs and saved baselines with the shared live registry for tests', async () => {
    const registry = store();
    const original = chat();
    await installSaved({ registry, value: original });
    registry.TEST_ONLY.resetLiveState();
    expect(registry.currentChatRef.value).toBeNull();
    expect(registry.currentChatGroupRef.value).toBeNull();
    expect(registry.liveChatRegistry.size).toBe(0);
    registry.registerLiveInstance({ chat: original });
    loadChat.mockResolvedValueOnce({ ...original, currentLeafId: toMessageId({ raw: 'next-fixture' }) });
    expect(await registry.synchronizeModelBindingContent({ chatId: original.id })).toBe('changed');
    expect(registry.getLiveChatById({ chatId: original.id })?.currentLeafId).toBeUndefined();
  });
});
