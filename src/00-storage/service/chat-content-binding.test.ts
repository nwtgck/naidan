import { beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only preload keeps real strings available without changing storage runtime dependencies.
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { StorageService, ChatContentBindingChangedError } from './index';
import { MemoryStorageProvider } from './memory-storage';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS, type ChatContent, type MessageNode } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId } from '@/01-models/ids';
import { chatContentFingerprint, snapshotChatContent } from './chat-content-binding';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Observe persistence without application notifications.
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));

const chatId = toChatId({ raw: 'content-owner' });

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function node({ text }: { text: string }): MessageNode {
  return { id: toMessageId({ raw: text }), role: 'assistant', modelId: 'temp/source:Q4', createdAt: 1, lmParameters: undefined, interruption: undefined, parts: [{ type: 'text', text, completeness: 'complete' }], replies: { items: [] } };
}

async function owner() {
  const service = new StorageService();
  await service.init({ type: 'memory' });
  await service.updateSettings({ updater: () => ({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'temp/source:Q4' }) });
  await service.updateChatMeta({ id: chatId, updater: () => ({ id: chatId, title: null, createdAt: 1, updatedAt: 1, debugEnabled: false }) });
  await service.updateChatContent({ id: chatId, write: service.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => ({ root: { items: [] }, currentLeafId: undefined }) });
  await service.updateHierarchy({ updater: () => ({ items: [{ type: 'chat', id: chatId }] }) });
  return service;
}

