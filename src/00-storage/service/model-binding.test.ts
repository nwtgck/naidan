import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only preload keeps real strings available without changing storage runtime dependencies.
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { StorageService, ChatContentBindingChangedError } from './index';
import { LocalStorageProvider } from './local-storage';
import { DEFAULT_SETTINGS, type ChatMeta, type ChatGroup, type ChatContent, type MessageNode } from '@/01-models/types';
import { toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { ChatContentSchemaDto, ChatMetaSchemaDto } from '@/00-storage/00-dto/dto';
import { chatContentToDomain, chatContentToDto } from '@/00-storage/mapper/mappers';
import { chatModelBindingAssistantFingerprint } from '@/01-models/chat-message';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Observe real persistence without application notifications.
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));

const chatId = toChatId({ raw: 'binding-owner' });
const chatGroupId = toChatGroupId({ raw: 'binding-source' });
const sourceModelId = 'temp/source:Q4';
const savedModelId = 'user/source-2:Q4';
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

function assistant({ id, modelId }: { id: string, modelId: string }): MessageNode {
  return { id: toMessageId({ raw: id }), role: 'assistant', createdAt: 1, modelId, lmParameters: undefined, interruption: undefined, parts: [{ type: 'text', text: id, completeness: 'complete' }], replies: { items: [] } };
}

async function owner({ chatOverrides, chatGroupOverrides }: { chatOverrides: Partial<ChatMeta> | undefined, chatGroupOverrides: Partial<ChatGroup> | undefined }): Promise<StorageService> {
  const service = new StorageService();
  await service.init({ type: 'local' });
  await service.updateSettings({ updater: () => ({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'llama_cpp_browser' }, defaultModelId: sourceModelId }) });
  await service.updateChatGroup({ id: chatGroupId, updater: () => ({ id: chatGroupId, name: 'Source', isCollapsed: false, items: [], updatedAt: 1, modelId: sourceModelId, ...chatGroupOverrides }) });
  await service.updateChatMeta({ id: chatId, updater: () => ({ id: chatId, title: 'Owner', createdAt: 1, updatedAt: 1, debugEnabled: false, ...chatOverrides }) });
  await service.updateChatContent({ id: chatId, write: service.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => ({ root: { items: [assistant({ id: 'known', modelId: sourceModelId }), assistant({ id: 'unknown', modelId: sourceModelId }), assistant({ id: 'other-variant', modelId: 'temp/source:Q8' })] } }) });
  await service.updateHierarchy({ updater: () => ({ items: [{ type: 'chat_group', id: chatGroupId, chat_ids: [chatId] }] }) });
  return service;
}

async function contentWrite({ service, content }: { service: StorageService, content?: ChatContent }) {
  return service.createChatContentWrite({ id: chatId, content: content ?? (await service.loadChatContent({ id: chatId })) ?? undefined, binding: undefined });
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: simulatedWebLocks() });
});

afterEach(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks }));

