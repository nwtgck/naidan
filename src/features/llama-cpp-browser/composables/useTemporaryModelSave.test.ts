import { createChatContentWrite, readChatContentWrite, chatContentFingerprint, type ChatContentModelBinding } from '@/00-storage/service/chat-content-binding';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { AssistantMessageNode, MessageBranch } from '@/01-models/types';
import type { ModelBindingSnapshot } from '@/00-storage/service/model-binding';
import type { ModelLaunchDefaultSnapshot } from '@/features/llama-cpp-browser/model-launch/defaults';
import type { SavedTemporaryModel, TemporaryModelSource } from '@/features/llama-cpp-browser/model-files';
import type { Progress } from '@/features/llama-cpp-browser/types';
import { offerTemporaryModelSave, useTemporaryModelSave } from './useTemporaryModelSave';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  captureWrite: vi.fn(),
  captureGlobal: vi.fn(),
  promote: vi.fn(),
  promoteGlobal: vi.fn(),
  copy: vi.fn(),
  validate: vi.fn(),
  wait: vi.fn(),
  synchronize: vi.fn(),
  loadData: vi.fn(),
  live: vi.fn(),
  captureHistory: vi.fn(),
  inFence: false,
  beginLaunchPromotion: vi.fn(),
  finishLaunchPromotion: vi.fn(),
  modelListListener: undefined as (() => void) | undefined,
  storageCurrent: true,
}));
vi.mock('@/00-storage/service', () => ({ storageService: { captureModelBinding: mocks.capture, promoteModelBinding: mocks.promote, createChatContentWrite: mocks.captureWrite } }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: { value: {} }, captureGlobalModelBinding: mocks.captureGlobal, promoteGlobalModelBinding: mocks.promoteGlobal }) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ getLiveChatById: mocks.live, loadData: mocks.loadData, synchronizeModelBindingContent: mocks.synchronize }));
vi.mock('./local-model-launch-session', () => ({ beginLocalModelLaunchPromotion: mocks.beginLaunchPromotion }));
vi.mock('@/composables/chat/chat-scoped/chat-model-binding-operations', () => ({
  captureChatModelBindingHistoryProof: mocks.captureHistory,
  withChatModelBindingFinalization: async ({ operation }: { operation: () => Promise<unknown> }) => {
    mocks.inFence = true;
    try {
      return await operation();
    } finally {
      mocks.inFence = false;
    }
  },
}));
vi.mock('../model-files', () => ({
  captureModelFileStorage: () => () => mocks.storageCurrent,
  copyTemporaryModel: mocks.copy,
  withSavedTemporaryModelFiles: mocks.validate,
  waitForModelFileMutation: mocks.wait,
  llamaCppBrowserModelFiles: {
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      mocks.modelListListener = listener;
      return () => {};
    },
  },
}));

let sequence = 0;

function fixture() {
  const chatId = toChatId({ raw: `save-owner-${++sequence}` });
  const assistant: AssistantMessageNode = {
    id: toMessageId({ raw: 'known-assistant' }),
    createdAt: 1,
    role: 'assistant',
    modelId: 'temp/model',
    lmParameters: undefined,
    parts: [{ type: 'text', text: 'Original response', completeness: 'complete' }],
    interruption: undefined,
    replies: { items: [] },
  };
  const live = { root: { items: [assistant] } satisfies MessageBranch };
  mocks.live.mockReturnValue(live);
  const proofCurrent = { value: true };
  const historyProof = {
    messageIds: [assistant.id],
    fingerprints: new Map([[assistant.id, 'original-assistant-fingerprint']]),
    isCurrent: () => proofCurrent.value,
    allowPromotion: vi.fn(),
    release: vi.fn(),
  };
  mocks.captureHistory.mockReturnValue(historyProof);
  const sourceCurrent = { value: true };
  const source: TemporaryModelSource = { model: { modelId: 'temp/model', size: 32, importedAt: 1 }, rootPath: 'temp/model', registrationRevision: sequence, isCurrent: () => sourceCurrent.value };
  const savedCurrent = { value: true };
  const saved: SavedTemporaryModel = { model: { modelId: 'user/model-2', size: 32, importedAt: 1 }, receipt: { storage: 'opfs', models: [], publication: { generation: sequence, isCurrent: () => savedCurrent.value } } };
  const chat: ModelBindingSnapshot = {
    chatId,
    sourceModelId: source.model.modelId,
    chat: { groupId: undefined, endpoint: undefined, modelId: undefined },
    chatGroup: undefined,
    global: { endpoint: { type: 'llama_cpp_browser' }, modelId: source.model.modelId },
    chatRevision: 0,
    chatGroupRevision: 0,
    chatGroupTarget: 'not-targeted',
    isCurrent: () => true,
  };
  const global: ModelLaunchDefaultSnapshot = { endpoint: { type: 'llama_cpp_browser' }, modelId: source.model.modelId, revision: 0, storedMatches: true, isStorageCurrent: () => true };
  mocks.capture.mockResolvedValue(chat);
  mocks.captureGlobal.mockResolvedValue(global);
  mocks.copy.mockResolvedValue(saved);
  offerTemporaryModelSave({ chatId, source });
  return { ...useTemporaryModelSave({ chatId: shallowRef(chatId) }), chatId, source, sourceCurrent, saved, savedCurrent, live, historyProof, proofCurrent };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inFence = false;
  mocks.storageCurrent = true;
  mocks.captureWrite.mockImplementation(({ id, content, binding }: { id: import('@/01-models/ids').ChatId, content: import('@/01-models/types').ChatContent | undefined, binding: ChatContentModelBinding | undefined }) => createChatContentWrite({ id, content, binding, isCurrent: () => true }));

  mocks.promoteGlobal.mockResolvedValue('applied');
  mocks.promote.mockResolvedValue({ chat: 'applied', chatGroup: 'not-targeted', content: 'applied' });
  mocks.synchronize.mockResolvedValue('synchronized');
  mocks.beginLaunchPromotion.mockReturnValue({ finish: mocks.finishLaunchPromotion });
  mocks.loadData.mockImplementation(async () => {
    expect(mocks.inFence).toBe(true);
  });
  mocks.validate.mockImplementation(async ({ saved, operation }: { saved: SavedTemporaryModel, operation: ({ model }: { model: SavedTemporaryModel['model'] }) => Promise<unknown> }) => ({ status: 'completed', value: await operation({ model: saved.model }) }));
  mocks.wait.mockImplementation(async () => {
    expect(mocks.inFence).toBe(false);
  });
});

