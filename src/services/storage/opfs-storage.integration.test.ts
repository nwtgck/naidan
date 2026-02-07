import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportExportService } from '../import-export/service';
import { StorageService } from './index';

// --- Improved Mocks for OPFS ---
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

// Polyfills
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

describe('OPFSStorageProvider & ImportExport Integration', () => {
  let storageService: StorageService;
  let importExportService: ImportExportService;

  beforeEach(async () => {
    mockRoot.entries.clear();
    localStorage.clear();
    storageService = new StorageService();
    // We need to initialize with 'opfs' to use the real OPFSStorageProvider logic
    await storageService.init('opfs');
    importExportService = new ImportExportService(storageService);
  });

  it('should maintain index integrity when multiple files are stored in the same shard', async () => {
    // Both UUIDs end in 'a1'
    const id1 = '00000000-0000-4000-a000-0000000000a1';
    const id2 = 'ffffffff-ffff-4fff-afff-ffffffffffa1';
    
    await storageService.saveFile(new Blob(['D1'], { type: 'image/png' }), id1, 'img1.png');
    await storageService.saveFile(new Blob(['D22'], { type: 'image/jpeg' }), id2, 'img2.jpg');

    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage');
    const binDir = await naidanDir.getDirectoryHandle('binary-objects');
    const shardDir = await binDir.getDirectoryHandle('a1');
    const indexFile = await shardDir.getFileHandle('index.json');
    const index = JSON.parse(await (await indexFile.getFile()).text());

    // Verify both exist in the same index.json
    expect(Object.keys(index.objects)).toHaveLength(2);
    expect(index.objects[id1].name).toBe('img1.png');
    expect(index.objects[id2].name).toBe('img2.jpg');
  });

  it('should correctly restore data into sharded structure when importing from a sharded ZIP', async () => {
    const chatID = '11111111-1111-4111-a111-111111111111';
    const msgID = '22222222-2222-4222-a222-222222222222';
    const attID = '33333333-3333-4333-a333-333333333333';
    const binaryID = '44444444-4444-4444-a444-4444444444a1'; // Shard 'a1'

    // 1. Manually create a "V2 style" sharded ZIP
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const root = zip.folder('naidan-backup');
    root!.file('export-manifest.json', JSON.stringify({ app_version: '0.1.0', exportedAt: Date.now() }));
    root!.file('settings.json', JSON.stringify({ storageType: 'opfs', endpoint: { type: 'openai', url: '' }, autoTitleEnabled: true, providerProfiles: [] }));
    root!.file('hierarchy.json', JSON.stringify({ items: [{ type: 'chat', id: chatID }] }));
    root!.file('chat-metas.json', JSON.stringify({ entries: [{ id: chatID, title: 'Test', createdAt: 0, updatedAt: 0, debugEnabled: false }] }));
    
    // Chat content with attachment (V2 format)
    root!.folder('chat-contents')!.file(`${chatID}.json`, JSON.stringify({
      root: {
        items: [{
          id: msgID, role: 'user', content: 'hello', timestamp: 0,
          attachments: [{ 
            id: attID, 
            binaryObjectId: binaryID, 
            name: 'test.png', 
            status: 'persisted'
          }],
          replies: { items: [] }
        }]
      }
    }));

    // Binary file in sharded structure
    const shardFolder = root!.folder('binary-objects')!.folder('a1');
    shardFolder!.file(`${binaryID}.bin`, new Blob(['INTEGRATION_DATA'], { type: 'image/png' }));
    shardFolder!.file('index.json', JSON.stringify({
      objects: {
        [binaryID]: {
          id: binaryID,
          mimeType: 'image/png',
          size: 16,
          createdAt: 0,
          name: 'test.png'
        }
      }
    }));

    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // 2. Import into empty storage
    await importExportService.executeImport(zipBlob, {
      data: { mode: 'replace' },
      settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
    });

    // 3. Verify storage is now sharded and hydrated correctly
    const loadedChat = await storageService.loadChat(chatID);
    expect(loadedChat).not.toBeNull();
    const att = loadedChat!.root.items[0]!.attachments![0]!;
    
    expect(att.binaryObjectId).toBe(binaryID);
    expect(att.mimeType).toBe('image/png'); // Must be hydrated from storage index
    expect(att.size).toBe(16);
    
    // Verify physical shard in mock OPFS
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage');
    const binDir = await naidanDir.getDirectoryHandle('binary-objects');
    const shardDir = await binDir.getDirectoryHandle('a1');
    await shardDir.getFileHandle(`${binaryID}.bin`);
    await shardDir.getFileHandle(`.${binaryID}.bin.complete`);
  });
});
