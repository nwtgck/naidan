import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, ChatMeta, ChatGroup } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { assertModelLaunchReady, applicableModelLaunchTarget } from './readiness';
import type { ChatModelLaunch, ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { registerModelLaunchPreparation, TEST_ONLY as preparationTestOnly } from './preparation';
const installed = vi.fn();
const inspectLocal = vi.fn();
let meta: ChatMeta | null;
let chatGroup: ChatGroup | null;
let launch: ChatModelLaunch;
const getLaunch = vi.fn();
let preparationState: 'loading' | 'ready' | 'failed' = 'ready';
vi.mock('../hugging-face/storage', () => ({ installedSelection: (args: unknown) => installed(args) }));
vi.mock('../model-recovery/availability', () => ({ inspectLocalModel: (args: unknown) => inspectLocal(args) }));
vi.mock('@/features/llama-cpp-browser/composables/local-model-launch-session', () => ({ assertLocalModelLaunchReady: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { getModelLaunch: () => getLaunch(), loadChatMeta: async () => meta, loadChatGroup: async () => chatGroup, loadSettings: async () => null } }));
const target: ModelLaunchTarget = { selection: { repository: 'owner/Model', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 256 }] }, mainFilePath: 'model.gguf', modelId: 'hf.co/owner/Model:model' };

function launchChat(): Chat {
  return { id: toChatId({ raw: 'chat' }), groupId: toChatGroupId({ raw: 'cg' }), title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks();
  meta = launchChat();
  launch = {
    phase: 'active',
    input: target.selection.repository,
    requestedVariant: undefined,
    target,
    destination: { kind: 'opfs' },
    effectiveModelId: target.modelId,
    chatGroupName: 'Model',
    titleGeneration: DEFAULT_SETTINGS.titleGeneration,
    chatGroupId: toChatGroupId({ raw: 'cg' }),
  };
  getLaunch.mockImplementation(() => launch);
  chatGroup = { id: toChatGroupId({ raw: 'cg' }), name: 'Model', isCollapsed: false, items: [], updatedAt: 1, endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId };
  installed.mockResolvedValue({ modelId: target.modelId });
  inspectLocal.mockReset().mockResolvedValue('available');
  preparationState = 'ready';
  preparationTestOnly.reset();
  registerModelLaunchPreparation({
    chatId: launchChat().id,
    isReady: ({ target: selected, destination, effectiveModelId }) => preparationState === 'ready'
    && JSON.stringify(selected) === JSON.stringify(target) && destination.kind === 'opfs' && effectiveModelId === target.modelId,
  });
});

