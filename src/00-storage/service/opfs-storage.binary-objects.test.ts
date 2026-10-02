import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';
import type { MessageNode } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId } from '@/01-models/ids';
import { createBlobStorageBinaryObjectReadHandle, type StorageBinaryObjectReadHandle } from './binary-object-io';
import { NaidanOpfsStorageBackend } from './naidan-opfs/backend';
import { OpfsStorageSessionLock } from './opfs/opfs-storage-session-lock';

// --- Reusable Mocks ---
class MockFileSystemFileHandle {
  kind = 'file' as const;
  constructor(public name: string, private blob: Blob = new Blob()) {}
  async getFile() {
    return this.blob;
  }
  createWritable() {
    return Promise.resolve({
      write: async (data: any) => {
        if (data instanceof Blob) this.blob = data;
        else if (typeof data === 'string') this.blob = new Blob([data], { type: 'text/plain' });
        else this.blob = new Blob([data]);
      },
      close: () => Promise.resolve(),
    });
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockFileSystemDirectoryHandle> {
    if (!this.entries.has(name)) {
      if (options?.create) this.entries.set(name, new MockFileSystemDirectoryHandle(name));
      else {
        const err = new Error('Not found'); err.name = 'NotFoundError'; throw err;
      }
    }
    const entry = this.entries.get(name);
    if (entry instanceof MockFileSystemFileHandle) throw new Error('Not a directory');
    return entry as MockFileSystemDirectoryHandle;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileSystemFileHandle> {
    if (!this.entries.has(name)) {
      if (options?.create) this.entries.set(name, new MockFileSystemFileHandle(name));
      else {
        const err = new Error('Not found'); err.name = 'NotFoundError'; throw err;
      }
    }
    const entry = this.entries.get(name);
    if (entry instanceof MockFileSystemDirectoryHandle) throw new Error('Not a file');
    return entry as MockFileSystemFileHandle;
  }
  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    this.entries.delete(name);
  }
  async *values() {
    for (const entry of this.entries.values()) yield entry;
  }
  async *keys() {
    for (const key of this.entries.keys()) yield key;
  }
}

const mockRoot = new MockFileSystemDirectoryHandle('root');
vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(mockRoot) } });

// Polyfills for happy-dom
if (!Blob.prototype.text) {
  Blob.prototype.text = async function() {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  };
}
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = async function() {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  };
}

