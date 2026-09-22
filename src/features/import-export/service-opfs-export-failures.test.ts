import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { storageService } from '@/00-storage/service';
import { toBinaryObjectId, toChatId, toMessageId } from '@/01-models/ids';
import type { Chat } from '@/01-models/types';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { ImportExportService } from './service';

const { addErrorEvent } = vi.hoisted(() => ({ addErrorEvent: vi.fn() }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent }) }));

async function snapshotFiles({ directory }: { directory: MockFileSystemDirectoryHandle }): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for await (const entry of directory.values()) {
    switch (entry.kind) {
    case 'file': files.set(entry.name, entry.content.slice()); break;
    case 'directory':
      for (const [name, bytes] of await snapshotFiles({ directory: entry })) files.set(`${entry.name}/${name}`, bytes);
      break;
    default: { const exhaustive: never = entry; throw new Error(`Unexpected entry: ${exhaustive}`); }
    }
  }
  return files;
}

async function createFixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'opfs' });
  const storageRoot = await root.getDirectoryHandle('naidan-storage', { create: true });
  await storageRoot.getDirectoryHandle('uploaded-files', { create: true });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  await storageService.init({ type: 'opfs' });
  expect(storageService.getCurrentType()).toBe('opfs');
  const provider = new OPFSStorageProvider();
  await provider.init();
  const chat: Chat = {
    id: toChatId({ raw: 'saved-chat' }), title: 'Saved chat', createdAt: 1, updatedAt: 2,
    debugEnabled: false, endpoint: undefined, modelId: undefined, titleGeneration: 'inherit',
    groupId: undefined, originChatId: undefined, originMessageId: undefined,
    systemPrompt: undefined, lmParameters: undefined, mounts: [], currentLeafId: toMessageId({ raw: 'user' }),
    root: { items: [{
      id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'text', text: 'Original saved message', completeness: 'complete' }],
      replies: { items: [] },
    }] },
  };
  await provider.saveChatMeta({ meta: chat });
  await provider.saveChatContent({ id: chat.id, content: chat });
  const binaryRoot = await storageRoot.getDirectoryHandle('binary-objects', { create: true });
  for (const id of ['binary-aa', 'binary-bb', 'binary-cc']) {
    const shard = await binaryRoot.getDirectoryHandle(id.slice(-2), { create: true });
    const index = await shard.getFileHandle('index.json', { create: true });
    index.content = new TextEncoder().encode('{"objects":{}}');
    await provider.saveFile({ binaryObjectId: toBinaryObjectId({ raw: id }), blob: new Blob([id]), name: id });
  }
  const brokenShard = await binaryRoot.getDirectoryHandle('bb');
  const brokenIndex = await brokenShard.getFileHandle('index.json');
  return { root, provider, brokenShard, brokenIndex };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OPFS export index read failures', () => {
  it.each(['invalid-json', 'invalid-schema', 'unreadable-handle'] as const)(
    'rejects dump after earlier chat and shard output when an existing index is %s', async failure => {
      const { root, provider, brokenIndex } = await createFixture();
      switch (failure) {
      case 'invalid-json': brokenIndex.content = new TextEncoder().encode('{"objects":'); break;
      case 'invalid-schema': brokenIndex.content = new TextEncoder().encode('{"objects":[]}'); break;
      case 'unreadable-handle':
        // NotFound after acquiring the handle is a read failure, not an absent index.
        vi.spyOn(brokenIndex, 'getFile').mockRejectedValue(new DOMException('Index handle became unreadable', 'NotFoundError'));
        break;
      default: { const exhaustive: never = failure; throw new Error(`Unexpected failure: ${exhaustive}`); }
      }
      const before = await snapshotFiles({ directory: root });
      const { contentStream } = await provider.dump();
      const iterator = contentStream[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'chat', data: { id: 'saved-chat' } } });
      expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'binary_object', id: 'binary-aa' } });
      await expect(iterator.next()).rejects.toThrow();
      expect(await snapshotFiles({ directory: root })).toEqual(before);
    },
  );

  it('keeps a missing index distinct and still visits the following shard', async () => {
    const { root, provider, brokenShard } = await createFixture();
    await brokenShard.removeEntry('index.json');
    const before = await snapshotFiles({ directory: root });
    const { contentStream } = await provider.dump();
    const chunks = [];
    for await (const chunk of contentStream) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.type === 'chat' ? chunk.data.id : chunk.id)).toEqual(['saved-chat', 'binary-aa', 'binary-cc']);
    expect(await snapshotFiles({ directory: root })).toEqual(before);
  });

  it('aborts the real ZIP stream after partial output instead of finalizing an incomplete backup', async () => {
    const { root, brokenIndex } = await createFixture();
    const failure = new DOMException('Existing index cannot be read', 'NotReadableError');
    vi.spyOn(brokenIndex, 'getFile').mockRejectedValue(failure);
    const before = await snapshotFiles({ directory: root });
    const service = new ImportExportService({ storage: storageService });
    const { stream } = await service.exportData({});
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const reader = stream.getReader();
    try {
      const consume = async () => {
        while (true) {
          const item = await reader.read();
          if (item.done) return;
          chunks.push(Uint8Array.from(item.value));
        }
      };
      await expect(consume()).rejects.toBe(failure);
    } finally {
      reader.releaseLock();
    }
    expect(chunks.length).toBeGreaterThan(0);
    await expect(JSZip.loadAsync(new Blob(chunks))).rejects.toThrow();
    expect(addErrorEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      source: 'ImportExportService',
      details: expect.objectContaining({ message: expect.stringContaining('Existing index cannot be read') }),
    }));
    expect(await snapshotFiles({ directory: root })).toEqual(before);
  });
});
