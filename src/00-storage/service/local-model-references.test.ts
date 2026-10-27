import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only preload keeps persistence assertions independent of lazy copy loading.
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { DEFAULT_SETTINGS, type ChatMeta, type ChatContent } from '@/01-models/types';
import { toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { ChatContentBindingChangedError, StorageService } from './index';
import { MemoryStorageProvider } from './memory-storage';
import { sameLocalModelBinding, TEST_ONLY } from './local-model-references';

// eslint-disable-next-line local-rules/enforce-dependency-directions -- Observe persistence without application error notifications.
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));

const sourceModelId = '~user/Repo/Model-Q4_K_M';
const modelId = 'user/Repo-2/Model-Q4_K_M';
const chatId = toChatId({ raw: 'file-source-chat' });
const chatGroupId = toChatGroupId({ raw: 'file-source-chat-group' });
const proofScopes = new Set<{ current: boolean }>();

async function memoryService() {
  const storage = new StorageService();
  vi.spyOn(storage, 'notify').mockImplementation(() => {});
  await storage.init({ type: 'memory' });
  return storage;
}

async function service() {
  const storage = await memoryService();
  await storage.updateSettings({ updater: () => ({ ...structuredClone(DEFAULT_SETTINGS), storageType: 'memory', endpoint: { type: 'llama_cpp_browser' }, defaultModelId: sourceModelId }) });
  return storage;
}

function meta({ id, overrides }: { id: ChatMeta['id'], overrides: Partial<ChatMeta> }): ChatMeta {
  return { id, title: 'Keep this title', createdAt: 1, updatedAt: 2, debugEnabled: true, ...overrides };
}

function proof() {
  let active = 0;
  const scope = { current: true };
  proofScopes.add(scope);
  return {
    mappings: [{ sourceModelId, modelId }],
    isCurrent: () => scope.current,
    isIdentityCurrent: () => scope.current,
    isModelCurrent: () => true,
    retain: () => {
      active++;
      return {
        release() {
          active--;
        },
      };
    },
    withCurrentFiles: async ({ operation }: { operation(): Promise<void> }) => operation(),
    active: () => active,
  };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  TEST_ONLY.reset();
  localStorage.clear();
  vi.stubGlobal('navigator', {});
});

afterEach(async () => {
  for (const scope of proofScopes) {
    scope.current = false;
  }
  proofScopes.clear();
  // Retire the captured source before the next test reuses its readable name.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TEST_ONLY.reset();
});

