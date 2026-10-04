import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageProvider } from './memory-storage';
import { prepareModelLaunchChat, readModelLaunch, restoreModelLaunch, TEST_ONLY, detachRemovedModelLaunchOwners, type ModelLaunchChatRequest } from './model-launch';
import { toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { huggingFaceModelId } from '@/01-models/llama-cpp-browser-model-launch';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { hierarchyToDomain } from '@/00-storage/mapper/mappers';
function request({ suffix, quant }: { suffix: string, quant: string }): ModelLaunchChatRequest {
  const repository = 'owner/Model-GGUF'; const mainFilePath = `Model-${quant}.gguf`;
  return {
    chatId: toChatId({ raw: `chat-${suffix}` }), newChatGroupId: toChatGroupId({ raw: `cg-${suffix}` }), chatGroupName: `Model · ${quant}`,
    input: `hf.co/${repository}`, requestedVariant: undefined,
    target: { selection: { repository, revision: 'a'.repeat(40), files: [{ path: mainFilePath, size: 256 }] }, mainFilePath, modelId: huggingFaceModelId({ repository, modelPath: mainFilePath }) },
    titleGeneration: { endpoint: { type: 'openai', url: 'https://external.example' }, model: { id: 'external' }, lmParameters: { ...EMPTY_LM_PARAMETERS } },
    mode: 'create-or-resume', expectedTarget: undefined,
  };
}
describe('recoverable model launch persistence', () => {
  it('restores a fully saved chat after losing all session state without DTO additions', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'reload', quant: 'Q4_K_M' });
    const first = await prepareModelLaunchChat({ provider, request: req });
    TEST_ONLY.resetSession({ provider });
    expect(readModelLaunch({ provider, chatId: req.chatId })).toBeUndefined();
    const second = await prepareModelLaunchChat({ provider, request: req });
    expect(second.id).toBe(first.id); expect(second.groupId).toBe(first.groupId);
    expect(second).not.toHaveProperty('modelLaunch');
    expect((await provider.loadHierarchy())?.items).toHaveLength(1);
  });
  it('refuses history hydration after a deliberate hierarchy deletion', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'deleted', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    TEST_ONLY.resetSession({ provider }); await provider.saveHierarchy({ hierarchy: { items: [] } });
    expect(await restoreModelLaunch({ provider, chatId: req.chatId, input: req.input, requestedVariant: req.requestedVariant, target: req.target })).toBeUndefined();
    expect((await provider.loadHierarchy())?.items).toEqual([]);
  });
  it('creates a real empty chat and a locally scoped chat group including title generation', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'one', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    expect(chat.root.items).toEqual([]); expect(chat.endpoint).toBeUndefined(); expect(chat.modelId).toBeUndefined();
    expect(readModelLaunch({ provider, chatId: chat.id })?.phase).toBe('active');
    expect(await provider.loadChatGroup({ id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId })).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, modelId: req.target.modelId, titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS } });
  });
  it('uses thinking off for a fresh user without inheriting normal chat parameters', async () => {
    const provider = new MemoryStorageProvider();
    const req = { ...request({ suffix: 'fresh', quant: 'Q4_K_M' }), titleGeneration: DEFAULT_SETTINGS.titleGeneration };
    const chat = await prepareModelLaunchChat({ provider, request: req });
    expect(await provider.loadChatGroup({ id: chat.groupId! })).toMatchObject({
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { reasoning: { effort: 'none' } } },
    });
  });
  it.each([undefined, 'high'] as const)('does not rewrite a reused group with saved reasoning %s', async effort => {
    const provider = new MemoryStorageProvider();
    const first = request({ suffix: 'saved', quant: 'Q4_K_M' });
    first.titleGeneration = { endpoint: 'same_scope', model: 'same_scope', lmParameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort } } };
    const chat = await prepareModelLaunchChat({ provider, request: first });
    const before = await provider.loadChatGroup({ id: chat.groupId! });
    await prepareModelLaunchChat({ provider, request: { ...request({ suffix: 'next', quant: 'Q4_K_M' }), titleGeneration: DEFAULT_SETTINGS.titleGeneration } });
    const after = await provider.loadChatGroup({ id: chat.groupId! });
    expect(after?.titleGeneration).toEqual(before?.titleGeneration);
    expect(after?.items).toHaveLength(2);
  });
  it('preserves disabled title generation', async () => {
    const provider = new MemoryStorageProvider(); const req = { ...request({ suffix: 'one', quant: 'Q4_K_M' }), titleGeneration: 'disabled' as const };
    await prepareModelLaunchChat({ provider, request: req }); expect((await provider.loadChatGroup({ id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId }))?.titleGeneration).toBe('disabled');
  });
  it('reuses the chat group, but creates one chat per explicit visit', async () => {
    const provider = new MemoryStorageProvider();
    const first = request({ suffix: 'first', quant: 'Q4_K_M' }); const next = request({ suffix: 'second', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: first });
    const chat = await prepareModelLaunchChat({ provider, request: next });
    expect(chat.groupId).toBe((await provider.loadChat({ id: first.chatId }))?.groupId);
    expect(await provider.loadChatGroup({ id: next.newChatGroupId })).toBeNull();
    const raw = await provider.loadHierarchy(); expect(raw?.items).toHaveLength(1);
  });
  it.each([1,2,3,4])('recovers after durable write %i without creating a second chat or chat group', async stop => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: `stop${stop}`, quant: 'Q4_K_M' });
    let writes = 0;
    const spies = (['saveChatMeta','saveChatGroup','saveChatContent','saveHierarchy'] as const).map(name => {
      // Separate typed wrappers keep each storage contract intact.
      switch (name) {
      case 'saveChatMeta': { const original = provider.saveChatMeta.bind(provider); return vi.spyOn(provider, name).mockImplementation(async args => {
        await original(args); if (++writes === stop) throw new Error('power loss');
      }); }
      case 'saveChatGroup': { const original = provider.saveChatGroup.bind(provider); return vi.spyOn(provider, name).mockImplementation(async args => {
        await original(args); if (++writes === stop) throw new Error('power loss');
      }); }
      case 'saveChatContent': { const original = provider.saveChatContent.bind(provider); return vi.spyOn(provider, name).mockImplementation(async args => {
        await original(args); if (++writes === stop) throw new Error('power loss');
      }); }
      case 'saveHierarchy': { const original = provider.saveHierarchy.bind(provider); return vi.spyOn(provider, name).mockImplementation(async args => {
        await original(args); if (++writes === stop) throw new Error('power loss');
      }); }
      default: { const exhaustive: never = name; throw new Error(String(exhaustive)); }
      }
    });
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow('power loss');
    for (const spy of spies) spy.mockRestore();
    const recovered = await prepareModelLaunchChat({ provider, request: req });
    const twice = await prepareModelLaunchChat({ provider, request: req });
    expect(recovered.id).toBe(req.chatId); expect(twice.id).toBe(req.chatId);
    const raw = await provider.loadHierarchy(); expect(raw).not.toBeNull();
    const tree = hierarchyToDomain({ dto: raw! }); expect(tree.items).toHaveLength(1);
    expect(tree.items[0]).toMatchObject({ type: 'chat_group', id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId, chat_ids: [req.chatId] });
  });
  it('keeps a reserved source plan even if refreshed metadata changes', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'old', quant: 'Q4_K_M' });
    const save = provider.saveChatMeta.bind(provider);
    const spy = vi.spyOn(provider,'saveChatMeta').mockImplementationOnce(async args => {
      await save(args); throw new Error('stop');
    });
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow(); spy.mockRestore();
    const changed = { ...req, target: { ...req.target, selection: { ...req.target.selection, revision: 'b'.repeat(40) } } };
    const restored = await prepareModelLaunchChat({ provider, request: changed });
    expect(readModelLaunch({ provider, chatId: restored.id })?.target.selection.revision).toBe('a'.repeat(40));
  });
  it('never changes a chat group shared by earlier chats when adopting another quantization', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'first', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    const originalChatGroupId = readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId;
    const different = request({ suffix: 'second', quant: 'Q8_0' });
    const retarget = { ...different, chatId: req.chatId, mode: 'retarget' as const, expectedTarget: req.target };
    const chat = await prepareModelLaunchChat({ provider, request: retarget });
    expect(readModelLaunch({ provider, chatId: chat.id })?.target.modelId).toBe(different.target.modelId);
    expect((await provider.loadChatGroup({ id: originalChatGroupId }))?.modelId).toBe(req.target.modelId);
  });
  it('refuses to adopt over a conversation or manual chat override', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'first', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    await provider.saveChatMeta({ meta: { ...chat, modelId: 'manual' } });
    const next = { ...request({ suffix: 'next', quant: 'Q8_0' }), chatId: req.chatId, mode: 'retarget' as const, expectedTarget: req.target };
    await expect(prepareModelLaunchChat({ provider, request: next })).rejects.toThrow('changed');
    await provider.saveChatMeta({ meta: chat });
    await provider.saveChatContent({ id: chat.id, content: { root: { items: [{ id: toMessageId({ raw: 'm' }), role: 'user', createdAt: 1, parts: [], replies: { items: [] }, modelId: undefined, lmParameters: undefined }] }, currentLeafId: undefined } });
    await expect(prepareModelLaunchChat({ provider, request: next })).rejects.toThrow('conversation');
  });
  it('does not undo deliberate hierarchy removal, including interrupted deletion', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'removed', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    const dto = await provider.loadHierarchy();
    await detachRemovedModelLaunchOwners({ provider, before: hierarchyToDomain({ dto: dto! }), after: { items: [] } });
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow('removed');
  });
  it('does not adopt a manually reconfigured chat group with the same name', async () => {
    const provider = new MemoryStorageProvider(); const req = request({ suffix: 'first', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req }); const cg = await provider.loadChatGroup({ id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId });
    await provider.saveChatGroup({ chatGroup: { ...cg!, endpoint: { type: 'openai', url: 'https://external.example' } } });
    const next = request({ suffix: 'second', quant: 'Q4_K_M' }); const chat = await prepareModelLaunchChat({ provider, request: next });
    expect(chat.groupId).not.toBe(cg?.id);
  });
});
