import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageService } from './index';
import type { ModelLaunchChatRequest } from './model-launch';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { huggingFaceModelId } from '@/01-models/llama-cpp-browser-model-launch';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';
import { LOCK_METADATA, SYNC_LOCK_KEY, LOCK_CHAT_CONTENT_PREFIX } from '@/constants';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Storage tests do not exercise application string loading.
vi.mock('@/strings', () => ({ ensureStrings: new Proxy({}, { get: () => async () => 'test storage error' }) }));
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Replace application notifications only; storage and lock implementations are real.
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));

const originalLocks = navigator.locks;
const lockCalls: string[] = [];
function simulatedWebLocks() {
  const lanes = new Map<string, Promise<void>>();
  return {
    request: async (name: string, callback: () => Promise<unknown>) => {
    lockCalls.push(name);
    const previous = lanes.get(name) ?? Promise.resolve();
    const release = Promise.withResolvers<void>();
    const tail = previous.then(() => release.promise); lanes.set(name, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release.resolve(); if (lanes.get(name) === tail) lanes.delete(name);
    }
  },
  };
}
function request({ suffix }: { suffix: string }): ModelLaunchChatRequest {
  const repository = 'owner/Model-GGUF'; const mainFilePath = 'Model-Q4_K_M.gguf';
  return {
    chatId: toChatId({ raw: `chat-${suffix}` }),
    newChatGroupId: toChatGroupId({ raw: `cg-${suffix}` }),
    chatGroupName: 'Model · Q4_K_M',
    input: `hf.co/${repository}:Q4_K_M`,
    requestedVariant: 'Q4_K_M',
    target: { selection: { repository, revision: 'a'.repeat(40), files: [{ path: mainFilePath, size: 256 }] }, mainFilePath, modelId: huggingFaceModelId({ repository, modelPath: mainFilePath }) },
    titleGeneration: 'disabled',
    mode: 'create-or-resume',
    expectedTarget: undefined,
  };
}
beforeEach(() => {
  localStorage.clear(); lockCalls.length = 0; Object.defineProperty(navigator, 'locks', { configurable: true, value: simulatedWebLocks() });
});
afterEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks }); vi.restoreAllMocks();
});
describe('model launch storage service integration', () => {
  it('uses the same metadata then sync lock order as existing nested storage operations', async () => {
    const service = new StorageService(); await service.init({ type: 'local' }); lockCalls.length = 0;
    const req = request({ suffix: 'order' }); await service.prepareModelLaunchChat({ request: req, signal: new AbortController().signal });
    expect(lockCalls).toEqual([LOCK_METADATA, SYNC_LOCK_KEY, `${LOCK_CHAT_CONTENT_PREFIX}${idToRaw({ id: req.chatId })}`]);
  });
  it('serializes two storage service instances sharing local storage into one chat group', async () => {
    const first = new StorageService(); const second = new StorageService();
    await first.init({ type: 'local' }); await second.init({ type: 'local' });
    const a = request({ suffix: 'one' }); const b = request({ suffix: 'two' });
    await Promise.all([
      first.prepareModelLaunchChat({ request: a, signal: new AbortController().signal }).then(() => {}),
      second.prepareModelLaunchChat({ request: b, signal: new AbortController().signal }).then(() => {}),
    ]);
    const firstChat = await first.loadChat({ id: a.chatId }); const secondChat = await second.loadChat({ id: b.chatId });
    expect(firstChat?.groupId).toBeDefined();
    expect(secondChat?.groupId).toBe(firstChat?.groupId);
    expect(firstChat).not.toHaveProperty('modelLaunch');
    expect((await first.loadHierarchy()).items).toHaveLength(1);
    expect(await first.loadChatGroup({ id: b.newChatGroupId })).toBeNull();
  });
  it('serializes memory launches without Web Locks, including duplicate requests', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const service = new StorageService(); await service.init({ type: 'memory' }); const req = request({ suffix: 'memory' });
    await Promise.all([1, 2, 3].map(async () => {
      await service.prepareModelLaunchChat({ request: req, signal: new AbortController().signal });
    }));
    expect((await service.loadHierarchy()).items).toEqual([{ type: 'chat_group', id: (await service.loadChat({ id: req.chatId }))!.groupId, chat_ids: [req.chatId] }]);
  });
  it('fails closed for persistent launch without cross-tab locking', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const service = new StorageService(); await service.init({ type: 'local' }); const req = request({ suffix: 'unsupported' });
    await expect(service.prepareModelLaunchChat({ request: req, signal: new AbortController().signal })).rejects.toThrow('locking');
    expect(await service.loadChatMeta({ id: req.chatId })).toBeNull();
  });
  it('does not create anything when cancellation precedes the first write', async () => {
    const service = new StorageService(); await service.init({ type: 'memory' }); const req = request({ suffix: 'cancelled' });
    const controller = new AbortController(); controller.abort();
    await expect(service.prepareModelLaunchChat({ request: req, signal: controller.signal })).rejects.toThrow();
    expect(await service.loadChatMeta({ id: req.chatId })).toBeNull(); expect((await service.loadHierarchy()).items).toEqual([]);
  });
  it('keeps the existing settings DTO shape across change and revert', async () => {
    const service = new StorageService(); await service.init({ type: 'local' });
    const blank: Settings = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: '' }, storageType: 'local', defaultModelId: undefined };
    await service.updateSettings({ updater: () => blank });
    await service.updateSettings({ updater: ({ current }) => ({ ...current!, endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'model' }) });
    expect((await service.loadSettings())?.defaultModelId).toBe('model');
    await service.updateSettings({ updater: () => blank });
    expect(await service.loadSettings()).not.toHaveProperty('globalDefaultsRevision');
    await service.updateSettings({ updater: ({ current }) => ({ ...current!, systemPrompt: 'unrelated' }) });
    expect(await service.loadSettings()).not.toHaveProperty('globalDefaultsRevision');
  });
  it('invalidates the storage capability after a provider replacement', async () => {
    const service = new StorageService(); await service.init({ type: 'memory' }); const isCurrent = service.captureModelLaunchStorage();
    expect(isCurrent()).toBe(true); await service.init({ type: 'local' }); expect(isCurrent()).toBe(false);
  });
});
export const TEST_ONLY = {
};
