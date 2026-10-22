import { createChatContentWrite, readChatContentWrite, chatContentFingerprint, type ChatContentModelBinding } from '@/00-storage/service/chat-content-binding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, shallowRef, type Ref } from 'vue';
import type { StorageService } from '@/00-storage/service';
import { idToRaw, toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';
import type { Chat, ChatContent, Settings, SidebarItem } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';

type ChangeListener = Parameters<StorageService['subscribeToChanges']>[0]['listener'];
const state = vi.hoisted(() => ({
  current: undefined as Chat | undefined,
  settings: undefined as Settings | undefined,
  items: [] as SidebarItem[],
  listeners: new Set<ChangeListener>(),
  live: undefined as Ref<Chat | undefined> | undefined,
  persistedContent: undefined as ChatContent | undefined,
  persistedModelId: 'temp/model',
  captureWrite: vi.fn(),
  processing: false,
  synchronizeContent: vi.fn(),
  synchronizeSettings: vi.fn(),
  loadData: vi.fn(),
}));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getLiveChatById: ({ chatId }: { chatId: Chat['id'] }) => state.live?.value?.id === chatId ? state.live.value : null,
  synchronizeModelBindingContent: state.synchronizeContent,
  isProcessing: () => state.processing,
  loadData: state.loadData,
  rootItems: {
    get value() {
      return state.items;
    },
  },
}));
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    synchronizeModelBindingSettings: state.synchronizeSettings,
    settings: {
      get value() {
        return state.settings;
      },
    },
  }),
}));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    captureSettingsStorage: () => () => true,
    createChatContentWrite: state.captureWrite,
    subscribeToChanges: ({ listener }: { listener: ChangeListener }) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  },
}));

import { acquireChatModelBindingOperation, captureChatContentWrite, beginChatModelBindingGeneration, captureChatModelBindingHistoryProof, getKnownChatModelBindingMessages, registerChatModelBindingOrigin, synchronizeChatModelBindingAdmission, TEST_ONLY, withChatModelBindingFinalization } from './chat-model-binding-operations';

const chatId = toChatId({ raw: 'owner-chat' });
const messageId = toMessageId({ raw: 'answer' });

beforeEach(() => {
  vi.clearAllMocks();
  state.current = reactive<Chat>({ id: chatId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
  state.live = shallowRef(state.current);
  state.persistedContent = { root: { items: [] } };
  state.persistedModelId = 'temp/model';
  state.captureWrite.mockImplementation(({ id, content, binding }: { id: Chat['id'], content: ChatContent | undefined, binding: ChatContentModelBinding | undefined }) => createChatContentWrite({ id, content, binding, isCurrent: () => true }));
  state.processing = false;
  state.synchronizeContent.mockImplementation(async () => {
    state.current!.root = state.persistedContent!.root;
    state.current!.currentLeafId = state.persistedContent!.currentLeafId;
    state.current!.modelId = state.persistedModelId;
    return 'synchronized';
  });
  state.synchronizeSettings.mockResolvedValue('synchronized');
  state.settings = reactive<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'memory' });
  state.items = [];
});

afterEach(() => {
  TEST_ONLY.reset();
  expect(state.listeners.size).toBe(0);
});

function appendAssistant(): void {
  state.current!.root.items.push({ id: messageId, role: 'assistant', modelId: 'temp/model', lmParameters: undefined, interruption: undefined, parts: [{ type: 'text', text: 'accepted answer', completeness: 'complete' }], createdAt: 1, replies: { items: [] } });
}

