import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef, type Ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { toChatGroupId, toChatId, toMessageId, type ChatId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type Chat, type ChatContent, type ChatGroup, type Settings } from '@/01-models/types';
import type { ScopedSettingChange } from '@/01-models/scoped-setting-change';
import { applyScopedSettingChangesToChat } from '@/logic/scoped-setting-changes';
import type { SavedTemporaryModel, TemporaryModelSource } from '@/features/llama-cpp-browser/model-files';
import { offerTemporaryModelSave, useTemporaryModelSave } from './useTemporaryModelSave';

const mocks = vi.hoisted(() => ({
  live: undefined as Chat | undefined,
  content: undefined as ChatContent | undefined,
  chatGroup: undefined as ChatGroup | undefined,
  settings: undefined as Ref<Settings> | undefined,
  copy: vi.fn(),
  validate: vi.fn(),
  wait: vi.fn(),
  synchronize: vi.fn(),
  loadData: vi.fn(),
  promoteGlobal: vi.fn(),
  update: vi.fn(),
  updateContent: vi.fn(),
  updateChatGroup: vi.fn(),
  register: vi.fn(),
  suspend: vi.fn(),
  gate: undefined as Promise<void> | undefined,
  inFence: false,
  storageCurrent: true,
}));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    loadChatMeta: async () => mocks.live ?? null,
    loadChatContent: async () => mocks.content ?? null,
    createChatContentWrite: vi.fn(),
    updateChatContent: mocks.updateContent,
    updateChatGroup: mocks.updateChatGroup,
  },
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: mocks.settings, promoteTemporaryModelDefault: mocks.promoteGlobal }) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getLiveChatById: () => mocks.live ?? null,
  rootItems: { value: [] },
  updateChatScopedSettings: mocks.update,
  loadData: mocks.loadData,
  synchronizeModelBindingContent: mocks.synchronize,
}));
vi.mock('./local-model-launch-session', () => ({ localModelLaunchSession: () => undefined, registerLocalModelLaunchSession: mocks.register }));
vi.mock('./useLocalModelLaunchChat', () => ({ suspendLocalModelLaunchPreparation: mocks.suspend }));
vi.mock('@/composables/chat/chat-scoped/chat-model-binding-operations', () => ({
  withChatModelBindingFinalization: async ({ operation }: { chatId: ChatId, operation(): Promise<unknown> }) => {
    await mocks.gate;
    mocks.inFence = true;
    try {
      return await operation();
    } finally {
      mocks.inFence = false;
    }
  },
}));
vi.mock('../model-files', () => ({ captureModelFileStorage: () => () => mocks.storageCurrent, copyTemporaryModel: mocks.copy, withSavedTemporaryModelFiles: mocks.validate, waitForModelFileMutation: mocks.wait, llamaCppBrowserModelFiles: { subscribeModelList: () => () => {} } }));
let sequence = 0;

