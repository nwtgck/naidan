import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageService } from './index';
import { LocalStorageProvider } from './local-storage';
import type { ChatContent, ChatMeta } from '@/01-models/types';
import { toChatId, toMessageId } from '@/01-models/ids';
import { STORAGE_KEY_PREFIX, LOCK_CHAT_CONTENT_PREFIX, LOCK_METADATA } from '@/constants';

const { notify, report, locks } = vi.hoisted(() => ({ notify: vi.fn(), report: vi.fn(), locks: vi.fn() }));
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only boundary string stub; localization is not under test.
vi.mock('@/strings', () => ({ ensureStrings: { StorageService__an_error_occurred_during_a_storage_operation: async () => 'Storage error' } }));
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only event sink observes the existing storage notification boundary.
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: report, addInfoEvent: vi.fn() }) }));
vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: async () => false }));
vi.mock('./synchronizer', () => ({ StorageSynchronizer: class {
  async withLock<T>({ fn, lockKey }: { fn: () => Promise<T>; lockKey: string }): Promise<T> {
    locks(lockKey);
    return fn();
  }
  notify = notify;
} }));

const id = toChatId({ raw: 'read-before-write' });
const contentKey = `${STORAGE_KEY_PREFIX}lsp:chat_content:read-before-write`;
const metaKey = `${STORAGE_KEY_PREFIX}lsp:chat_meta:read-before-write`;
const replacementContent: ChatContent = { root: { items: [] } };
const replacementMeta: ChatMeta = { id, title: 'New title', createdAt: 0, updatedAt: 1, debugEnabled: false };
let service: StorageService;

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  service = new StorageService();
  await service.init({ type: 'local' });
  locks.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const unreadableContents = [
  '', '{', 'null', '{"root":{"items":"not-an-array"}}',
  JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', timestamp: 7, content: 'Must not fall back', parts: null, replies: { items: [] } }] } }),
  JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', createdAt: 7, parts: [{ id: 'p', type: 'unknown_part' }], replies: { items: [] } }] } }),
];

describe('read-update-write chat content', () => {
  for (const [index, raw] of unreadableContents.entries()) {
    it(`does not invoke an updater or overwrite unreadable content ${index}`, async () => {
      localStorage.setItem(contentKey, raw);
      const save = vi.spyOn(LocalStorageProvider.prototype, 'saveChatContent');
      const updater = vi.fn(({ current }: { current: ChatContent | null }) => current ?? replacementContent);
      await expect(service.updateChatContent({ id, updater })).rejects.toThrow();
      expect(updater).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(localStorage.getItem(contentKey)).toBe(raw);
      expect(notify).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledOnce();
      expect(locks).toHaveBeenCalledWith(`${LOCK_CHAT_CONTENT_PREFIX}read-before-write`);
    });
  }

  it('still permits the updater to create genuinely absent content', async () => {
    const updater = vi.fn(({ current }: { current: ChatContent | null }) => {
      expect(current).toBeNull();
      return replacementContent;
    });
    await service.updateChatContent({ id, updater });
    expect(updater).toHaveBeenCalledOnce();
    expect(await service.loadChatContent({ id })).toEqual(replacementContent);
    expect(notify).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it('can retry after explicit repair without retaining the failed read as empty content', async () => {
    localStorage.setItem(contentKey, '{');
    await expect(service.updateChatContent({ id, updater: () => replacementContent })).rejects.toThrow();
    localStorage.setItem(contentKey, JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', createdAt: 9,
      parts: [{ id: 'p1', type: 'reasoning', text: '  R\r\n' }, { id: 'p2', type: 'text', text: '<think>raw</think> ', completeness: 'partial' }],
      interruption: { type: 'error', message: '通信が途切れました' }, replies: { items: [] } }] }, currentLeafId: 'a' }));
    const before = await service.loadChatContent({ id });
    await service.updateChatContent({ id, updater: ({ current }) => {
      expect(current).toEqual(before);
      if (!current) throw new Error('The repaired content must exist.');
      return current;
    } });
    expect(await service.loadChatContent({ id })).toEqual(before);
    expect(notify).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });

  it('migrates a valid V1 tree only on the successful explicit save', async () => {
    const raw = JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', timestamp: 9,
      thinking: ' R ', content: ' <think>literal</think> [Generation Aborted]', replies: { items: [] } }] }, currentLeafId: 'a' });
    localStorage.setItem(contentKey, raw);
    const before = await service.loadChatContent({ id });
    expect(localStorage.getItem(contentKey)).toBe(raw);
    await service.updateChatContent({ id, updater: ({ current }) => {
      if (!current) throw new Error('Legacy content must exist.');
      return current;
    } });
    const saved = JSON.parse(localStorage.getItem(contentKey)!);
    expect(saved.root.items[0]).toEqual({ id: 'a', role: 'assistant', createdAt: 9,
      parts: [
        { id: 'legacy_reasoning', type: 'reasoning', text: ' R ' },
        { id: 'legacy_text', type: 'text', text: ' <think>literal</think> [Generation Aborted]' },
      ], replies: { items: [] } });
    expect(await service.loadChatContent({ id })).toEqual(before);
    expect(before?.currentLeafId).toBe(toMessageId({ raw: 'a' }));
  });
});

describe('read-update-write chat metadata', () => {
  for (const raw of ['', '{', '{"id":"without-title"}']) {
    it(`does not replace unreadable metadata ${JSON.stringify(raw)} with defaults`, async () => {
      localStorage.setItem(metaKey, raw);
      const save = vi.spyOn(LocalStorageProvider.prototype, 'saveChatMeta');
      const updater = vi.fn(({ current }: { current: ChatMeta | null }) => current ?? replacementMeta);
      await expect(service.updateChatMeta({ id, updater })).rejects.toThrow();
      expect(updater).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
      expect(localStorage.getItem(metaKey)).toBe(raw);
      expect(notify).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledOnce();
      expect(locks).toHaveBeenCalledWith(LOCK_METADATA);
    });
  }

  it('permits genuine new metadata and does not replace unreadable content', async () => {
    localStorage.setItem(contentKey, '{');
    await service.updateChatMeta({ id, updater: ({ current }) => {
      expect(current).toBeNull();
      return replacementMeta;
    } });
    expect(await service.loadChatMeta({ id })).toMatchObject(replacementMeta);
    expect(localStorage.getItem(contentKey)).toBe('{');
    expect(notify).toHaveBeenCalledOnce();
  });
});

it('reports a read failure without notifying a successful write or running user code', async () => {
  const failure = new DOMException('Access denied', 'SecurityError');
  const getItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function(this: Storage, key: string) {
    if (key === contentKey) throw failure;
    return getItem.call(this, key);
  });
  const updater = vi.fn(() => replacementContent);
  await expect(service.updateChatContent({ id, updater })).rejects.toBe(failure);
  expect(updater).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledOnce();
});