describe('conditional owner model promotion', () => {
  it('promotes a chat-owned pair without changing its existing chat group', async () => {
    const service = await owner({ chatOverrides: { groupId: chatGroupId, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId }, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    expect(expected.chatGroupTarget).toBe('not-targeted');
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [toMessageId({ raw: 'known' })], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(result).toEqual({ chat: 'applied', chatGroup: 'not-targeted', content: 'applied' });
    expect(await service.loadChatMeta({ id: chatId })).toMatchObject({ groupId: chatGroupId, endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId });
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(sourceModelId);
    expect((await service.loadSettings())?.defaultModelId).toBe(sourceModelId);
    expect((await service.loadChatContent({ id: chatId }))?.root.items.map(node => node.modelId)).toEqual([savedModelId, sourceModelId, 'temp/source:Q8']);
  });

  it.each([
    { endpoint: { type: 'llama_cpp_browser' as const }, modelId: undefined },
    { endpoint: undefined, modelId: sourceModelId },
    { endpoint: { type: 'llama_cpp_browser' as const }, modelId: 'temp/source:Q8' },
  ])('uses the resolved pair when an explicit field is inherited: %j', async chatOverrides => {
    const service = await owner({ chatOverrides: { groupId: chatGroupId, ...chatOverrides }, chatGroupOverrides: undefined });
    const capture = await service.captureModelBinding({ chatId, sourceModelId });
    expect(capture !== undefined).toBe(chatOverrides.modelId !== 'temp/source:Q8');
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(sourceModelId);
  });

  it('does not apply an old snapshot after its explicit override is cleared', async () => {
    const service = await owner({ chatOverrides: { groupId: chatGroupId, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId }, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: undefined }) });
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(result).toEqual({ chat: 'changed', chatGroup: 'not-targeted', content: 'changed' });
    expect((await service.loadChatMeta({ id: chatId }))?.modelId).toBeUndefined();
    expect(await service.captureModelBinding({ chatId, sourceModelId })).toBeDefined();
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(sourceModelId);
  });

  it('captures current resolved settings after a queued update changes and restores the pair', async () => {
    const service = await owner({ chatOverrides: { groupId: chatGroupId, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId }, chatGroupOverrides: undefined });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const change = service.updateChatMeta({
      id: chatId,
      updater: async ({ current }) => {
        entered.resolve();
        await release.promise;
        return { ...current!, modelId: 'manual-model' };
      },
    });
    await entered.promise;
    const revert = service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: sourceModelId }) });
    const capture = service.captureModelBinding({ chatId, sourceModelId });
    release.resolve();
    await Promise.all([change, revert]);
    expect(await capture).toBeDefined();
    expect(await service.captureModelBinding({ chatId, sourceModelId })).toBeDefined();
  });

  it('keeps launch receipts and write authority out of ordinary DTOs', () => {
    const parsed = ChatContentSchemaDto.parse({ root: { items: [] } });
    expect(parsed).not.toHaveProperty('modelBindingEpoch');
    const domain = chatContentToDomain({ dto: parsed });
    expect(chatContentToDto({ domain })).not.toHaveProperty('modelBindingEpoch');
    expect(ChatMetaSchemaDto.parse({ id: 'legacy', title: null, updatedAt: 1, createdAt: 1 })).not.toHaveProperty('modelLaunch');
  });

  it('promotes only known exact-source answers and rejects a foreign stale tree before calling its updater', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const foreign = new StorageService();
    await foreign.init({ type: 'local' });
    const stale = (await foreign.loadChatContent({ id: chatId }))!;
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [toMessageId({ raw: 'known' }), toMessageId({ raw: 'other-variant' })], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(result).toMatchObject({ chat: 'applied', chatGroup: 'applied', content: 'applied' });
    const fresh = (await service.loadChatContent({ id: chatId }))!;
    expect(fresh).not.toHaveProperty('modelBindingEpoch');
    expect(fresh.root.items.map(node => node.modelId)).toEqual([savedModelId, sourceModelId, 'temp/source:Q8']);
    for (const operation of ['send', 'regenerate', 'history']) {
      const updater = vi.fn(() => stale);
      await expect(foreign.updateChatContent({ id: chatId, write: await contentWrite({ service: foreign, content: stale }), updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
      expect(updater, operation).not.toHaveBeenCalled();
    }
    expect(await service.loadChatContent({ id: chatId })).toEqual(fresh);
    await foreign.updateChatContent({ id: chatId, write: await contentWrite({ service: foreign, content: fresh }), updater: ({ current }) => ({ root: current!.root, currentLeafId: toMessageId({ raw: 'known' }) }) });
    expect(await service.loadChatContent({ id: chatId })).not.toHaveProperty('modelBindingEpoch');
  });

  it('keeps the supplying group eligible when the owner alone changes', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    await service.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: 'manual-model' }) });
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [toMessageId({ raw: 'known' })], expectedContent: await contentWrite({ service }), globalOutcome: 'changed' });
    expect(result).toMatchObject({ chat: 'changed', chatGroup: 'applied', content: 'changed' });
    expect((await service.loadChatMeta({ id: chatId }))?.modelId).toBe('manual-model');
    expect(await service.loadChatContent({ id: chatId })).not.toHaveProperty('modelBindingEpoch');
  });

  it('uses an owner override when its supplying group belongs to another endpoint', async () => {
    const service = await owner({ chatOverrides: { endpoint: { type: 'llama_cpp_browser' } }, chatGroupOverrides: { endpoint: { type: 'openai', url: 'https://example.invalid' } } });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(result).toMatchObject({ chat: 'applied', chatGroup: 'not-targeted' });
    expect(await service.loadChatMeta({ id: chatId })).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId });
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(sourceModelId);
  });

  it.each([undefined, ''])('preserves group inheritance after its supplying global model is saved (group model %s)', async groupModelId => {
    const service = await owner({ chatOverrides: { groupId: chatGroupId }, chatGroupOverrides: { modelId: groupModelId } });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    await service.updateSettings({ updater: ({ current }) => ({ ...current!, defaultModelId: savedModelId, systemPrompt: 'Keep me' }) });
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'applied' });
    expect(expected.chatGroupTarget).toBe('not-targeted');
    expect(result).toMatchObject({ chat: 'applied', chatGroup: 'not-targeted' });
    expect((await service.loadChatMeta({ id: chatId }))?.modelId).toBeUndefined();
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(groupModelId);
    expect((await service.loadSettings())?.systemPrompt).toBe('Keep me');
  });

  it('rejects same-page group change and revert independently of the owner fallback', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    for (const modelId of ['other', sourceModelId]) {
      await service.updateChatGroup({ id: chatGroupId, updater: ({ current }) => ({ ...current!, modelId }) });
    }
    const result = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(result).toMatchObject({ chat: 'applied', chatGroup: 'changed' });
    expect((await service.loadChatMeta({ id: chatId }))?.modelId).toBe(savedModelId);
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(sourceModelId);
  });

  it('does not revive a moved owner or apply a snapshot to a replacement provider', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    await service.updateHierarchy({ updater: () => ({ items: [{ type: 'chat', id: chatId }] }) });
    const moved = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(moved).toMatchObject({ chat: 'changed', chatGroup: 'changed', content: 'changed' });
    await service.init({ type: 'memory' });
    const retired = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(retired.chat).toBe('changed');
    expect(await service.loadChatMeta({ id: chatId })).toBeNull();
  });

  it.each(['before', 'after'] as const)('retries content failure %s the durable write without losing its already applied scopes', async timing => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    using notified = vi.spyOn(service, 'notify');
    const write = LocalStorageProvider.prototype.saveChatContent;
    const interrupted = vi.spyOn(LocalStorageProvider.prototype, 'saveChatContent').mockImplementationOnce(async function (this: LocalStorageProvider, args) {
      if (timing === 'after') {
        await write.call(this, args);
      }
      throw new Error('content write interrupted');
    });
    const request = { expected, modelId: savedModelId, knownMessageIds: [toMessageId({ raw: 'known' })], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' as const };
    await expect(service.promoteModelBinding(request)).rejects.toThrow('content write interrupted');
    expect(notified).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'binding-owner' }) });
    expect(notified).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_content', id: 'binding-owner' }) });
    interrupted.mockRestore();
    const partial = await service.loadChatContent({ id: chatId });
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(savedModelId);
    const retried = await service.promoteModelBinding(request);
    expect(retried).toMatchObject({ chat: 'applied', chatGroup: 'applied', content: 'applied' });
    const content = (await service.loadChatContent({ id: chatId }))!;
    expect(content.root.items[0]?.modelId).toBe(savedModelId);
    expect(content.root.items[1]?.modelId).toBe(sourceModelId);
    if (timing === 'after') {
      expect(content).toEqual(partial);
    } else {
      expect(content).not.toHaveProperty('modelBindingEpoch');
    }
  });

  it('fails closed for automatic promotion without blocking ordinary writes when Web Locks are unavailable', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    const request = { expected, modelId: savedModelId, knownMessageIds: [], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' as const };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    expect(await service.promoteModelBinding(request)).toMatchObject({ chat: 'changed', chatGroup: 'changed', content: 'changed' });
    expect((await service.loadChatGroup({ id: chatGroupId }))?.modelId).toBe(sourceModelId);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: simulatedWebLocks() });
    await service.promoteModelBinding(request);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const updater = vi.fn(() => ({ root: { items: [] } }));
    await service.updateChatContent({ id: chatId, write: await contentWrite({ service }), updater });
    expect(updater).toHaveBeenCalledOnce();
    expect(await service.loadChatForModelBinding({ id: chatId })).toMatchObject({ status: 'loaded' });
    await service.updateChatContent({ id: toChatId({ raw: 'ordinary' }), write: service.createChatContentWrite({ id: toChatId({ raw: 'ordinary' }), content: undefined, binding: undefined }), updater: () => ({ root: { items: [] } }) });
    expect((await service.loadChatContent({ id: toChatId({ raw: 'ordinary' }) }))?.root.items).toEqual([]);
  });

  it('does not promote a same-ID answer replaced by an ordinary foreign content write', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    const before = (await service.loadChatContent({ id: chatId }))!;
    const known = before.root.items[0];
    if (!known || known.role !== 'assistant') {
      throw new Error('Missing known assistant');
    }
    const knownMessageFingerprints = new Map([[known.id, chatModelBindingAssistantFingerprint({ node: known })]]);
    const foreign = new StorageService();
    await foreign.init({ type: 'local' });
    await foreign.updateChatContent({ id: chatId, write: await contentWrite({ service: foreign }), updater: ({ current }) => ({ ...current!, root: { items: [{ ...known, parts: [{ type: 'text', text: 'foreign replacement', completeness: 'complete' }] }, ...current!.root.items.slice(1)] } }) });
    const promoted = await service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [known.id], knownMessageFingerprints, expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    expect(promoted.chat).toBe('applied');
    const after = (await service.loadChatContent({ id: chatId }))!;
    expect(after.root.items[0]?.modelId).toBe(sourceModelId);
    expect(after.root.items[0]?.parts[0]).toMatchObject({ text: 'foreign replacement' });
  });

  it('waits for complete metadata and content promotion before returning an admission snapshot', async () => {
    const service = await owner({ chatOverrides: undefined, chatGroupOverrides: undefined });
    const expected = (await service.captureModelBinding({ chatId, sourceModelId }))!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = LocalStorageProvider.prototype.saveChatContent;
    const hold = vi.spyOn(LocalStorageProvider.prototype, 'saveChatContent').mockImplementationOnce(async function (this: LocalStorageProvider, args) {
      entered.resolve();
      await release.promise;
      await write.call(this, args);
    });
    const promotion = service.promoteModelBinding({ expected, modelId: savedModelId, knownMessageIds: [toMessageId({ raw: 'known' })], expectedContent: await contentWrite({ service }), globalOutcome: 'not-targeted' });
    await entered.promise;
    const load = vi.spyOn(LocalStorageProvider.prototype, 'loadChat');
    const read = service.loadChatForModelBinding({ id: chatId });
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    release.resolve();
    await promotion;
    hold.mockRestore();
    const snapshot = await read;
    expect(snapshot.status).toBe('loaded');
    switch (snapshot.status) {
    case 'loaded':
      expect(snapshot.chat).not.toHaveProperty('modelBindingEpoch');
      expect(snapshot.chat?.root.items[0]?.modelId).toBe(savedModelId);
      break;
    case 'changed': throw new Error('The unchanged provider should return a snapshot');
    default: {
      const exhaustive: never = snapshot;
      throw new Error(String(exhaustive));
    }
    }
    load.mockRestore();
  });
});