describe('chat model binding finalization', () => {
  it('waits for the retained background operation and prevents the next admission from overtaking it', async () => {
    const first = await acquireChatModelBindingOperation({ chatId });
    const background = first.retain();
    first.release();
    const commit = Promise.withResolvers<void>();
    using cleanup = {
      [Symbol.dispose]() {
        first.release();
        background.release();
        commit.resolve();
      },
    };
    void cleanup;
    const entered = vi.fn();
    const finalization = withChatModelBindingFinalization({
      chatId,
      operation: async () => {
        entered();
        await commit.promise;
      },
    });
    const admitted = vi.fn();
    const next = Promise.resolve(acquireChatModelBindingOperation({ chatId })).then(operation => {
      admitted();
      operation.release();
    });
    await Promise.resolve();
    expect(entered).not.toHaveBeenCalled();
    expect(admitted).not.toHaveBeenCalled();
    background.release();
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    expect(admitted).not.toHaveBeenCalled();
    commit.resolve();
    await finalization;
    await next;
    expect(admitted).toHaveBeenCalledOnce();
  });

  it('releases a failed finalization and leaves another chat independent', async () => {
    const failure = withChatModelBindingFinalization({
      chatId,
      operation: async () => {
        throw new Error('write failed');
      },
    });
    const other = await acquireChatModelBindingOperation({ chatId: toChatId({ raw: 'other-chat' }) });
    other.release();
    await expect(failure).rejects.toThrow('write failed');
    const next = await acquireChatModelBindingOperation({ chatId });
    next.release();
    next.release();
    await expect(withChatModelBindingFinalization({ chatId, operation: async () => 'saved' })).resolves.toBe('saved');
  });
});

describe('temporary model history ownership', () => {
  it('records only assistants from successfully persisted generations of the empty owner', () => {
    expect(registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => true })).toBe(true);
    const generation = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    appendAssistant();
    generation.recordAssistant({ messageId });
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([]);
    generation.finish({ persisted: true });
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([messageId]);
    const failed = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    failed.recordAssistant({ messageId: toMessageId({ raw: 'unpersisted' }) });
    failed.finish({ persisted: false });
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([messageId]);
  });

  it('does not restore provenance after a model changes away and back', () => {
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => true });
    const generation = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    appendAssistant();
    generation.recordAssistant({ messageId });
    state.current!.modelId = 'temp/other';
    state.current!.modelId = 'temp/model';
    generation.finish({ persisted: true });
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([]);
  });

  it('rejects a source replacement and foreign content without changing the history', async () => {
    let sourceCurrent = true;
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => sourceCurrent });
    const generation = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    appendAssistant();
    generation.recordAssistant({ messageId });
    sourceCurrent = false;
    generation.finish({ persisted: true });
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([]);
    state.current!.root.items = [];
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => true });
    for (const listener of state.listeners) {
      await listener({ event: { type: 'chat_content', id: 'owner-chat', timestamp: 1 } });
    }
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([]);
    expect(state.current!.root.items).toEqual([]);
  });

  it('keeps known answers while their view is retired and checks the restored binding', () => {
    let sourceCurrent = true;
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => sourceCurrent });
    const generation = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    appendAssistant();
    generation.recordAssistant({ messageId });
    generation.finish({ persisted: true });
    state.live!.value = undefined;
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([messageId]);
    state.current = reactive({ ...state.current!, root: { items: [...state.current!.root.items] } });
    state.live!.value = state.current;
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([messageId]);
    state.live!.value = undefined;
    sourceCurrent = false;
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([]);
  });

  it('retains a finite proof across its own promotion and retires it on foreign content', async () => {
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => true });
    const generation = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    appendAssistant();
    generation.recordAssistant({ messageId });
    generation.finish({ persisted: true });
    const proof = captureChatModelBindingHistoryProof({ chatId, modelId: 'temp/model' });
    using cleanup = {
      [Symbol.dispose]() {
        proof.release();
      },
    };
    void cleanup;
    const fingerprint = proof.fingerprints.get(messageId);
    proof.allowPromotion({ modelId: 'user/saved' });
    state.current!.modelId = 'user/saved';
    expect(getKnownChatModelBindingMessages({ chatId, modelId: 'temp/model' })).toEqual([]);
    expect(proof.isCurrent()).toBe(true);
    expect(proof.messageIds).toEqual([messageId]);
    state.current!.root.items[0]!.createdAt = 99;
    expect(proof.fingerprints.get(messageId)).toBe(fingerprint);
    for (const listener of [...state.listeners]) {
      await listener({ event: { type: 'chat_content', id: 'owner-chat', timestamp: 2 } });
    }
    expect(proof.isCurrent()).toBe(false);
  });

  it('permanently retires a cached proof after a different model is selected and restored', () => {
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => true });
    const generation = beginChatModelBindingGeneration({ chatId, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' });
    appendAssistant();
    generation.recordAssistant({ messageId });
    generation.finish({ persisted: true });
    const proof = captureChatModelBindingHistoryProof({ chatId, modelId: 'temp/model' });
    using cleanup = {
      [Symbol.dispose]() {
        proof.release();
      },
    };
    void cleanup;
    proof.allowPromotion({ modelId: 'user/saved' });
    state.current!.modelId = 'temp/other';
    state.current!.modelId = 'temp/model';
    expect(proof.isCurrent()).toBe(false);
  });
});