describe('temporary model save ownership', () => {
  it('keeps copying and commits the captured owner after the notice is dismissed', async () => {
    const view = fixture();
    const copy = Promise.withResolvers<SavedTemporaryModel>();
    mocks.copy.mockImplementationOnce(({ onProgress }: { onProgress: ({ progress }: { progress: Progress }) => void }) => {
      onProgress({ progress: { phase: 'importing', completed: 16, total: 32 } });
      return copy.promise;
    });
    const saving = view.save();
    const duplicate = view.save();
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledOnce());
    expect(view.notice.value?.progress?.completed).toBe(16);
    view.dismiss();
    expect(view.notice.value).toBeUndefined();
    copy.resolve(view.saved);
    await saving;
    await duplicate;
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'user/model-2', knownMessageIds: [toMessageId({ raw: 'known-assistant' })] }));
    const write = mocks.captureWrite.mock.results[0]!.value;
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({ expectedContent: write }));
    expect(readChatContentWrite({ write, id: view.chatId })).toMatchObject({ baseline: chatContentFingerprint({ content: view.live }), binding: undefined });
    expect(mocks.synchronize).toHaveBeenCalledWith({ chatId: view.chatId });
    expect(mocks.loadData).toHaveBeenCalledOnce();
    expect(mocks.finishLaunchPromotion).toHaveBeenCalledOnce();
    expect(view.notice.value).toBeUndefined();
  });

  it('retries binding failure without recopying or losing already-proven history IDs', async () => {
    const view = fixture();
    mocks.promote.mockRejectedValueOnce(new Error('Temporary storage failure'));
    await view.save();
    expect(view.notice.value?.phase).toBe('failed');
    expect(mocks.finishLaunchPromotion).toHaveBeenCalledOnce();
    expect(view.historyProof.release).not.toHaveBeenCalled();
    view.live.root.items[0]!.replies.items.push({ ...view.live.root.items[0]!, id: toMessageId({ raw: 'new-descendant' }), replies: { items: [] } });
    await view.retry();
    expect(view.notice.value?.phase).toBe('saved');
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
    expect(mocks.captureHistory).toHaveBeenCalledOnce();
    expect(view.historyProof.allowPromotion).toHaveBeenCalledExactlyOnceWith({ modelId: 'user/model-2' });
    expect(view.historyProof.release).toHaveBeenCalledOnce();
    expect(mocks.promote).toHaveBeenLastCalledWith(expect.objectContaining({ knownMessageIds: [toMessageId({ raw: 'known-assistant' })], knownMessageFingerprints: view.historyProof.fingerprints }));
  });

  it('retries metadata without old history when its original provenance proof was invalidated', async () => {
    const view = fixture();
    const original = view.live.root.items[0]!;
    const unchanged = { ...original, id: toMessageId({ raw: 'unchanged-assistant' }), replies: { items: [] } };
    view.live.root.items.push(unchanged);
    mocks.promote.mockRejectedValueOnce(new Error('Temporary storage failure'));
    await view.save();
    original.parts = [{ type: 'text', text: 'Another tab replaced this response', completeness: 'complete' }];
    view.proofCurrent.value = false;
    await view.retry();
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
    expect(mocks.promote).toHaveBeenLastCalledWith(expect.objectContaining({ knownMessageIds: [], knownMessageFingerprints: new Map() }));
    expect(view.notice.value?.phase).toBe('saved');
  });

  it('finishes matching owner and history scopes after a global failure and retries only the unfinished writes', async () => {
    const view = fixture();
    const commitOwner = vi.fn();
    let ownerModelId = view.source.model.modelId;
    mocks.promoteGlobal.mockRejectedValueOnce(new Error('Global settings write failed'));
    mocks.promote.mockImplementation(async ({ modelId }: { modelId: string }) => {
      if (ownerModelId === modelId) {
        return { chat: 'changed', chatGroup: 'changed', content: 'changed' };
      }
      commitOwner();
      ownerModelId = modelId;
      view.live.root.items[0]!.modelId = modelId;
      return { chat: 'applied', chatGroup: 'applied', content: 'applied' };
    });

    await view.save();
    expect(view.notice.value?.phase).toBe('failed');
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({
      modelId: view.saved.model.modelId,
      globalOutcome: 'changed',
      knownMessageIds: view.historyProof.messageIds,
      knownMessageFingerprints: view.historyProof.fingerprints,
    }));
    expect(ownerModelId).toBe(view.saved.model.modelId);
    expect(view.live.root.items[0]!.modelId).toBe(view.saved.model.modelId);
    expect(commitOwner).toHaveBeenCalledOnce();
    expect(mocks.finishLaunchPromotion).toHaveBeenCalledOnce();
    expect(view.historyProof.release).not.toHaveBeenCalled();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();

    await view.retry();
    expect(view.notice.value?.phase).toBe('saved');
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.promoteGlobal).toHaveBeenCalledTimes(2);
    expect(mocks.promote).toHaveBeenLastCalledWith(expect.objectContaining({ globalOutcome: 'applied', modelId: view.saved.model.modelId }));
    expect(commitOwner).toHaveBeenCalledOnce();
    expect(ownerModelId).toBe(view.saved.model.modelId);
    expect(mocks.captureHistory).toHaveBeenCalledOnce();
    expect(view.historyProof.release).toHaveBeenCalledOnce();
  });

  it.each(['provider', 'source'])('does not write the owner after a global failure invalidates its %s capability', async invalidation => {
    const view = fixture();
    mocks.promoteGlobal.mockImplementationOnce(async () => {
      switch (invalidation) {
      case 'provider': mocks.storageCurrent = false;
        break;
      case 'source': view.sourceCurrent.value = false;
        break;
      default: throw new Error(invalidation);
      }
      throw new Error('Global settings write failed');
    });
    await view.save();
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.loadData).not.toHaveBeenCalled();
    expect(mocks.finishLaunchPromotion).toHaveBeenCalledOnce();
    expect(view.notice.value).toBeUndefined();
  });

  it('waits for another file mutation outside the chat admission fence', async () => {
    const view = fixture();
    mocks.validate.mockResolvedValueOnce({ status: 'busy' });
    mocks.promoteGlobal.mockResolvedValueOnce('changed');
    await view.save();
    expect(mocks.wait).toHaveBeenCalledOnce();
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({ globalOutcome: 'changed' }));
    expect(view.notice.value?.phase).toBe('saved');
  });

  it('keeps a dirty live proposal while allowing the independent global binding to finish', async () => {
    const view = fixture();
    const proposal = JSON.stringify(view.live);
    mocks.synchronize.mockResolvedValueOnce('changed');
    await view.save();
    expect(view.notice.value?.phase).toBe('failed');
    expect(JSON.stringify(view.live)).toBe(proposal);
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.captureHistory).not.toHaveBeenCalled();
    await view.retry();
    expect(view.notice.value?.phase).toBe('saved');
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.promoteGlobal).toHaveBeenCalledOnce();
  });

  it('fails finalization when the saved root changed and recopies only on retry', async () => {
    const view = fixture();
    mocks.validate.mockResolvedValueOnce({ status: 'changed' });
    await view.save();
    expect(view.notice.value).toMatchObject({ phase: 'failed', error: 'missing-model' });
    expect(mocks.promoteGlobal).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
    const replacement: SavedTemporaryModel = { ...view.saved, model: { ...view.saved.model, modelId: 'user/model-3' } };
    mocks.copy.mockResolvedValueOnce(replacement);
    await view.retry();
    expect(mocks.copy).toHaveBeenCalledTimes(2);
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'user/model-3' }));
    expect(view.notice.value).toMatchObject({ phase: 'saved', model: { modelId: 'user/model-3' } });
  });

  it('removes a saved success state when its committed receipt is invalidated', async () => {
    const view = fixture();
    await view.save();
    expect(view.notice.value?.phase).toBe('saved');
    view.savedCurrent.value = false;
    mocks.modelListListener?.();
    expect(view.notice.value).toMatchObject({ phase: 'failed', error: 'missing-model' });
    const replacement: SavedTemporaryModel = {
      model: { ...view.saved.model, modelId: 'user/model-3' },
      receipt: { ...view.saved.receipt, publication: { generation: sequence + 1, isCurrent: () => true } },
    };
    mocks.copy.mockResolvedValueOnce(replacement);
    await view.retry();
    expect(mocks.copy).toHaveBeenCalledTimes(2);
    expect(view.notice.value).toMatchObject({ phase: 'saved', model: { modelId: 'user/model-3' } });
  });
});