describe('captured local model reference promotion', () => {
  it('promotes the first chat override and its title model without creating global settings', async () => {
    const storage = await memoryService();
    await storage.updateChatMeta({ id: chatId, updater: () => meta({ id: chatId, overrides: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, titleGeneration: { endpoint: 'same_scope', model: { id: sourceModelId }, lmParameters: 'same_scope' } } }) });
    const content: ChatContent = { root: { items: [] } };
    await storage.updateChatContent({ id: chatId, write: storage.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => content });
    const write = storage.createChatContentWrite({ id: chatId, content, binding: { groupId: undefined, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, endpointSource: 'chat', modelSource: 'chat' } });
    const globalWrite = vi.spyOn(MemoryStorageProvider.prototype, 'saveSettings');
    await storage.promoteLocalModelReferences(proof());
    expect(await storage.loadChatMeta({ id: chatId })).toMatchObject({ modelId, titleGeneration: { model: { id: modelId } }, updatedAt: 2 });
    await expect(storage.updateChatContent({ id: chatId, write, updater: () => content })).resolves.toEqual(content);
    expect(await storage.loadSettings()).toBeNull();
    expect(globalWrite).not.toHaveBeenCalled();
  });

  it('promotes inherited chat group models and independent chat model overrides before global settings exist', async () => {
    const storage = await memoryService();
    await storage.updateChatGroup({ id: chatGroupId, updater: () => ({ id: chatGroupId, name: 'Initial chat group', items: [], isCollapsed: false, updatedAt: 3, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId }) });
    await storage.updateChatMeta({ id: chatId, updater: () => meta({ id: chatId, overrides: {} }) });
    const independentId = toChatId({ raw: 'independent-first-chat' });
    await storage.updateChatMeta({ id: independentId, updater: () => meta({ id: independentId, overrides: { modelId: sourceModelId } }) });
    await storage.updateHierarchy({ updater: () => ({ items: [{ type: 'chat_group', id: chatGroupId, chat_ids: [chatId, independentId] }] }) });
    const content: ChatContent = { root: { items: [] } };
    for (const id of [chatId, independentId]) {
      await storage.updateChatContent({ id, write: storage.createChatContentWrite({ id, content: undefined, binding: undefined }), updater: () => content });
    }
    const inheritedWrite = storage.createChatContentWrite({ id: chatId, content, binding: { groupId: 'file-source-chat-group', endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, endpointSource: 'chat_group', modelSource: 'chat_group' } });
    const independentWrite = storage.createChatContentWrite({ id: independentId, content, binding: { groupId: 'file-source-chat-group', endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, endpointSource: 'chat_group', modelSource: 'chat' } });
    await storage.promoteLocalModelReferences(proof());
    expect(await storage.loadChatGroup({ id: chatGroupId })).toMatchObject({ modelId, updatedAt: 3 });
    const inherited = await storage.loadChatMeta({ id: chatId });
    expect(inherited?.modelId).toBeUndefined();
    expect(inherited?.endpoint).toBeUndefined();
    const independent = await storage.loadChatMeta({ id: independentId });
    expect(independent?.modelId).toBe(modelId);
    expect(independent?.endpoint).toBeUndefined();
    await expect(storage.updateChatContent({ id: chatId, write: inheritedWrite, updater: () => content })).resolves.toEqual(content);
    await expect(storage.updateChatContent({ id: independentId, write: independentWrite, updater: () => content })).resolves.toEqual(content);
    expect(await storage.loadSettings()).toBeNull();
  });

  it.each(['changed-model', 'missing-model'] as const)('rejects a %s binding before global settings exist', async condition => {
    const storage = await memoryService();
    await storage.updateChatMeta({ id: chatId, updater: () => meta({ id: chatId, overrides: condition === 'changed-model' ? { endpoint: { type: 'llama_cpp_browser' }, modelId: 'user/New/Model' } : {} }) });
    const content: ChatContent = { root: { items: [] } };
    await storage.updateChatContent({ id: chatId, write: storage.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => content });
    const write = storage.createChatContentWrite({ id: chatId, content, binding: { groupId: undefined, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, endpointSource: 'chat', modelSource: 'chat' } });
    const updater = vi.fn(() => content);
    await expect(storage.updateChatContent({ id: chatId, write, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(await storage.loadChatContent({ id: chatId })).toEqual(content);
    expect(await storage.loadSettings()).toBeNull();
  });

  it('updates known model owners and explicit title models without materializing inherited overrides or rewriting history', async () => {
    const storage = await service();
    await storage.updateSettings({ updater: ({ current }) => ({ ...current!, titleGeneration: { endpoint: 'same_scope', model: { id: sourceModelId }, lmParameters: 'same_scope' } }) });
    await storage.updateChatGroup({ id: chatGroupId, updater: () => ({ id: chatGroupId, name: 'Keep this name', items: [], isCollapsed: false, updatedAt: 3, modelId: sourceModelId }) });
    await storage.updateChatMeta({ id: chatId, updater: () => meta({ id: chatId, overrides: {} }) });
    await storage.updateHierarchy({ updater: () => ({ items: [{ type: 'chat_group', id: chatGroupId, chat_ids: [chatId] }] }) });
    const explicitId = toChatId({ raw: 'explicit-local-model' });
    await storage.updateChatMeta({ id: explicitId, updater: () => meta({ id: explicitId, overrides: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, systemPrompt: { behavior: 'override', content: 'Keep this prompt' } } }) });
    const content: ChatContent = { root: { items: [{ id: toMessageId({ raw: 'prior-answer' }), role: 'assistant', createdAt: 1, modelId: sourceModelId, lmParameters: undefined, interruption: undefined, parts: [{ type: 'text', text: 'Keep this response', completeness: 'complete' }], replies: { items: [] } }] } };
    await storage.updateChatContent({ id: explicitId, write: storage.createChatContentWrite({ id: explicitId, content: undefined, binding: undefined }), updater: () => content });
    const scan = vi.spyOn(storage, 'listChatGroups');
    const hydrateChatGroup = vi.spyOn(MemoryStorageProvider.prototype, 'loadChatGroup');
    const copy = proof();
    const retainedDuringReflection: number[] = [];
    const reflected = vi.fn(() => {
      retainedDuringReflection.push(copy.active());
    });
    using _subscription = { [Symbol.dispose]: storage.subscribeLocalModelPromotions({ listener: reflected }) };
    await storage.promoteLocalModelReferences(copy);
    expect(copy.active()).toBe(0);
    expect(hydrateChatGroup).not.toHaveBeenCalled();
    expect((await storage.loadSettings())?.defaultModelId).toBe(modelId);
    expect((await storage.loadSettings())?.titleGeneration).toMatchObject({ model: { id: modelId } });
    expect(await storage.loadChatGroup({ id: chatGroupId })).toMatchObject({ name: 'Keep this name', modelId, updatedAt: 3 });
    expect(await storage.loadChatMeta({ id: chatId })).toMatchObject({ title: 'Keep this title', debugEnabled: true, groupId: chatGroupId });
    expect((await storage.loadChatMeta({ id: chatId }))?.modelId).toBeUndefined();
    expect((await storage.loadChatMeta({ id: chatId }))?.endpoint).toBeUndefined();
    expect(await storage.loadChatMeta({ id: explicitId })).toMatchObject({ modelId, systemPrompt: { behavior: 'override', content: 'Keep this prompt' }, updatedAt: 2 });
    expect(await storage.loadChatContent({ id: explicitId })).toEqual(content);
    expect(scan).not.toHaveBeenCalled();
    expect(reflected).toHaveBeenCalledTimes(3);
    expect(retainedDuringReflection).toEqual([1, 1, 1]);
  });

  it('preserves a newer selection and does not treat matching API or Transformers.js names as local copies', async () => {
    const storage = await service();
    const apiId = toChatId({ raw: 'same-name-api-model' });
    await storage.updateChatMeta({ id: apiId, updater: () => meta({ id: apiId, overrides: { endpoint: { type: 'openai', url: 'https://example.invalid' }, modelId: sourceModelId } }) });
    await storage.updateChatMeta({ id: chatId, updater: () => meta({ id: chatId, overrides: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId } }) });
    await storage.updateChatMeta({ id: chatId, updater: ({ current }) => ({ ...current!, modelId: '~user/Other/Model' }) });
    await storage.updateSettings({ updater: ({ current }) => ({ ...current!, endpoint: { type: 'transformers_js' } }) });
    await storage.promoteLocalModelReferences(proof());
    expect((await storage.loadSettings())?.defaultModelId).toBe(sourceModelId);
    expect((await storage.loadChatMeta({ id: apiId }))?.modelId).toBe(sourceModelId);
    expect((await storage.loadChatMeta({ id: chatId }))?.modelId).toBe('~user/Other/Model');
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId } })).toBe(true);
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'transformers_js' }, modelId: sourceModelId }, right: { endpoint: { type: 'transformers_js' }, modelId } })).toBe(false);
    expect(sameLocalModelBinding({ left: { modelId: sourceModelId }, right: { modelId } })).toBe(false);
  });

  it('uses a completed copy when selection commits after the background copy, without external notification delivery', async () => {
    const storage = await service();
    await storage.updateSettings({ updater: ({ current }) => ({ ...current!, defaultModelId: 'other' }) });
    await storage.promoteLocalModelReferences(proof());
    await storage.updateSettings({ updater: ({ current }) => ({ ...current!, defaultModelId: sourceModelId }) });
    await vi.waitFor(async () => {
      expect((await storage.loadSettings())?.defaultModelId).toBe(modelId);
    });
  });

  it('promotes an owner first accessed after copying without scanning unrelated chats', async () => {
    const storage = await service();
    const hidden = toChatId({ raw: 'not-yet-accessed' });
    // Use the provider method shared by this service to represent an existing
    // record not selected or accessed while the copy was running.
    const stored = meta({ id: hidden, overrides: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId } });
    const load = vi.spyOn(MemoryStorageProvider.prototype, 'loadChatMeta').mockImplementation(async ({ id }) => id === hidden ? stored : null);
    await storage.promoteLocalModelReferences(proof());
    expect(load).not.toHaveBeenCalled();
    const save = vi.spyOn(MemoryStorageProvider.prototype, 'saveChatMeta').mockImplementation(async ({ meta: updated }) => {
      Object.assign(stored, updated);
    });
    await storage.loadChatMeta({ id: hidden });
    await vi.waitFor(() => expect(stored.modelId).toBe(modelId));
    expect(save).toHaveBeenCalledExactlyOnceWith({ meta: expect.objectContaining({ id: hidden, modelId }) });
  });

  it('keeps a sibling copy identity valid when another quantization is removed', async () => {
    const storage = await service();
    const copy = proof();
    const siblingSource = '~user/Repo/Model-Q8';
    const siblingSaved = 'user/Repo-2/Model-Q8';
    let removed = false;
    await storage.promoteLocalModelReferences({ ...copy, mappings: [...copy.mappings, { sourceModelId: siblingSource, modelId: siblingSaved }], isModelCurrent: ({ modelId: candidate }) => candidate !== modelId || !removed, isIdentityCurrent: ({ modelId: candidate }) => candidate !== modelId || !removed });
    removed = true;
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: siblingSource }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId: siblingSaved } })).toBe(true);
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId } })).toBe(false);
  });

  it('reconfirms a committed settings write after a lost acknowledgement so live values can catch up on retry', async () => {
    const storage = await service();
    const original = MemoryStorageProvider.prototype.saveSettings;
    const write = vi.spyOn(MemoryStorageProvider.prototype, 'saveSettings').mockImplementationOnce(async function(this: MemoryStorageProvider, { settings }) {
      await original.call(this, { settings });
      throw new Error('Acknowledgement lost');
    });
    const reflected = vi.fn();
    using _subscription = { [Symbol.dispose]: storage.subscribeLocalModelPromotions({ listener: reflected }) };
    await expect(storage.promoteLocalModelReferences(proof())).rejects.toThrow('Acknowledgement lost');
    expect((await storage.loadSettings())?.defaultModelId).toBe(modelId);
    expect(reflected).not.toHaveBeenCalled();
    await storage.promoteLocalModelReferences(proof());
    expect(write).toHaveBeenCalledOnce();
    expect(reflected).toHaveBeenCalledWith({ promotion: expect.objectContaining({ owner: { kind: 'global' }, changes: [{ slot: 'model', sourceModelId, modelId }] }) });
  });

  it('allows the accepted stream to persist after its same captured source receives a saved name', async () => {
    const storage = await service();
    await storage.updateChatMeta({ id: chatId, updater: () => meta({ id: chatId, overrides: { endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId } }) });
    const content: ChatContent = { root: { items: [] } };
    await storage.updateChatContent({ id: chatId, write: storage.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => content });
    const write = storage.createChatContentWrite({ id: chatId, content, binding: { groupId: undefined, endpoint: { type: 'llama_cpp_browser' }, modelId: sourceModelId, endpointSource: 'chat', modelSource: 'chat' } });
    await storage.promoteLocalModelReferences(proof());
    await expect(storage.updateChatContent({ id: chatId, write, updater: () => ({ root: { items: [{ id: toMessageId({ raw: 'streamed' }), role: 'assistant', createdAt: 4, modelId: sourceModelId, lmParameters: undefined, interruption: undefined, parts: [{ type: 'text', text: 'Streaming continued', completeness: 'complete' }], replies: { items: [] } }] } }) })).resolves.toMatchObject({ root: { items: [{ modelId: sourceModelId }] } });
  });
});