describe('model binding admission synchronization', () => {
  it.each(['chat', 'chat_group', 'global'] as const)('captures the effective model and its %s scope before later settings change', scope => {
    const chat = state.current!;
    const chatGroupId = toChatGroupId({ raw: 'model-owner' });
    chat.endpoint = scope === 'chat' ? { type: 'llama_cpp_browser' } : undefined;
    chat.modelId = scope === 'chat' ? 'temp/chat' : undefined;
    chat.groupId = chatGroupId;
    state.settings!.defaultModelId = 'temp/global';
    state.items = [{
      id: 'model-owner',
      type: 'chat_group',
      chatGroup: {
        id: chatGroupId,
        name: 'Model owner',
        items: [],
        isCollapsed: false,
        updatedAt: 1,
        endpoint: scope === 'chat_group' ? { type: 'llama_cpp_browser' } : undefined,
        modelId: scope === 'chat_group' ? 'temp/chat-group' : undefined,
      },
    }];
    const write = captureChatContentWrite({ chat, dependency: 'model' });
    state.settings!.defaultModelId = 'user/another-global';
    const selected = scope === 'chat_group' ? 'temp/chat-group' : `temp/${scope}`;
    expect(readChatContentWrite({ write, id: chatId }).binding).toEqual({
      groupId: idToRaw({ id: chatGroupId }),
      endpoint: { type: 'llama_cpp_browser' },
      modelId: selected,
      endpointSource: scope,
      modelSource: scope,
    });
  });

  it('captures an empty tree and its temporary model without adopting the later saved binding', () => {
    const chat = state.current!;
    const write = captureChatContentWrite({ chat, dependency: 'model' });
    chat.modelId = 'user/saved';
    expect(readChatContentWrite({ write, id: chatId })).toMatchObject({
      baseline: chatContentFingerprint({ content: { root: { items: [] } } }),
      binding: { modelId: 'temp/model', endpoint: { type: 'llama_cpp_browser' }, endpointSource: 'chat', modelSource: 'chat' },
    });
  });

  it('captures a content-only write without making its outcome depend on model settings', () => {
    const write = captureChatContentWrite({ chat: state.current!, dependency: 'content' });
    state.current!.modelId = 'user/saved';
    expect(readChatContentWrite({ write, id: chatId }).binding).toBeUndefined();
  });

  it('does not replace the live nodes owned by a streaming generation', async () => {
    registerChatModelBindingOrigin({ chatId, modelId: 'temp/model', isCurrent: () => true });
    appendAssistant();
    const node = state.current!.root.items[0];
    state.processing = true;
    await expect(synchronizeChatModelBindingAdmission({ chatId })).resolves.toBe('changed');
    expect(state.current!.root.items[0]).toBe(node);
    expect(state.synchronizeContent).not.toHaveBeenCalled();
    expect(state.loadData).not.toHaveBeenCalled();
  });

  it('refreshes a foreign promotion before the caller selects a model', async () => {
    state.persistedModelId = 'user/saved';
    expect(state.current!.modelId).toBe('temp/model');
    await expect(synchronizeChatModelBindingAdmission({ chatId })).resolves.toBe('synchronized');
    expect(state.synchronizeContent).toHaveBeenCalledExactlyOnceWith({ chatId });
    expect(state.current!.modelId).toBe('user/saved');
    expect(state.loadData).toHaveBeenCalledOnce();
    expect(state.synchronizeSettings).toHaveBeenCalledOnce();
  });

  it('keeps dirty live content when synchronization refuses the admission', async () => {
    state.persistedModelId = 'user/saved';
    appendAssistant();
    state.synchronizeContent.mockResolvedValueOnce('changed');
    await expect(synchronizeChatModelBindingAdmission({ chatId })).resolves.toBe('changed');
    expect(state.current!.root.items).toHaveLength(1);
    expect(state.synchronizeSettings).not.toHaveBeenCalled();
  });
});
