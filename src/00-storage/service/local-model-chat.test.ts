import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageProvider } from './memory-storage';
import { prepareLocalModelChat, type LocalModelChatRequest } from './local-model-chat';
import { idToRaw, toChatId, toChatGroupId } from '@/01-models/ids';

function request({ suffix }: { suffix: string }): LocalModelChatRequest {
  return { chatId: toChatId({ raw: `local-chat-${suffix}` }), chatGroupId: toChatGroupId({ raw: `local-cg-${suffix}` }), modelId: 'temp/actual:Q4', chatGroupName: 'Actual', titleGeneration: 'disabled' };
}

describe('local model chat operation persistence', () => {
  it.each([1, 2, 3, 4])('repairs write interruption %i with the same actual model and stable owner IDs', async stop => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: String(stop) });
    let writes = 0;
    const failAfterWrite = () => {
      if (++writes === stop) {
        throw new Error('interrupted');
      }
    };
    const saveMeta = provider.saveChatMeta.bind(provider);
    const saveGroup = provider.saveChatGroup.bind(provider);
    const saveContent = provider.saveChatContent.bind(provider);
    const saveHierarchy = provider.saveHierarchy.bind(provider);
    const spies = [
      vi.spyOn(provider, 'saveChatMeta').mockImplementation(async args => {
        await saveMeta(args);
        failAfterWrite();
      }),
      vi.spyOn(provider, 'saveChatGroup').mockImplementation(async args => {
        await saveGroup(args);
        failAfterWrite();
      }),
      vi.spyOn(provider, 'saveChatContent').mockImplementation(async args => {
        await saveContent(args);
        failAfterWrite();
      }),
      vi.spyOn(provider, 'saveHierarchy').mockImplementation(async args => {
        await saveHierarchy(args);
        failAfterWrite();
      }),
    ];
    await expect(prepareLocalModelChat({ provider, request: req })).rejects.toThrow('interrupted');
    for (const spy of spies) {
      spy.mockRestore();
    }
    const chat = await prepareLocalModelChat({ provider, request: req });
    expect(chat.id).toBe(req.chatId);
    expect(chat.groupId).toBe(req.chatGroupId);
    expect(chat.root.items).toEqual([]);
    expect((await provider.loadChatGroup({ id: req.chatGroupId }))?.modelId).toBe(req.modelId);
    expect((await provider.loadHierarchy())?.items).toEqual([{ type: 'chat_group', id: req.chatGroupId, chat_ids: [req.chatId] }]);
    expect((await prepareLocalModelChat({ provider, request: req })).id).toBe(chat.id);
  });

  it('rechecks the captured source after reads immediately before its first durable write', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'changed' });
    const save = vi.spyOn(provider, 'saveChatMeta');
    await expect(prepareLocalModelChat({
      provider,
      request: req,
      beforeWrite: () => {
        throw new Error('source changed');
      },
    })).rejects.toThrow('source changed');
    expect(save).not.toHaveBeenCalled();
    expect(await provider.loadChatMeta({ id: req.chatId })).toBeNull();
  });

  it('does not reconstruct an active owner after deletion or move', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'removed' });
    await prepareLocalModelChat({ provider, request: req });
    await provider.saveHierarchy({ hierarchy: { items: [] } });
    await expect(prepareLocalModelChat({ provider, request: req })).rejects.toThrow('removed');
    expect((await provider.loadHierarchy())?.items).toEqual([]);
    await provider.deleteChat({ id: req.chatId });
    await expect(prepareLocalModelChat({ provider, request: req })).rejects.toThrow('removed');
    expect(await provider.loadChatMeta({ id: req.chatId })).toBeNull();
  });

  it.each(['missing-group', 'group-endpoint', 'group-model', 'missing-hierarchy', 'missing-chat', 'moved-chat', 'chat-endpoint', 'chat-model', 'membership'] as const)('rejects changed active owner: %s', async change => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: change });
    await prepareLocalModelChat({ provider, request: req });
    const meta = (await provider.loadChatMeta({ id: req.chatId }))!;
    const chatGroup = (await provider.loadChatGroup({ id: req.chatGroupId }))!;
    switch (change) {
    case 'missing-group': await provider.deleteChatGroup({ id: req.chatGroupId });
      break;
    case 'group-endpoint': await provider.saveChatGroup({ chatGroup: { ...chatGroup, endpoint: { type: 'openai', url: 'https://example.invalid' } } });
      break;
    case 'group-model': await provider.saveChatGroup({ chatGroup: { ...chatGroup, modelId: 'user/different' } });
      break;
    case 'missing-hierarchy': await provider.saveHierarchy({ hierarchy: { items: [] } });
      break;
    case 'missing-chat': await provider.deleteChat({ id: req.chatId });
      break;
    case 'moved-chat': await provider.saveHierarchy({ hierarchy: { items: [{ type: 'chat', id: idToRaw({ id: req.chatId }) }] } });
      break;
    case 'chat-endpoint': await provider.saveChatMeta({ meta: { ...meta, endpoint: { type: 'llama_cpp_browser' } } });
      break;
    case 'chat-model': await provider.saveChatMeta({ meta: { ...meta, modelId: req.modelId } });
      break;
    case 'membership': await provider.saveHierarchy({ hierarchy: { items: [{ type: 'chat_group', id: 'other-group', chat_ids: [idToRaw({ id: req.chatId })] }] } });
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    const saveMeta = vi.spyOn(provider, 'saveChatMeta');
    await expect(prepareLocalModelChat({ provider, request: req })).rejects.toThrow('changed');
    expect(saveMeta).not.toHaveBeenCalled();
  });

  it('refuses unowned pre-existing chat and group ID collisions', async () => {
    const provider = new MemoryStorageProvider();
    const req = request({ suffix: 'collision' });
    await provider.saveChatGroup({ chatGroup: { id: req.chatGroupId, name: req.chatGroupName, updatedAt: 1, isCollapsed: false, items: [], endpoint: { type: 'llama_cpp_browser' }, modelId: req.modelId } });
    await expect(prepareLocalModelChat({ provider, request: req })).rejects.toThrow('already in use');
    expect(await provider.loadChatMeta({ id: req.chatId })).toBeNull();
  });

  it('captures proxy-backed title preferences as the scoped settings actually saved', async () => {
    const provider = new MemoryStorageProvider();
    const req = { ...request({ suffix: 'proxy-preferences' }), titleGeneration: new Proxy({ endpoint: 'same_scope' as const, model: 'same_scope' as const, lmParameters: 'same_scope' as const }, {}) };
    const first = await prepareLocalModelChat({ provider, request: req });
    expect((await provider.loadChatGroup({ id: first.groupId! }))?.titleGeneration).toEqual({ endpoint: 'same_scope', model: 'same_scope', lmParameters: 'same_scope' });
    expect((await prepareLocalModelChat({ provider, request: req })).id).toBe(first.id);
  });
});