function fixture({ home }: { home: boolean }) {
  const chatId = toChatId({ raw: `owner-${++sequence}` });
  const chatGroupId = home ? toChatGroupId({ raw: `home-${sequence}` }) : undefined;
  mocks.live = { id: chatId, title: 'Keep title', root: { items: [] }, groupId: chatGroupId, createdAt: 1, updatedAt: 1, debugEnabled: true, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model', titleGeneration: 'disabled', systemPrompt: { content: 'Keep prompt', behavior: 'append' } };
  mocks.content = { root: { items: [{ id: toMessageId({ raw: 'assistant' }), role: 'assistant', modelId: 'temp/model', lmParameters: undefined, createdAt: 1, parts: [{ type: 'text', text: 'Original answer', completeness: 'complete' }], interruption: undefined, replies: { items: [] } }] } };
  mocks.chatGroup = chatGroupId === undefined ? undefined : { id: chatGroupId, name: 'Home model', isCollapsed: false, items: [], updatedAt: 1, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/model' };
  const sourceCurrent = { value: true };
  const savedCurrent = { value: true };
  const source: TemporaryModelSource = { model: { modelId: 'temp/model', size: 32, importedAt: 1 }, rootPath: 'temp/model', registrationRevision: sequence, isCurrent: () => sourceCurrent.value };
  const saved: SavedTemporaryModel = { model: { modelId: 'user/model-2', size: 32, importedAt: 1 }, receipt: { storage: 'opfs', models: [], publication: { generation: sequence, isCurrent: () => savedCurrent.value } } };
  mocks.copy.mockResolvedValue(saved);
  offerTemporaryModelSave({ chatId, source, chatGroupId });
  return { ...useTemporaryModelSave({ chatId: shallowRef(chatId) }), chatId, chatGroupId, source, saved, sourceCurrent, savedCurrent };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.storageCurrent = true;
  mocks.gate = undefined;
  mocks.inFence = false;
  mocks.settings = shallowRef<Settings>({ ...structuredClone(DEFAULT_SETTINGS), endpoint: { type: 'llama_cpp_browser' }, storageType: 'memory' });
  mocks.update.mockImplementation(async ({ changes, isCurrent }: { changes: ScopedSettingChange[], isCurrent(): boolean }) => {
    expect(mocks.inFence).toBe(true);
    if (mocks.live && isCurrent()) {
      Object.assign(mocks.live, applyScopedSettingChangesToChat({ current: mocks.live, changes, updatedAt: 2 }));
    }
  });
  mocks.updateContent.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatContent | null }): ChatContent }) => {
    mocks.content = updater({ current: mocks.content ?? null });
  });
  mocks.updateChatGroup.mockImplementation(async ({ updater }: { updater({ current }: { current: ChatGroup | null }): ChatGroup | undefined }) => {
    const result = updater({ current: mocks.chatGroup ?? null });
    if (result) {
      mocks.chatGroup = result;
    }
  });
  mocks.validate.mockImplementation(async ({ operation }: { operation(): Promise<void> }) => {
    await operation();
    return { status: 'completed' };
  });
  mocks.wait.mockImplementation(async () => {
    expect(mocks.inFence).toBe(false);
  });
});

