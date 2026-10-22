import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageProvider } from './memory-storage';
import { prepareModelLaunchChat, readModelLaunch, observeModelLaunch, promoteModelLaunchBinding, TEST_ONLY, detachModelLaunchOwner, detachModelLaunchChatGroupOwners, detachRemovedModelLaunchOwners, type ModelLaunchChatRequest } from './model-launch';
import { toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { chatToDto, hierarchyToDomain } from '@/00-storage/mapper/mappers';

function request({ suffix, quant }: { suffix: string, quant: string }): ModelLaunchChatRequest {
  const repository = 'owner/Model-GGUF';
  const mainFilePath = `Model-${quant}.gguf`;
  return {
    chatId: toChatId({ raw: `chat-${suffix}` }),
    newChatGroupId: toChatGroupId({ raw: `cg-${suffix}` }),
    chatGroupName: `Model · ${quant}`,
    input: `hf.co/${repository}`,
    requestedVariant: undefined,
    target: { selection: { repository, revision: 'a'.repeat(40), files: [{ path: mainFilePath, size: 256 }] }, mainFilePath, modelId: formatHuggingFaceModelId({ repository, mainFilePath }) },
    titleGeneration: { endpoint: { type: 'openai', url: 'https://external.example' }, model: { id: 'external' }, lmParameters: { ...EMPTY_LM_PARAMETERS } },
    destination: { kind: 'opfs' },
    effectiveModelId: formatHuggingFaceModelId({ repository, mainFilePath }),
    mode: 'create',
    expectedTarget: undefined,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('page-owned model launch persistence', () => {
  it('keeps the ordinary chat but never restores launch authority after losing session state', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'reload', quant: 'Q4_K_M' });
    const first = await prepareModelLaunchChat({ provider, request: req });
    TEST_ONLY.resetSession({ provider });
    expect(readModelLaunch({ provider, chatId: req.chatId })).toBeUndefined();
    const writes = [vi.spyOn(provider, 'saveChatGroup'), vi.spyOn(provider, 'saveChatMeta'), vi.spyOn(provider, 'saveHierarchy'), vi.spyOn(provider, 'saveChatContent')];
    await expect(prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } })).rejects.toThrow('receipt');
    const second = await provider.loadChat({ id: req.chatId });
    expect(second).not.toBeNull();
    expect(second?.id).toBe(first.id);
    expect(second?.groupId).toBe(first.groupId);
    expect(chatToDto({ domain: second! })).not.toHaveProperty('modelLaunch');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
    expect((await provider.loadHierarchy())?.items).toHaveLength(1);
  });

  it('refuses history hydration after a deliberate hierarchy deletion', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'deleted', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    TEST_ONLY.resetSession({ provider });
    await provider.saveHierarchy({ hierarchy: { items: [] } });
    await expect(prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } })).rejects.toThrow('receipt');
    expect((await provider.loadHierarchy())?.items).toEqual([]);
  });

  it('creates a real empty chat and a locally scoped chat group including title generation', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'one', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    expect(chat.root.items).toEqual([]);
    expect(chat.endpoint).toBeUndefined();
    expect(chat.modelId).toBeUndefined();
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
    const provider = new MemoryStorageProvider();
    const req = { ...request({ suffix: 'one', quant: 'Q4_K_M' }), titleGeneration: 'disabled' as const };
    await prepareModelLaunchChat({ provider, request: req });
    expect((await provider.loadChatGroup({ id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId }))?.titleGeneration).toBe('disabled');
  });

  it('reuses the chat group, but creates one chat per explicit visit', async () => {
    const provider = new MemoryStorageProvider();
    const first = request({ suffix: 'first', quant: 'Q4_K_M' });
    const next = request({ suffix: 'second', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: first });
    const chat = await prepareModelLaunchChat({ provider, request: next });
    expect(chat.groupId).toBe((await provider.loadChat({ id: first.chatId }))?.groupId);
    expect(await provider.loadChatGroup({ id: next.newChatGroupId })).toBeNull();
    const raw = await provider.loadHierarchy();
    expect(raw?.items).toHaveLength(1);
  });

  it.each([1, 2, 3, 4].flatMap(stop => (['current', 'lost'] as const).map(session => ({ stop, session }))))('handles rejected write $stop with a $session page session', async ({ stop, session }) => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: `stop${stop}`, quant: 'Q4_K_M' });
    let writes = 0;
    const spies = (['saveChatMeta', 'saveChatGroup', 'saveChatContent', 'saveHierarchy'] as const).map(name => {
      // Separate typed wrappers keep each storage contract intact.
      switch (name) {
      case 'saveChatMeta': {
        const original = provider.saveChatMeta.bind(provider);
        return vi.spyOn(provider, name).mockImplementation(async args => {
          await original(args);
          if (++writes === stop) {
            throw new Error('power loss');
          }
        });
      }
      case 'saveChatGroup': {
        const original = provider.saveChatGroup.bind(provider);
        return vi.spyOn(provider, name).mockImplementation(async args => {
          await original(args);
          if (++writes === stop) {
            throw new Error('power loss');
          }
        });
      }
      case 'saveChatContent': {
        const original = provider.saveChatContent.bind(provider);
        return vi.spyOn(provider, name).mockImplementation(async args => {
          await original(args);
          if (++writes === stop) {
            throw new Error('power loss');
          }
        });
      }
      case 'saveHierarchy': {
        const original = provider.saveHierarchy.bind(provider);
        return vi.spyOn(provider, name).mockImplementation(async args => {
          await original(args);
          if (++writes === stop) {
            throw new Error('power loss');
          }
        });
      }
      default: {
        const exhaustive: never = name;
        throw new Error(String(exhaustive));
      }
      }
    });
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow('power loss');
    for (const spy of spies) {
      spy.mockRestore();
    }
    switch (session) {
    case 'lost': {
      TEST_ONLY.resetSession({ provider });
      const writesAfterReload = [vi.spyOn(provider, 'saveChatGroup'), vi.spyOn(provider, 'saveChatMeta'), vi.spyOn(provider, 'saveHierarchy'), vi.spyOn(provider, 'saveChatContent')];
      await expect(prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } })).rejects.toThrow('receipt');
      for (const write of writesAfterReload) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(readModelLaunch({ provider, chatId: req.chatId })).toBeUndefined();
      return;
    }
    case 'current': break;
    default: {
      const exhaustive: never = session;
      throw new Error(String(exhaustive));
    }
    }
    expect(readModelLaunch({ provider, chatId: req.chatId })).toMatchObject({ phase: 'reserved', target: req.target });
    const recovered = await prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } });
    const twice = await prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } });
    expect(recovered.id).toBe(req.chatId);
    expect(twice.id).toBe(req.chatId);
    const raw = await provider.loadHierarchy();
    expect(raw).not.toBeNull();
    const tree = hierarchyToDomain({ dto: raw! });
    expect(tree.items).toHaveLength(1);
    expect(tree.items[0]).toMatchObject({ type: 'chat_group', id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId, chat_ids: [req.chatId] });
  });

  it('keeps a reserved source plan even if refreshed metadata changes', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'old', quant: 'Q4_K_M' });
    const save = provider.saveChatMeta.bind(provider);
    const spy = vi.spyOn(provider, 'saveChatMeta').mockImplementationOnce(async args => {
      await save(args);
      throw new Error('stop');
    });
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow();
    spy.mockRestore();
    const changed = { ...req, mode: 'resume' as const, target: { ...req.target, selection: { ...req.target.selection, revision: 'b'.repeat(40) } } };
    const restored = await prepareModelLaunchChat({ provider, request: changed });
    expect(readModelLaunch({ provider, chatId: restored.id })?.target.selection.revision).toBe('a'.repeat(40));
  });

  it('never changes a chat group shared by earlier chats when adopting another quantization', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'first', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    const peer = request({ suffix: 'peer', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: peer });
    const originalChatGroupId = readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId;
    const different = request({ suffix: 'second', quant: 'Q8_0' });
    const retarget = { ...different, chatId: req.chatId, mode: 'retarget' as const, expectedTarget: req.target };
    const chat = await prepareModelLaunchChat({ provider, request: retarget });
    expect(readModelLaunch({ provider, chatId: chat.id })?.target.modelId).toBe(different.target.modelId);
    expect((await provider.loadChatGroup({ id: originalChatGroupId }))?.modelId).toBe(req.target.modelId);
    expect((await provider.loadChatGroup({ id: originalChatGroupId }))?.items).toMatchObject([{ type: 'chat', chat: { id: peer.chatId } }]);
  });

  it('confirms a reserved retarget in the same session without changing its shared source group', async () => {
    const provider = new MemoryStorageProvider();
    const first = request({ suffix: 'retarget-owner', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: first });
    const next = { ...request({ suffix: 'retarget-next', quant: 'Q8_0' }), chatId: first.chatId, mode: 'retarget' as const, expectedTarget: first.target };
    const originalSave = provider.saveHierarchy.bind(provider);
    const interrupted = vi.spyOn(provider, 'saveHierarchy').mockImplementationOnce(async args => {
      await originalSave(args);
      throw new Error('interrupted reserved retarget');
    });
    await expect(prepareModelLaunchChat({ provider, request: next })).rejects.toThrow('interrupted reserved retarget');
    interrupted.mockRestore();
    const resumed = await prepareModelLaunchChat({ provider, request: { ...next, mode: 'resume' } });
    expect(readModelLaunch({ provider, chatId: resumed.id })).toMatchObject({ phase: 'active', effectiveModelId: next.effectiveModelId, target: next.target });
    expect((await provider.loadChatGroup({ id: resumed.groupId! }))?.modelId).toBe(next.effectiveModelId);
  });

  it('pins the actual host destination and strips unrelated external title endpoint credentials from its receipt', async () => {
    const provider = new MemoryStorageProvider();
    const req = { ...request({ suffix: 'host-receipt', quant: 'Q4_K_M' }), destination: { kind: 'host' as const, directoryId: 'selected-root' }, effectiveModelId: 'host/SelectedRoot/owner/Model-GGUF:Q4_K_M' };
    const chat = await prepareModelLaunchChat({ provider, request: req });
    expect(readModelLaunch({ provider, chatId: chat.id })).toMatchObject({ destination: req.destination, effectiveModelId: req.effectiveModelId, titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
    expect(JSON.stringify(readModelLaunch({ provider, chatId: chat.id }))).not.toContain('external.example');
    const resumed = await prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume', destination: { kind: 'opfs' }, effectiveModelId: req.target.modelId } });
    expect(readModelLaunch({ provider, chatId: resumed.id })?.destination).toEqual(req.destination);
    expect((await provider.loadChatGroup({ id: resumed.groupId! }))?.modelId).toBe(req.effectiveModelId);
  });

  it('keeps equal host model labels in distinct directory registrations in separate chat groups', async () => {
    const provider = new MemoryStorageProvider();
    const effectiveModelId = 'host/SelectedRoot/owner/Model-GGUF:Q4_K_M';
    const first = await prepareModelLaunchChat({ provider, request: { ...request({ suffix: 'first-host-root', quant: 'Q4_K_M' }), destination: { kind: 'host', directoryId: 'first-registration' }, effectiveModelId } });
    const second = await prepareModelLaunchChat({ provider, request: { ...request({ suffix: 'second-host-root', quant: 'Q4_K_M' }), destination: { kind: 'host', directoryId: 'second-registration' }, effectiveModelId } });
    expect(second.groupId).not.toBe(first.groupId);
  });

  it('accepts a proxy-backed destination and returns isolated memory receipt copies', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'proxy', quant: 'Q4_K_M' });
    req.destination = new Proxy({ kind: 'host' as const, directoryId: 'captured-root' }, {});
    const chat = await prepareModelLaunchChat({ provider, request: req });
    const receipt = readModelLaunch({ provider, chatId: chat.id })!;
    expect(receipt.destination).toEqual({ kind: 'host', directoryId: 'captured-root' });
    receipt.target.selection.revision = 'b'.repeat(40);
    receipt.phase = 'detached';
    expect(readModelLaunch({ provider, chatId: chat.id })).toMatchObject({ phase: 'active', target: req.target });
    expect(chatToDto({ domain: chat })).not.toHaveProperty('modelLaunch');
  });

  it('checks authorization after a delayed read before detaching a changed receipt', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'detach-guard', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    await provider.saveChatMeta({ meta: { ...chat, endpoint: { type: 'llama_cpp_browser' } } });
    const save = vi.spyOn(provider, 'saveChatMeta');
    const read = provider.loadChatMeta.bind(provider);
    const pending = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(provider, 'loadChatMeta').mockImplementationOnce(async args => {
      const meta = await read(args);
      started.resolve();
      await pending.promise;
      return meta;
    });
    let current = true;
    const operation = prepareModelLaunchChat({
      provider,
      request: { ...req, mode: 'resume' },
      beforeWrite: () => {
        if (!current) {
          throw new Error('source retired');
        }
      },
    });
    await started.promise;
    current = false;
    pending.resolve();
    await expect(operation).rejects.toThrow('source retired');
    expect(save).not.toHaveBeenCalled();
    expect(readModelLaunch({ provider, chatId: req.chatId })?.phase).toBe('active');
  });

  it('refuses to adopt over a conversation or manual chat override', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'first', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    await provider.saveChatMeta({ meta: { ...chat, modelId: 'manual' } });
    const next = { ...request({ suffix: 'next', quant: 'Q8_0' }), chatId: req.chatId, mode: 'retarget' as const, expectedTarget: req.target };
    await expect(prepareModelLaunchChat({ provider, request: next })).rejects.toThrow('changed');
    const conversation = request({ suffix: 'conversation', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: conversation });
    await provider.saveChatContent({ id: conversation.chatId, content: { root: { items: [{ id: toMessageId({ raw: 'm' }), role: 'user', createdAt: 1, parts: [], replies: { items: [] }, modelId: undefined, lmParameters: undefined }] }, currentLeafId: undefined } });
    await expect(prepareModelLaunchChat({ provider, request: { ...next, chatId: conversation.chatId } })).rejects.toThrow('conversation');
  });

  it('does not undo deliberate hierarchy removal, including interrupted deletion', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'removed', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    await detachRemovedModelLaunchOwners({ provider, after: { items: [] } });
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow('removed');
  });

  it('does not adopt a manually reconfigured chat group with the same name', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'first', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    const cg = await provider.loadChatGroup({ id: readModelLaunch({ provider, chatId: req.chatId })!.chatGroupId });
    await provider.saveChatGroup({ chatGroup: { ...cg!, endpoint: { type: 'openai', url: 'https://external.example' } } });
    const next = request({ suffix: 'second', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: next });
    expect(chat.groupId).not.toBe(cg?.id);
  });

  it('writes content last so an incomplete new owner cannot resolve through global settings', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'content-last', quant: 'Q4_K_M' });
    await provider.saveSettings({ settings: { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'unrelated-global' } });
    const group = vi.spyOn(provider, 'saveChatGroup');
    const meta = vi.spyOn(provider, 'saveChatMeta');
    const hierarchy = vi.spyOn(provider, 'saveHierarchy');
    const save = provider.saveChatContent.bind(provider);
    const content = vi.spyOn(provider, 'saveChatContent').mockImplementation(async args => {
      expect(await provider.loadChat({ id: req.chatId })).toBeNull();
      const owner = await provider.loadChatMeta({ id: req.chatId });
      expect(owner?.groupId).toBeDefined();
      expect((await provider.loadChatGroup({ id: owner!.groupId! }))?.modelId).toBe(req.effectiveModelId);
      await save(args);
    });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    expect(group.mock.invocationCallOrder[0]).toBeLessThan(meta.mock.invocationCallOrder[0]!);
    expect(meta.mock.invocationCallOrder[0]).toBeLessThan(hierarchy.mock.invocationCallOrder[0]!);
    expect(hierarchy.mock.invocationCallOrder[0]).toBeLessThan(content.mock.invocationCallOrder[0]!);
    expect(chat.groupId).toBe((await provider.loadChatMeta({ id: req.chatId }))?.groupId);
  });

  it.each(['saveChatGroup', 'saveChatMeta', 'saveHierarchy', 'saveChatContent'] as const)('detaches an ambiguous %s rejection instead of recreating the missing attempted target', async method => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: method, quant: 'Q4_K_M' });
    vi.spyOn(provider, method).mockRejectedValueOnce(new Error('write outcome unknown'));
    await expect(prepareModelLaunchChat({ provider, request: req })).rejects.toThrow('unknown');
    vi.restoreAllMocks();
    const writes = [vi.spyOn(provider, 'saveChatGroup'), vi.spyOn(provider, 'saveChatMeta'), vi.spyOn(provider, 'saveHierarchy'), vi.spyOn(provider, 'saveChatContent')];
    await expect(prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } })).rejects.toThrow('changed');
    expect(readModelLaunch({ provider, chatId: req.chatId })?.phase).toBe('detached');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it.each(['chat', 'chat-group', 'membership'] as const)('never recreates an acknowledged %s that has been removed', async removed => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: removed, quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    switch (removed) {
    case 'chat': await provider.deleteChat({ id: chat.id });
      break;
    case 'chat-group': await provider.deleteChatGroup({ id: chat.groupId! });
      break;
    case 'membership': await provider.saveHierarchy({ hierarchy: { items: [] } });
      break;
    default: {
      const exhaustive: never = removed;
      throw new Error(String(exhaustive));
    }
    }
    const writes = [vi.spyOn(provider, 'saveChatGroup'), vi.spyOn(provider, 'saveChatMeta'), vi.spyOn(provider, 'saveHierarchy'), vi.spyOn(provider, 'saveChatContent')];
    await expect(prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } })).rejects.toThrow('changed');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('keeps title edits observable without treating them as launch authority or a binding change', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'observe', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    observeModelLaunch({ provider, meta: { ...chat, title: 'Edited title' } });
    expect(readModelLaunch({ provider, chatId: req.chatId })?.phase).toBe('active');
    observeModelLaunch({ provider, meta: { ...chat, modelId: 'manual' } });
    expect(readModelLaunch({ provider, chatId: req.chatId })?.phase).toBe('detached');
    TEST_ONLY.resetSession({ provider });
    observeModelLaunch({ provider, meta: chat });
    expect(readModelLaunch({ provider, chatId: req.chatId })).toBeUndefined();
  });

  it('updates a receipt only after its exact source owner actually uses the saved binding', async () => {
    const provider = new MemoryStorageProvider();
    await provider.saveSettings({ settings: { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' } } });
    const req = request({ suffix: 'promotion', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    const modelId = 'user/saved.gguf';
    await provider.saveChatMeta({ meta: { ...chat, endpoint: { type: 'llama_cpp_browser' }, modelId } });
    await promoteModelLaunchBinding({ provider, chatId: req.chatId, sourceModelId: 'other-source', modelId });
    expect(readModelLaunch({ provider, chatId: req.chatId })?.effectiveModelId).toBe(req.effectiveModelId);
    await promoteModelLaunchBinding({ provider, chatId: req.chatId, sourceModelId: req.effectiveModelId, modelId });
    observeModelLaunch({ provider, meta: (await provider.loadChatMeta({ id: req.chatId }))! });
    expect(readModelLaunch({ provider, chatId: req.chatId })).toMatchObject({ phase: 'active', effectiveModelId: modelId, target: req.target });
    expect((await prepareModelLaunchChat({ provider, request: { ...req, mode: 'resume' } })).modelId).toBe(modelId);
  });

  it('does not claim a global-only promotion changed an owner still bound to its source group', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'global-only', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: req });
    await provider.saveSettings({ settings: { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'user/global-saved' } });
    await promoteModelLaunchBinding({ provider, chatId: req.chatId, sourceModelId: req.effectiveModelId, modelId: 'user/global-saved' });
    expect(readModelLaunch({ provider, chatId: req.chatId })).toMatchObject({ phase: 'detached', effectiveModelId: req.effectiveModelId });
  });

  it('does not overwrite a newer receipt promotion after an awaited binding read', async () => {
    const provider = new MemoryStorageProvider();
    await provider.saveSettings({ settings: { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' } } });
    const req = request({ suffix: 'promotion-race', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    await provider.saveChatMeta({ meta: { ...chat, endpoint: { type: 'llama_cpp_browser' }, modelId: 'user/first' } });
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const readSettings = provider.loadSettings.bind(provider);
    vi.spyOn(provider, 'loadSettings').mockImplementationOnce(async () => {
      started.resolve();
      await pending.promise;
      return readSettings();
    });
    const first = promoteModelLaunchBinding({ provider, chatId: req.chatId, sourceModelId: req.effectiveModelId, modelId: 'user/first' });
    await started.promise;
    await provider.saveChatMeta({ meta: { ...chat, endpoint: { type: 'llama_cpp_browser' }, modelId: 'user/second' } });
    await promoteModelLaunchBinding({ provider, chatId: req.chatId, sourceModelId: req.effectiveModelId, modelId: 'user/second' });
    pending.resolve();
    await first;
    expect(readModelLaunch({ provider, chatId: req.chatId })).toMatchObject({ phase: 'active', effectiveModelId: 'user/second' });
  });

  it('refuses retargeting an owner with a promoted raw override without clearing its saved choice', async () => {
    const provider = new MemoryStorageProvider();
    await provider.saveSettings({ settings: { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' } } });
    const req = request({ suffix: 'promoted-retarget', quant: 'Q4_K_M' });
    const chat = await prepareModelLaunchChat({ provider, request: req });
    const modelId = 'user/saved';
    await provider.saveChatMeta({ meta: { ...chat, endpoint: { type: 'llama_cpp_browser' }, modelId } });
    await promoteModelLaunchBinding({ provider, chatId: req.chatId, sourceModelId: req.effectiveModelId, modelId });
    const writes = [vi.spyOn(provider, 'saveChatGroup'), vi.spyOn(provider, 'saveChatMeta'), vi.spyOn(provider, 'saveHierarchy'), vi.spyOn(provider, 'saveChatContent')];
    const next = request({ suffix: 'promoted-next', quant: 'Q8_0' });
    await expect(prepareModelLaunchChat({ provider, request: { ...next, chatId: req.chatId, mode: 'retarget', expectedTarget: req.target } })).rejects.toThrow('changed');
    for (const write of writes) {
      expect(write).not.toHaveBeenCalled();
    }
    expect((await provider.loadChat({ id: req.chatId }))?.modelId).toBe(modelId);
    expect((await provider.loadChatGroup({ id: chat.groupId! }))?.modelId).toBe(req.effectiveModelId);
    expect(readModelLaunch({ provider, chatId: req.chatId })).toMatchObject({ phase: 'active', effectiveModelId: modelId, target: req.target });
  });

  it('revokes only the selected owner before a deletion attempt without deleting ordinary chat data', async () => {
    const provider = new MemoryStorageProvider();
    const first = request({ suffix: 'owner-delete', quant: 'Q4_K_M' });
    const peer = request({ suffix: 'owner-peer', quant: 'Q4_K_M' });
    await prepareModelLaunchChat({ provider, request: first });
    await prepareModelLaunchChat({ provider, request: peer });
    detachModelLaunchOwner({ provider, chatId: first.chatId });
    expect(readModelLaunch({ provider, chatId: first.chatId })?.phase).toBe('detached');
    expect(readModelLaunch({ provider, chatId: peer.chatId })?.phase).toBe('active');
    expect(await provider.loadChat({ id: first.chatId })).not.toBeNull();
    await expect(prepareModelLaunchChat({ provider, request: { ...first, mode: 'resume' } })).rejects.toThrow('changed');
  });

  it('revokes only receipts supplied by the selected chat group', async () => {
    const provider = new MemoryStorageProvider();
    const first = request({ suffix: 'group-delete', quant: 'Q4_K_M' });
    const peer = request({ suffix: 'group-peer', quant: 'Q4_K_M' });
    const other = request({ suffix: 'group-other', quant: 'Q8_0' });
    const chat = await prepareModelLaunchChat({ provider, request: first });
    await prepareModelLaunchChat({ provider, request: peer });
    await prepareModelLaunchChat({ provider, request: other });
    detachModelLaunchChatGroupOwners({ provider, chatGroupId: chat.groupId! });
    expect(readModelLaunch({ provider, chatId: first.chatId })?.phase).toBe('detached');
    expect(readModelLaunch({ provider, chatId: peer.chatId })?.phase).toBe('detached');
    expect(readModelLaunch({ provider, chatId: other.chatId })?.phase).toBe('active');
    expect((await provider.loadChatGroup({ id: chat.groupId! }))?.items).toHaveLength(2);
  });
});