describe('OPFSStorageProvider - Binary Object Operations', () => {
  let provider: OPFSStorageProvider;

  beforeEach(() => {
    mockRoot.entries.clear();
    provider = new OPFSStorageProvider();
  });

  it.each(['success', 'failure', 'undefined failure', 'synchronous failure'] as const)(
    'shares binary close settlement and releases once after %s',
    async (outcome) => {
      await provider.init();
      const finishClose = Promise.withResolvers<void>();
      const closeFailure = outcome === 'undefined failure' ? undefined : new Error('reader close failed');
      const readClosed = new Error('reader is closing');
      const blobHandle = createBlobStorageBinaryObjectReadHandle({
        blob: new Blob(['body']),
        mimeType: 'text/plain',
      });
      let closing = false;
      let wrapped: StorageBinaryObjectReadHandle | undefined;
      let reentrantClose: Promise<void> | undefined;
      const close = vi.fn(() => {
        closing = true;
        reentrantClose = wrapped!.close();
        if (outcome === 'synchronous failure') throw closeFailure;
        return finishClose.promise.then(() => {
          if (outcome !== 'success') throw closeFailure;
        });
      });
      const lower: StorageBinaryObjectReadHandle = {
        ...blobHandle,
        async read(args) {
          if (closing) throw readClosed;
          return await blobHandle.read(args);
        },
        stream(args) {
          if (closing) throw readClosed;
          return blobHandle.stream(args);
        },
        close,
      };
      const open = vi.spyOn(NaidanOpfsStorageBackend.prototype, 'openBinaryObject').mockResolvedValue(lower);
      const originalAcquire = OpfsStorageSessionLock.prototype.acquireOperation;
      let release = vi.fn<() => void>();
      const acquire = vi.spyOn(OpfsStorageSessionLock.prototype, 'acquireOperation').mockImplementation(function (this: OpfsStorageSessionLock) {
        release = vi.fn(originalAcquire.call(this));
        return release;
      });
      const settlements: ({ status: 'fulfilled' } | { status: 'rejected'; reason: unknown })[] = [];
      const observed: Promise<void>[] = [];
      let suspended = false;
      let suspend: Promise<void> | undefined;
      try {
        const opened = await provider.openBinaryObject({
          binaryObjectId: toBinaryObjectId({ raw: '550e8400-e29b-41d4-a716-4466554400a1' }),
        });
        expect(opened).not.toBeNull();
        wrapped = opened!;
        const first = wrapped.close();
        const second = wrapped.close();
        expect(reentrantClose).toBeDefined();
        for (const completion of [first, second, reentrantClose!]) {
          observed.push(completion.then(
            () => {
              settlements.push({ status: 'fulfilled' });
            },
            (reason: unknown) => {
              settlements.push({ status: 'rejected', reason });
            },
          ));
        }
        expect(close).toHaveBeenCalledOnce();
        expect(() => wrapped!.stream({ start: 0, end: undefined, signal: undefined })).toThrow(readClosed);
        await expect(wrapped.read({
          buffer: new Uint8Array(1), offset: 0, length: 1, position: 0, signal: undefined,
        })).rejects.toBe(readClosed);

        suspend = provider.suspendStorageSession().then(() => {
          suspended = true;
        });
        await Promise.resolve();
        if (outcome !== 'synchronous failure') {
          expect(settlements).toEqual([]);
          expect(release).not.toHaveBeenCalled();
          expect(suspended).toBe(false);
        }
        finishClose.resolve();
        await Promise.all(observed);
        await suspend;

        const expected = outcome === 'success'
          ? { status: 'fulfilled' }
          : { status: 'rejected', reason: closeFailure };
        expect(settlements).toEqual([expected, expected, expected]);
        expect(close).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(suspended).toBe(true);
        if (outcome === 'success') {
          await expect(wrapped.close()).resolves.toBeUndefined();
        } else {
          await expect(wrapped.close()).rejects.toBe(closeFailure);
        }
        expect(close).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        finishClose.resolve();
        await Promise.allSettled(observed);
        await suspend;
        acquire.mockRestore();
        open.mockRestore();
        await provider.dispose();
      }
    },
  );

  it('should save a file with shard directory, atomic marker, and index entry', async () => {
    await provider.init();
    const id = '550e8400-e29b-41d4-a716-4466554400a1'; // Shard 'a1'
    const blob = new Blob(['HELLO'], { type: 'image/png' });

    await provider.saveFile({
      blob,
      binaryObjectId: toBinaryObjectId({ raw: id }),
      name: 'test.png',
      mimeType: undefined,
    });

    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage');
    const binDir = await naidanDir.getDirectoryHandle('binary-objects');
    const shardDir = await binDir.getDirectoryHandle('a1');

    // 1. Verify file content
    const file = await shardDir.getFileHandle(`${id}.bin`);
    expect((await file.getFile()).size).toBe(5);

    // 2. Verify marker existence
    const marker = await shardDir.getFileHandle(`.${id}.bin.complete`);
    expect(marker).toBeDefined();

    // 3. Verify index entry
    const indexFile = await shardDir.getFileHandle('index.json');
    const index = JSON.parse(await (await indexFile.getFile()).text());
    expect(index.objects[id]).toMatchObject({
      mimeType: 'image/png',
      size: 5,
      name: 'test.png',
    });
  });

  it('should only return the file if the atomic completion marker exists', async () => {
    await provider.init();
    const id = '550e8400-e29b-41d4-a716-4466554400b2'; // Shard 'b2'
    const blob = new Blob(['DATA'], { type: 'text/plain' });

    // Manually setup file WITHOUT marker
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    const binDir = await naidanDir.getDirectoryHandle('binary-objects', { create: true });
    const shardDir = await binDir.getDirectoryHandle('b2', { create: true });
    const fileHandle = await shardDir.getFileHandle(`${id}.bin`, { create: true });
    const w = await fileHandle.createWritable();
    await w.write(blob);
    await w.close();

    // Attempt to get file should return null because marker is missing
    const result = await provider.getFile({ binaryObjectId: toBinaryObjectId({ raw: id }) });
    expect(result).toBeNull();

    // Now add the marker
    await shardDir.getFileHandle(`.${id}.bin.complete`, { create: true });

    const resultAfterMarker = await provider.getFile({ binaryObjectId: toBinaryObjectId({ raw: id }) });
    expect(resultAfterMarker).not.toBeNull();
    expect(await resultAfterMarker!.text()).toBe('DATA');
    expect(resultAfterMarker!.type).toBe('text/plain');
  });

  it('should restore the indexed MIME type when loading a binary object', async () => {
    await provider.init();
    const id = '550e8400-e29b-41d4-a716-4466554400c3';

    await provider.saveFile({
      blob: new Blob(['PNG'], { type: 'application/octet-stream' }),
      binaryObjectId: toBinaryObjectId({ raw: id }),
      name: 'image.png',
      mimeType: 'image/png',
    });

    const result = await provider.getFile({
      binaryObjectId: toBinaryObjectId({ raw: id }),
    });

    expect(result).not.toBeNull();
    expect(await result!.text()).toBe('PNG');
    expect(result!.type).toBe('image/png');
  });

  it('should correctly hydrate multiple attachments in a message tree', async () => {
    await provider.init();
    const id1 = '00000000-0000-4000-a000-0000000000a1';
    const id2 = '00000000-0000-4000-a000-0000000000a2';

    await provider.saveFile({
      blob: new Blob(['1'], { type: 'image/png' }),
      binaryObjectId: toBinaryObjectId({ raw: id1 }),
      name: 'img1.png',
      mimeType: undefined,
    });
    await provider.saveFile({
      blob: new Blob(['22'], { type: 'application/pdf' }),
      binaryObjectId: toBinaryObjectId({ raw: id2 }),
      name: 'doc2.pdf',
      mimeType: undefined,
    });

    const nodes: MessageNode[] = [{ id: toMessageId({ raw: '11111111-1111-4111-a111-111111111111' }), role: 'user', createdAt: Date.now(), modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: 'hello', completeness: 'complete' }, { type: 'attachment', attachment: { id: toAttachmentId({ raw: '22222222-2222-4222-a222-222222222222' }), binaryObjectId: toBinaryObjectId({ raw: id1 }), originalName: 'img1.png', mimeType: '', size: 0, status: 'persisted', uploadedAt: 0 } }, { type: 'attachment', attachment: { id: toAttachmentId({ raw: '33333333-3333-4333-a333-333333333333' }), binaryObjectId: toBinaryObjectId({ raw: id2 }), originalName: 'doc2.pdf', mimeType: '', size: 0, status: 'persisted', uploadedAt: 0 } }], replies: { items: [] } }];

    const chatId = toChatId({ raw: '00000000-0000-4000-a000-000000000001' });
    await provider.saveChatContent({
      id: chatId,
      content: {
        root: { items: nodes },
        currentLeafId: undefined,
      },
    });
    const content = await provider.loadChatContent({ id: chatId });

    const atts = content!.root.items[0]!.parts.filter(part => part.type === 'attachment').map(part => part.attachment)!;
    expect(atts[0]!.mimeType).toBe('image/png');
    expect(atts[0]!.size).toBe(1);
    expect(atts[1]!.mimeType).toBe('application/pdf');
    expect(atts[1]!.size).toBe(2);
  });

  it('should load chat content without hydrating attachment metadata', async () => {
    await provider.init();
    const chatId = toChatId({ raw: '00000000-0000-4000-a000-000000000010' });
    const binaryObjectId = toBinaryObjectId({ raw: '00000000-0000-4000-a000-000000000011' });

    await provider.saveFile({
      blob: new Blob(['attachment'], { type: 'text/plain' }),
      binaryObjectId,
      name: 'attachment.txt',
      mimeType: undefined,
    });
    await provider.saveChatContent({
      id: chatId,
      content: {
        root: {
          items: [{ id: toMessageId({ raw: '00000000-0000-4000-a000-000000000012' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: 'hello', completeness: 'complete' }, { type: 'attachment', attachment: {
            id: toAttachmentId({ raw: '00000000-0000-4000-a000-000000000013' }),
            binaryObjectId,
            originalName: 'attachment.txt',
            mimeType: 'text/plain',
            size: 10,
            uploadedAt: 1,
            status: 'persisted',
          } }], replies: { items: [] } }],
        },
      },
    });

    const unhydrated = await provider.loadChatContentWithoutAttachments({ id: chatId });
    const hydrated = await provider.loadChatContent({ id: chatId });

    expect(unhydrated?.root.items[0]?.parts.filter(part => part.type === 'attachment').map(part => part.attachment)?.[0]).toMatchObject({
      mimeType: 'application/octet-stream',
      size: 0,
    });
    expect(hydrated?.root.items[0]?.parts.filter(part => part.type === 'attachment').map(part => part.attachment)?.[0]).toMatchObject({
      mimeType: 'text/plain',
      size: 10,
    });
  });

  it('should report correct status in hasAttachments', async () => {
    await provider.init();
    expect(await provider.hasAttachments()).toBe(false);

    await provider.saveFile({
      blob: new Blob(['test']),
      binaryObjectId: toBinaryObjectId({ raw: '550e8400-e29b-41d4-a716-4466554400a1' }),
      name: 't.txt',
      mimeType: undefined,
    });
    expect(await provider.hasAttachments()).toBe(true);
  });

  it('should wipe binary-objects directory during clearAll', async () => {
    await provider.init();
    await provider.saveFile({
      blob: new Blob(['test']),
      binaryObjectId: toBinaryObjectId({ raw: '550e8400-e29b-41d4-a716-4466554400a1' }),
      name: 't.txt',
      mimeType: undefined,
    });
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage');
    expect(naidanDir.entries.has('binary-objects')).toBe(true);

    await provider.clearAll();
    expect(naidanDir.entries.has('binary-objects')).toBe(false);
  });
});