describe('temporary model saving', () => {
  it('copies before finalization and patches only the endpoint and model against latest settings', async () => {
    const view = fixture({ home: false });
    const pending = view.save();
    mocks.live!.endpoint = { type: 'openai', url: 'https://new.invalid' };
mocks.live!.modelId = 'user/new-selection';
await pending;
expect(mocks.live).toMatchObject({ modelId: 'user/model-2', endpoint: { type: 'llama_cpp_browser' }, title: 'Keep title', debugEnabled: true, titleGeneration: 'disabled', systemPrompt: { content: 'Keep prompt' } });
expect(mocks.update.mock.calls[0]![0].changes.map((change: ScopedSettingChange) => change.field)).toEqual(['endpoint', 'model_id']);
expect(view.notice.value?.phase).toBe('saved');
expect(mocks.updateChatGroup).not.toHaveBeenCalled();
  });

  it('shares copying and progress between panes', async () => {
    const view = fixture({ home: false });
    const copied = Promise.withResolvers<SavedTemporaryModel>();
    mocks.copy.mockImplementationOnce(({ onProgress }) => {
      expect(mocks.inFence).toBe(false);
      onProgress({ progress: { phase: 'importing', completed: 16, total: 32 } });
      return copied.promise;
    });
    const other = useTemporaryModelSave({ chatId: shallowRef(view.chatId) });
    const saving = view.save();
    expect(other.save()).toBe(saving);
    await flushPromises();
    expect(other.notice.value?.progress?.completed).toBe(16);
    copied.resolve(view.saved);
    await saving;
    expect(mocks.copy).toHaveBeenCalledOnce();
  });

  it('keeps independent global promotion after the chat override was cleared', async () => {
    const view = fixture({ home: false });
mocks.live!.endpoint = undefined;
mocks.live!.modelId = undefined;
await view.save();
expect(mocks.live!.modelId).toBe(view.saved.model.modelId);
expect(mocks.promoteGlobal).toHaveBeenCalledWith(expect.objectContaining({ sourceModelId: 'temp/model', modelId: 'user/model-2' }));
  });

  it('retains a dismissed offer for the same registration but renews a new source revision', () => {
    const view = fixture({ home: false });
    view.dismiss();
    offerTemporaryModelSave({ chatId: view.chatId, source: view.source, chatGroupId: undefined });
    expect(view.notice.value).toBeUndefined();
    offerTemporaryModelSave({ chatId: view.chatId, source: { ...view.source, registrationRevision: sequence + 1000 }, chatGroupId: undefined });
    expect(view.notice.value?.phase).toBe('offered');
  });

  it('does not replace an in-flight source with another offered source', async () => {
    const view = fixture({ home: false });
    const copied = Promise.withResolvers<SavedTemporaryModel>();
    mocks.copy.mockReturnValueOnce(copied.promise);
    const saving = view.save();
    await flushPromises();
    offerTemporaryModelSave({ chatId: view.chatId, source: { ...view.source, registrationRevision: sequence + 1000 }, chatGroupId: undefined });
    copied.resolve(view.saved);
    await saving;
    expect(view.notice.value?.phase).toBe('saved');
    expect(mocks.copy).toHaveBeenCalledOnce();
  });

  it('copies while the chat lane is busy and waits only for finalization', async () => {
    const view = fixture({ home: false });
    const finished = Promise.withResolvers<void>();
    mocks.gate = finished.promise;
    const saving = view.save();
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    expect(mocks.update).not.toHaveBeenCalled();
    finished.resolve();
    await saving;
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('permits cancellation while waiting for generation without changing settings', async () => {
    const view = fixture({ home: false });
    const finished = Promise.withResolvers<void>();
    mocks.gate = finished.promise;
    const saving = view.save();
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    const cancelling = view.cancel();
    finished.resolve();
    await Promise.all([saving, cancelling]);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(view.notice.value?.phase).toBe('offered');
  });

  it('rejects a switched provider while allowing the original temp source to expire after a valid copy', async () => {
    const view = fixture({ home: false });
    const copied = Promise.withResolvers<SavedTemporaryModel>();
    mocks.copy.mockReturnValueOnce(copied.promise);
    const saving = view.save();
    await flushPromises();
    mocks.storageCurrent = false;
    copied.resolve(view.saved);
    await saving;
    expect(mocks.update).not.toHaveBeenCalled();
    expect(view.notice.value).toBeUndefined();
  });

  it('uses the saved receipt rather than requiring temporary file handles after copying', async () => {
    const view = fixture({ home: false });
    mocks.copy.mockImplementationOnce(async () => {
      view.sourceCurrent.value = false;
      return view.saved;
    });
    await view.save();
    expect(view.notice.value?.phase).toBe('saved');
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('keeps a hidden save running and exposes a way to show its cancellation again', async () => {
    const view = fixture({ home: false });
    const copied = Promise.withResolvers<SavedTemporaryModel>();
    mocks.copy.mockReturnValueOnce(copied.promise);
    const saving = view.save();
    await flushPromises();
    view.dismiss();
    expect(view.notice.value).toBeUndefined();
    expect(view.hiddenNotice.value?.phase).toBe('saving');
    view.show();
    expect(view.notice.value?.phase).toBe('saving');
    copied.resolve(view.saved);
    await saving;
    expect(view.hiddenNotice.value).toBeUndefined();
  });

  it('retries metadata failure with its actual saved ID and no second copy', async () => {
    const view = fixture({ home: false });
    mocks.update.mockRejectedValueOnce(new Error('write failed'));
    await view.save();
    expect(view.notice.value?.phase).toBe('failed');
    await view.retry();
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(view.notice.value?.phase).toBe('saved');
    expect(mocks.live!.modelId).toBe('user/model-2');
  });

  it('replaces exact full temporary model IDs in all saved assistant branches', async () => {
    const view = fixture({ home: false });
    const original = mocks.content!.root.items[0]!;
    if (original.role !== 'assistant') {
      throw new Error('Expected assistant');
    }
    mocks.content!.root.items.push({ ...original, id: toMessageId({ raw: 'another-selector' }), modelId: 'temp/model:Q8' });
    await view.save();
    expect(mocks.content!.root.items.map(node => node.modelId)).toEqual(['user/model-2', 'temp/model:Q8']);
    expect(mocks.content!.root.items[0]!.parts).toEqual(original.parts);
    expect(mocks.synchronize).toHaveBeenCalledOnce();
  });

  it('retries an independent global failure without copying again or losing chat history', async () => {
    const view = fixture({ home: false });
    mocks.promoteGlobal.mockRejectedValueOnce(new Error('global unavailable'));
    await view.save();
    expect(view.notice.value?.phase).toBe('failed');
    expect(mocks.content!.root.items[0]!.modelId).toBe('user/model-2');
    await view.retry();
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(view.notice.value?.phase).toBe('saved');
  });

  it('does not recreate a deleted target but still promotes a matching global default', async () => {
    const view = fixture({ home: false });
    mocks.live = undefined;
    await view.save();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
  });

  it('waits for file mutations outside the chat finalization lane', async () => {
    const view = fixture({ home: false });
    mocks.validate.mockResolvedValueOnce({ status: 'busy' });
    await view.save();
    expect(mocks.wait).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('preserves unrelated live properties when saving explicitly replaces a newer model choice', async () => {
    const view = fixture({ home: false });
mocks.live!.title = 'Newest title';
mocks.live!.systemPrompt = { content: 'New prompt', behavior: 'override' };
mocks.live!.modelId = 'other';
await view.save();
expect(mocks.live).toMatchObject({ title: 'Newest title', systemPrompt: { content: 'New prompt' }, modelId: 'user/model-2' });
  });

  it('rejects a changed saved receipt and never applies its model', async () => {
    const view = fixture({ home: false });
    mocks.validate.mockResolvedValueOnce({ status: 'changed' });
    await view.save();
    expect(view.notice.value?.phase).toBe('failed');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('hides completed saves whose stored receipt has been invalidated', async () => {
    const view = fixture({ home: false });
    await view.save();
    view.savedCurrent.value = false;
    view.show();
    expect(view.notice.value).toBeUndefined();
  });

  it('cancels even when Cancel is clicked immediately before copying starts', async () => {
    const view = fixture({ home: false });
    const saving = view.save();
    const cancelled = view.cancel();
    await Promise.all([saving, cancelled]);
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(view.notice.value?.phase).toBe('offered');
  });

  it.each(['matching', 'different-model', 'different-endpoint', 'deleted'] as const)('only updates the explicitly created home chat group when its original pair still matches: %s', async match => {
    const view = fixture({ home: true });
    switch (match) {
    case 'matching': break;
    case 'different-model': mocks.chatGroup!.modelId = 'temp/model:Q8';
      break;
    case 'different-endpoint': mocks.chatGroup!.endpoint = { type: 'openai', url: 'https://other.invalid' };
      break;
    case 'deleted': mocks.chatGroup = undefined;
      break;
    default: {
      const exhaustive: never = match;
      throw new Error(String(exhaustive));
    }
    }
    await view.save();
    expect(mocks.updateChatGroup).toHaveBeenCalledOnce();
    if (match === 'matching') {
      expect(mocks.chatGroup!.modelId).toBe('user/model-2');
    } else {
      expect(mocks.chatGroup?.modelId).not.toBe('user/model-2');
    }
  });
});

it('allows explicitly selecting the original temporary model again after a completed save', async () => {
  const view = fixture({ home: false });
  await view.save();
  mocks.live!.modelId = view.source.model.modelId;
  offerTemporaryModelSave({ chatId: view.chatId, source: view.source, chatGroupId: undefined });
  expect(view.notice.value?.phase).toBe('offered');
  await view.save();
  expect(mocks.copy).toHaveBeenCalledOnce();
  expect(mocks.live!.modelId).toBe(view.saved.model.modelId);
  expect(view.notice.value?.phase).toBe('saved');
});
