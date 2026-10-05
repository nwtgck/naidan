import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMeta, ChatGroup } from '@/01-models/types';
import { toChatId, toChatGroupId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { assertModelLaunchReady, applicableModelLaunchTarget } from './readiness';
import type { ChatModelLaunch, ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
const installed = vi.fn();
let meta: ChatMeta | null;
let chatGroup: ChatGroup | null;
let launch: ChatModelLaunch;
const getLaunch = vi.fn();
vi.mock('../hugging-face/storage', () => ({ installedSelection: (args: unknown) => installed(args) }));
vi.mock('@/00-storage/service', () => ({ storageService: { getModelLaunch: () => getLaunch(), loadChatMeta: async () => meta, loadChatGroup: async () => chatGroup, loadSettings: async () => null } }));
const target: ModelLaunchTarget = { selection: { repository: 'owner/Model', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 256 }] }, mainFilePath: 'model.gguf', modelId: 'hf.co/owner/Model:model.gguf' };
function launchChat(): ChatMeta {
  return { id: toChatId({ raw: 'chat' }), groupId: toChatGroupId({ raw: 'cg' }), title: null, createdAt: 1, updatedAt: 1, debugEnabled: false };
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); vi.clearAllMocks(); meta = launchChat();
  launch = { version: 1, phase: 'active', input: target.selection.repository, requestedVariant: undefined, target, chatGroupId: toChatGroupId({ raw: 'cg' }) };
  getLaunch.mockImplementation(() => launch);
  chatGroup = { id: toChatGroupId({ raw: 'cg' }), name: 'Model', isCollapsed: false, items: [], updatedAt: 1, endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId };
  installed.mockResolvedValue({ id: target.modelId });
});
describe('model launch generation preflight', () => {
  it('uses current durable metadata and exact local file identity', async () => {
    expect(await assertModelLaunchReady({ chat: launchChat(), endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).toEqual(target);
    expect(installed).toHaveBeenCalledWith({ selection: target.selection });
  });
  it.each(['missing-files','wrong-file-identity','deleted-chat','changed-plan','changed-endpoint','partial-adoption','storage-error'])('fails closed for %s', async reason => {
    const chat = launchChat();
    switch (reason) {
    case 'missing-files': installed.mockResolvedValue(undefined); break;
    case 'wrong-file-identity': installed.mockResolvedValue({ id: 'user/other' }); break;
    case 'deleted-chat': meta = null; break;
    case 'changed-plan': getLaunch.mockReturnValueOnce(launch).mockReturnValue({ ...launch, target: { ...target, selection: { ...target.selection, revision: 'b'.repeat(40) } } }); break;
    case 'changed-endpoint': chatGroup = { ...chatGroup!, endpoint: { type: 'openai', url: 'https://external.example' } }; break;
    case 'partial-adoption': launch = { ...launch, phase: 'reserved' }; break;
    case 'storage-error': installed.mockRejectedValue(new Error('storage')); break;
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
    const chat = launchChat(); launch = { ...launch, phase: 'reserved' };
    await expect(assertModelLaunchReady({ chat, endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })).rejects.toThrow('not ready');
  });
});