describe('model launch generation preflight', () => {
  it('uses current durable metadata and current public model selection', async () => {
    expect(await assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).toEqual({ target, effectiveModelId: target.modelId });
    expect(installed).toHaveBeenCalledWith({ selection: target.selection, destination: { kind: 'opfs' } });
  });

  it.each(['loading', 'failed'] as const)('blocks an initial message while actual preparation is %s', async status => {
    preparationState = status;
    await expect(assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).rejects.toThrow('not ready');
    expect(installed).not.toHaveBeenCalled();
  });

  it('does not use a preparation owner after its view retires', async () => {
    preparationTestOnly.reset();
    await expect(assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).rejects.toThrow('not ready');
    expect(installed).not.toHaveBeenCalled();
  });

  it('rechecks actual preparation after asynchronous file verification', async () => {
    const gate = Promise.withResolvers<{ modelId: string }>();
    installed.mockReturnValueOnce(gate.promise);
    const pending = assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId });
    const rejection = expect(pending).rejects.toThrow('not ready');
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    preparationState = 'failed';
    gate.resolve({ modelId: target.modelId });
    await rejection;
  });

  it('keeps the initial preload exemption for an existing conversation', async () => {
    preparationState = 'failed';
    const chat = launchChat();
    chat.root.items.push({
      id: toMessageId({ raw: 'existing' }),
      role: 'user',
      createdAt: 1,
      modelId: undefined,
      lmParameters: undefined,
      parts: [{ type: 'text', text: 'Existing conversation', completeness: 'complete' }],
      replies: { items: [] },
    });
    expect(await assertModelLaunchReady({ chat, endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).toEqual({ target, effectiveModelId: target.modelId });
  });

  it.each(['missing-files', 'wrong-file-identity', 'deleted-chat', 'changed-plan', 'changed-endpoint', 'partial-adoption', 'storage-error'])('fails closed for %s', async reason => {
    const chat = launchChat();
    switch (reason) {
    case 'missing-files': installed.mockResolvedValue(undefined);
      break;
    case 'wrong-file-identity': installed.mockResolvedValue({ modelId: 'user/other' });
      break;
    case 'deleted-chat': meta = null;
      break;
    case 'changed-plan': getLaunch.mockReturnValueOnce(launch).mockReturnValue({ ...launch, target: { ...target, selection: { ...target.selection, revision: 'b'.repeat(40) } } });
      break;
    case 'changed-endpoint': chatGroup = { ...chatGroup!, endpoint: { type: 'openai', url: 'https://external.example' } };
      break;
    case 'partial-adoption': launch = { ...launch, phase: 'reserved' };
      break;
    case 'storage-error': installed.mockRejectedValue(new Error('storage'));
      break;
    }
    await expect(assertModelLaunchReady({ chat, endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).rejects.toThrow('not ready');
  });

  it('does not restrict an explicit alternative endpoint or model', async () => {
    const chat = launchChat();
    expect(applicableModelLaunchTarget({ chat, endpoint: { type: 'openai', url: 'https://external.example' }, modelId: 'manual' })).toBeUndefined();
    expect(await assertModelLaunchReady({ chat, endpoint: { type: 'llama_cpp_browser' }, modelId: 'user/manual' })).toBeUndefined();
    expect(installed).not.toHaveBeenCalled();
  });

  it('blocks an incomplete reservation before any model-list fallback', async () => {
    const chat = launchChat();
    launch = { ...launch, phase: 'reserved' };
    await expect(assertModelLaunchReady({ chat, endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).rejects.toThrow('not ready');
  });

  it.each(['missing', 'unreadable', 'failed'] as const)('checks actual local files before accepting a receipt-free Chat when storage is %s', async result => {
    getLaunch.mockReturnValue(undefined);
    switch (result) {
    case 'missing': case 'unreadable': inspectLocal.mockResolvedValue(result);
      break;
    case 'failed': inspectLocal.mockRejectedValue(new Error('storage unavailable'));
      break;
    default: {
      const exhaustive: never = result;
      throw new Error(String(exhaustive));
    }
    }
    await expect(assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).rejects.toThrow('not ready');
    expect(inspectLocal).toHaveBeenCalledExactlyOnceWith({ modelId: target.modelId });
    expect(installed).not.toHaveBeenCalled();
    expect(getLaunch.mock.results.every(result => result.value === undefined)).toBe(true);
  });

  it('allows a receipt-free local binding without requiring the former Start warmup and checks fresh files every time', async () => {
    getLaunch.mockReturnValue(undefined);
    preparationTestOnly.reset();
    const fetch = vi.spyOn(globalThis, 'fetch');
    using cleanup = { [Symbol.dispose]: () => fetch.mockRestore() };
    void cleanup;
    const args = { chat: launchChat(), endpoint: { type: 'llama_cpp_browser' as const }, modelId: 'user/SavedModel' };
    expect(await assertModelLaunchReady(args)).toBeUndefined();
    expect(await assertModelLaunchReady(args)).toBeUndefined();
    expect(inspectLocal).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(installed).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('does not accept an unset receipt-free local model: %s', async modelId => {
    getLaunch.mockReturnValue(undefined);
    await expect(assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId })).rejects.toThrow('not ready');
    expect(inspectLocal).not.toHaveBeenCalled();
  });

  it('does not apply local-file inspection to a remote endpoint after the former launch receipt is gone', async () => {
    getLaunch.mockReturnValue(undefined);
    inspectLocal.mockRejectedValue(new Error('local files unavailable'));
    expect(await assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'openai', url: 'https://external.example' }, modelId: 'remote-model' })).toBeUndefined();
    expect(inspectLocal).not.toHaveBeenCalled();
  });
});