describe('operation-local content and model comparisons', () => {
  it('rejects an old model operation even when promotion leaves empty content unchanged', async () => {
    const service = await owner();
    const content = (await service.loadChatContent({ id: chatId }))!;
    const write = service.createChatContentWrite({ id: chatId, content, binding: { groupId: undefined, endpoint: { type: 'llama_cpp_browser' }, modelId: 'temp/source:Q4', endpointSource: 'global', modelSource: 'global' } });
    await service.updateSettings({ updater: ({ current }) => ({ ...current!, defaultModelId: 'user/source:Q4' }) });
    await expect(service.updateChatContent({ id: chatId, write, updater: () => ({ root: { items: [node({ text: 'stale' })] } }) })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect((await service.loadChatContent({ id: chatId }))?.root.items).toEqual([]);
  });

  it('does not let a stale operation borrow a newer operation baseline', async () => {
    const service = await owner();
    const content = (await service.loadChatContent({ id: chatId }))!;
    const first = service.createChatContentWrite({ id: chatId, content, binding: undefined });
    const second = service.createChatContentWrite({ id: chatId, content, binding: undefined });
    await service.updateChatContent({ id: chatId, write: first, updater: () => ({ root: { items: [node({ text: 'accepted' })] } }) });
    const stale = vi.fn(() => ({ root: { items: [] } }));
    await expect(service.updateChatContent({ id: chatId, write: second, updater: stale })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(stale).not.toHaveBeenCalled();
    expect((await service.loadChatContent({ id: chatId }))?.root.items[0]?.id).toBe('accepted');
  });

  it('serializes periodic saves and advances only their own successful baseline', async () => {
    const service = await owner();
    const write = service.createChatContentWrite({ id: chatId, content: (await service.loadChatContent({ id: chatId }))!, binding: undefined });
    await Promise.all(['one', 'two', 'three'].map(text => service.updateChatContent({ id: chatId, write, updater: ({ current }) => ({ root: { items: [...current!.root.items, node({ text })] } }) })));
    expect((await service.loadChatContent({ id: chatId }))?.root.items.map(item => item.id)).toEqual(['one', 'two', 'three']);
  });

  it('runs application updaters outside the storage locks and rechecks after their awaits', async () => {
    const service = await owner();
    const content = (await service.loadChatContent({ id: chatId }))!;
    const write = service.createChatContentWrite({ id: chatId, content, binding: undefined });
    const competing = service.createChatContentWrite({ id: chatId, content, binding: undefined });
    await expect(service.updateChatContent({
      id: chatId,
      write,
      updater: async () => {
        await service.updateChatContent({ id: chatId, write: competing, updater: () => ({ root: { items: [node({ text: 'newer' })] } }) });
        return { root: { items: [node({ text: 'older' })] } };
      },
    })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect((await service.loadChatContent({ id: chatId }))?.root.items[0]?.id).toBe('newer');
  });

  it('detaches a proposal before an asynchronous write while retaining live stream changes', async () => {
    const service = await owner();
    const write = service.createChatContentWrite({ id: chatId, content: (await service.loadChatContent({ id: chatId }))!, binding: undefined });
    const stop = ['initial stop'];
    const first = node({ text: 'accepted' });
    if (first.role !== 'assistant') {
      throw new Error('Expected an assistant fixture');
    }
    first.lmParameters = { ...EMPTY_LM_PARAMETERS, stop };
    const live: ChatContent = { root: { items: [first] } };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const save = MemoryStorageProvider.prototype.saveChatContent;
    using held = vi.spyOn(MemoryStorageProvider.prototype, 'saveChatContent').mockImplementationOnce(async function (this: MemoryStorageProvider, args) {
      entered.resolve();
      await release.promise;
      await save.call(this, args);
    });
    const pending = service.updateChatContent({ id: chatId, write, updater: () => live });
    await entered.promise;
    live.root.items.push(node({ text: 'still-streaming' }));
    stop.push('later stop');
    release.resolve();
    const persisted = await pending;
    expect(persisted.root.items.map(item => item.id)).toEqual(['accepted']);
    expect(persisted.root.items[0]?.lmParameters?.stop).toEqual(['initial stop']);
    expect(live.root.items).toHaveLength(2);
    expect(held).toHaveBeenCalledOnce();
    await service.updateChatContent({ id: chatId, write, updater: () => live });
    const latest = (await service.loadChatContent({ id: chatId }))!;
    expect(latest.root.items).toHaveLength(2);
    expect(latest.root.items[0]?.lmParameters?.stop).toEqual(['initial stop', 'later stop']);
  });

  it('keeps a create-only write from replacing existing content', async () => {
    const service = await owner();
    const write = service.createChatContentWrite({ id: chatId, content: undefined, binding: undefined });
    await expect(service.updateChatContent({ id: chatId, write, updater: () => ({ root: { items: [node({ text: 'replacement' })] } }) })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
  });

  it('invalidates outstanding operations when the provider generation changes', async () => {
    const service = await owner();
    const write = service.createChatContentWrite({ id: chatId, content: (await service.loadChatContent({ id: chatId }))!, binding: undefined });
    await service.clearAll();
    const updater = vi.fn(() => ({ root: { items: [] } }));
    await expect(service.updateChatContent({ id: chatId, write, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(updater).not.toHaveBeenCalled();
    expect(await service.loadChatContent({ id: chatId })).toBeNull();
  });

  it('compares persisted fields and snapshots nested branches independently', () => {
    const content: ChatContent = { root: { items: [node({ text: 'parent' })] } };
    content.root.items[0]!.replies.items.push(node({ text: 'child' }));
    const snapshot = snapshotChatContent({ content });
    expect(chatContentFingerprint({ content: snapshot })).toBe(chatContentFingerprint({ content }));
    content.root.items[0]!.replies.items.length = 0;
    expect(snapshot.root.items[0]!.replies.items).toHaveLength(1);
  });

  it('preserves separate descriptors when branches share an attachment ID', () => {
    const attachment = { id: toAttachmentId({ raw: 'shared' }), binaryObjectId: toBinaryObjectId({ raw: 'body' }), originalName: 'original.txt', status: 'persisted' as const, mimeType: 'text/plain', size: 10, uploadedAt: 1 };
    const first: MessageNode = { id: toMessageId({ raw: 'first' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ type: 'attachment', attachment }], replies: { items: [] } };
    const second: MessageNode = { ...first, id: toMessageId({ raw: 'second' }), parts: [{ type: 'attachment', attachment: { ...attachment, originalName: 'renamed.txt', status: 'missing' } }] };
    const content = { root: { items: [first, second] } };
    const snapshot = snapshotChatContent({ content });
    expect(chatContentFingerprint({ content: snapshot })).toBe(chatContentFingerprint({ content }));
    expect(snapshot.root.items[0]?.parts[0]).toMatchObject({ attachment: { originalName: 'original.txt', status: 'persisted' } });
    expect(snapshot.root.items[1]?.parts[0]).toMatchObject({ attachment: { originalName: 'renamed.txt', status: 'missing' } });
  });
});
