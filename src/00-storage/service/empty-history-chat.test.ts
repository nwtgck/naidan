import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, ChatGroup } from '@/01-models/types';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { LOCK_METADATA, SYNC_LOCK_KEY } from '@/constants';
import { promiseAllKeyed } from '@/utils/promise';
import { StorageService } from './index';
import { LocalStorageProvider } from './local-storage';

// eslint-disable-next-line local-rules/enforce-dependency-directions -- Storage tests do not exercise application string loading.
vi.mock('@/strings', () => ({ ensureStrings: new Proxy({}, { get: () => async () => 'test storage error' }) }));
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Replace application notifications without replacing storage or locking.
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));

const originalLocks = navigator.locks;
const lockCalls: string[] = [];

function serializedLocks() {
  const lanes = new Map<string, Promise<void>>();
  return {
    request: async (name: string, callback: () => Promise<unknown>) => {
      lockCalls.push(name);
      const previous = lanes.get(name) ?? Promise.resolve();
      const released = Promise.withResolvers<void>();
      const tail = previous.then(() => released.promise);
      lanes.set(name, tail);
      await previous;
      using _release = {
        [Symbol.dispose]() {
          released.resolve();
          if (lanes.get(name) === tail) {
            lanes.delete(name);
          }
        },
      };
      return await callback();
    },
  };
}

async function saveChat({ service, rawId }: { service: StorageService, rawId: string }): Promise<Chat> {
  const chat: Chat = { id: toChatId({ raw: rawId }), title: rawId, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  const write = service.createChatContentWrite({ id: chat.id, content: undefined, binding: undefined });
  await service.updateChatContent({ id: chat.id, write, updater: () => ({ root: chat.root }) });
  await service.updateChatMeta({ id: chat.id, write, updater: () => chat });
  await service.updateHierarchy({
    contentWrite: { id: chat.id, write },
    updater: ({ current }) => ({ ...current, items: [...current.items, { type: 'chat', id: chat.id }] }),
  });
  return chat;
}

async function saveEmptyChatGroup({ service }: { service: StorageService }): Promise<void> {
  const chatGroup: ChatGroup = { id: toChatGroupId({ raw: 'empty-chat-group' }), name: 'Empty chat group', isCollapsed: false, updatedAt: 1, items: [] };
  await service.updateChatGroup({ id: chatGroup.id, updater: () => chatGroup });
  await service.updateHierarchy({ updater: ({ current }) => ({ ...current, items: [...current.items, { type: 'chat_group', id: chatGroup.id, chat_ids: [] }] }) });
}

beforeEach(() => {
  localStorage.clear();
  lockCalls.length = 0;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: serializedLocks() });
});

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks });
  vi.restoreAllMocks();
});

