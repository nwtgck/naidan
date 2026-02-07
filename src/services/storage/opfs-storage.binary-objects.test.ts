import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';
import type { MessageNode } from '../../models/types';

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

  it('should save a file with shard directory, atomic marker, and index entry', async () => {
    await provider.init();
    const id = '550e8400-e29b-41d4-a716-4466554400a1'; // Shard 'a1'
    const blob = new Blob(['HELLO'], { type: 'image/png' });
    
    await provider.saveFile({
      blob,
      binaryObjectId: id,
      name: 'test.png',
      mimeType: undefined
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
      name: 'test.png'
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
    const result = await provider.getFile(id);
    expect(result).toBeNull();

    // Now add the marker
    await shardDir.getFileHandle(`.${id}.bin.complete`, { create: true });
    
    const resultAfterMarker = await provider.getFile(id);
    expect(resultAfterMarker).not.toBeNull();
    expect(await resultAfterMarker!.text()).toBe('DATA');
  });

  it('should correctly hydrate multiple attachments in a message tree', async () => {
    await provider.init();
    const id1 = '00000000-0000-4000-a000-0000000000a1';
    const id2 = '00000000-0000-4000-a000-0000000000a2';
    
    await provider.saveFile({
      blob: new Blob(['1'], { type: 'image/png' }),
      binaryObjectId: id1,
      name: 'img1.png',
      mimeType: undefined
    });
    await provider.saveFile({
      blob: new Blob(['22'], { type: 'application/pdf' }),
      binaryObjectId: id2,
      name: 'doc2.pdf',
      mimeType: undefined
    });

    const nodes: MessageNode[] = [{
      id: '11111111-1111-4111-a111-111111111111',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
      attachments: [
        { id: '22222222-2222-4222-a222-222222222222', binaryObjectId: id1, originalName: 'img1.png', mimeType: '', size: 0, status: 'persisted', uploadedAt: 0 },
        { id: '33333333-3333-4333-a333-333333333333', binaryObjectId: id2, originalName: 'doc2.pdf', mimeType: '', size: 0, status: 'persisted', uploadedAt: 0 }
      ],
      replies: { items: [] }
    }];

    // Hydrate
    // @ts-expect-error: Accessing private for test
    await provider.hydrateAttachments(nodes);

    const atts = nodes[0]!.attachments!;
    expect(atts[0]!.mimeType).toBe('image/png');
    expect(atts[0]!.size).toBe(1);
    expect(atts[1]!.mimeType).toBe('application/pdf');
    expect(atts[1]!.size).toBe(2);
  });

  it('should report correct status in hasAttachments', async () => {
    await provider.init();
    expect(await provider.hasAttachments()).toBe(false);

    await provider.saveFile({
      blob: new Blob(['test']),
      binaryObjectId: '550e8400-e29b-41d4-a716-4466554400a1',
      name: 't.txt',
      mimeType: undefined
    });
    expect(await provider.hasAttachments()).toBe(true);
  });

  it('should wipe binary-objects directory during clearAll', async () => {
    await provider.init();
    await provider.saveFile({
      blob: new Blob(['test']),
      binaryObjectId: '550e8400-e29b-41d4-a716-4466554400a1',
      name: 't.txt',
      mimeType: undefined
    });
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage');
    expect(naidanDir.entries.has('binary-objects')).toBe(true);

    await provider.clearAll();
    expect(naidanDir.entries.has('binary-objects')).toBe(false);
  });
});