describe('automatic creation for empty chat history', () => {
  it('serializes storage instances into one saved chat without reacquiring the automatic lock', async () => {
    const first = new StorageService();
    const second = new StorageService();
    await first.init({ type: 'local' });
    await second.init({ type: 'local' });
    lockCalls.length = 0;
    const createFirst = vi.fn(() => saveChat({ service: first, rawId: 'first-chat' }));
    const createSecond = vi.fn(() => saveChat({ service: second, rawId: 'second-chat' }));
    const results = await promiseAllKeyed({
      first: first.createChatIfHistoryEmpty({ create: createFirst, isCurrent: () => true }),
      second: second.createChatIfHistoryEmpty({ create: createSecond, isCurrent: () => true }),
    });
    expect(Object.values(results).filter(chat => chat !== undefined)).toHaveLength(1);
    expect(createFirst.mock.calls.length + createSecond.mock.calls.length).toBe(1);
    expect(await first.listChats()).toHaveLength(1);
    expect(await second.getSidebarStructure()).toHaveLength(1);
    expect(lockCalls[0]).toBe(`${SYNC_LOCK_KEY}:automatic-chat`);
    expect(lockCalls).toContain(LOCK_METADATA);
    expect(lockCalls).toContain(SYNC_LOCK_KEY);
    const created = Object.values(results).find(chat => chat !== undefined)!;
    expect(await first.loadChat({ id: created.id })).toMatchObject({ id: created.id, root: { items: [] } });
  });

  it.each(['chat', 'chat-group'] as const)('does not create when a saved %s already exists', async kind => {
    const service = new StorageService();
    await service.init({ type: 'local' });
    switch (kind) {
    case 'chat': await saveChat({ service, rawId: 'existing-chat' });
      break;
    case 'chat-group': await saveEmptyChatGroup({ service });
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
    const create = vi.fn(() => saveChat({ service, rawId: 'unwanted-chat' }));
    expect(await service.createChatIfHistoryEmpty({ create, isCurrent: () => true })).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('serializes memory creation without Web Locks using the existing page-local fallback', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const service = new StorageService();
    await service.init({ type: 'memory' });
    const create = vi.fn(() => saveChat({ service, rawId: 'memory-chat' }));
    const results = await promiseAllKeyed({
      first: service.createChatIfHistoryEmpty({ create, isCurrent: () => true }),
      second: service.createChatIfHistoryEmpty({ create, isCurrent: () => true }),
    });
    expect(Object.values(results).filter(chat => chat !== undefined)).toHaveLength(1);
    expect(create).toHaveBeenCalledOnce();
    expect(await service.listChats()).toHaveLength(1);
  });

  it('rechecks a chat group added while another automatic request holds the lock', async () => {
    const first = new StorageService();
    const second = new StorageService();
    await first.init({ type: 'local' });
    await second.init({ type: 'local' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hold = first.createChatIfHistoryEmpty({
      isCurrent: () => true,
      create: async () => {
        entered.resolve();
        await release.promise;
        return undefined;
      },
    });
    await entered.promise;
    const create = vi.fn(() => saveChat({ service: second, rawId: 'unwanted-chat' }));
    const queued = second.createChatIfHistoryEmpty({ create, isCurrent: () => true });
    await saveEmptyChatGroup({ service: second });
    release.resolve();
    await hold;
    expect(await queued).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(await second.getSidebarStructure()).toHaveLength(1);
  });

  it.each(['request', 'storage'] as const)('does not create when its %s changes during the sidebar read', async change => {
    const service = new StorageService();
    await service.init({ type: 'local' });
    const readSidebar = LocalStorageProvider.prototype.getSidebarStructure;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(LocalStorageProvider.prototype, 'getSidebarStructure').mockImplementationOnce(async function (this: LocalStorageProvider) {
      const sidebar = await readSidebar.call(this);
      entered.resolve();
      await release.promise;
      return sidebar;
    });
    let current = true;
    const create = vi.fn(() => saveChat({ service, rawId: 'unwanted-chat' }));
    const operation = service.createChatIfHistoryEmpty({ create, isCurrent: () => current });
    await entered.promise;
    switch (change) {
    case 'request': current = false;
      break;
    case 'storage': await service.init({ type: 'memory' });
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    release.resolve();
    expect(await operation).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(await service.getSidebarStructure()).toEqual([]);
  });

  it('propagates sidebar errors instead of treating an unreadable history as empty', async () => {
    const service = new StorageService();
    await service.init({ type: 'local' });
    vi.spyOn(LocalStorageProvider.prototype, 'getSidebarStructure').mockRejectedValueOnce(new Error('Read failed'));
    const create = vi.fn(() => saveChat({ service, rawId: 'unwanted-chat' }));
    await expect(service.createChatIfHistoryEmpty({ create, isCurrent: () => true })).rejects.toThrow('Read failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('releases its lock after creation fails so an explicit retry can succeed', async () => {
    const service = new StorageService();
    await service.init({ type: 'local' });
    await expect(service.createChatIfHistoryEmpty({
      create: async () => {
        throw new Error('Save failed');
      },
      isCurrent: () => true,
    })).rejects.toThrow('Save failed');
    const chat = await service.createChatIfHistoryEmpty({ create: () => saveChat({ service, rawId: 'retry-chat' }), isCurrent: () => true });
    expect(chat?.id).toBe(toChatId({ raw: 'retry-chat' }));
    expect(await service.listChats()).toHaveLength(1);
  });

  it('keeps an accepted saved chat when its page leaves during creation', async () => {
    const service = new StorageService();
    await service.init({ type: 'local' });
    let current = true;
    const chat = await service.createChatIfHistoryEmpty({
      isCurrent: () => current,
      create: async () => {
        const saved = await saveChat({ service, rawId: 'accepted-chat' });
        current = false;
        return saved;
      },
    });
    expect(chat?.id).toBe(toChatId({ raw: 'accepted-chat' }));
    expect(await service.loadChat({ id: chat!.id })).toMatchObject({ id: chat!.id });
  });
});
