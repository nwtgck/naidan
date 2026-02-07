import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';

// --- Exhaustive Mocks for OPFS ---
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

const VALID_UUID_1 = '00000000-0000-4000-a000-000000000001';
const VALID_UUID_2 = '00000000-0000-4000-a000-000000000002';
const CHAT_ID_1 = '11111111-1111-4111-a111-111111111111';
const CHAT_ID_2 = '22222222-2222-4222-a222-222222222222';
const MSG_ID_1 = '33333333-3333-4333-a333-333333333333';
const MSG_ID_2 = '44444444-4444-4444-a444-444444444444';
const MSG_ID_3 = '55555555-5555-4555-a555-555555555555';

describe('OPFSStorageProvider - Migration Logic', () => {
  beforeEach(() => {
    mockRoot.entries.clear();
  });

  const setupLegacyFile = async (naidanDir: MockFileSystemDirectoryHandle, attId: string, filename: string, content: string) => {
    const legacyDir = await naidanDir.getDirectoryHandle('uploaded-files', { create: true });
    const attDir = await legacyDir.getDirectoryHandle(attId, { create: true });
    const file = await attDir.getFileHandle(filename, { create: true });
    const w = await (file as any).createWritable();
    await w.write(new Blob([content], { type: 'image/png' }));
    await w.close();
  };

  const setupLegacyChat = async (naidanDir: MockFileSystemDirectoryHandle, chatId: string, attachments: any[]) => {
    const contentDir = await naidanDir.getDirectoryHandle('chat-contents', { create: true });
    const chatFile = await contentDir.getFileHandle(`${chatId}.json`, { create: true });
    const cw = await (chatFile as any).createWritable();
    await cw.write(JSON.stringify({
      root: { items: [{ id: MSG_ID_1, role: 'user', content: 'txt', attachments, timestamp: Date.now(), replies: { items: [] } }] },
      currentLeafId: MSG_ID_1
    }));
    await cw.close();

    const metaDir = await naidanDir.getDirectoryHandle('chat-metas', { create: true });
    const metaFile = await metaDir.getFileHandle(`${chatId}.json`, { create: true });
    const mw = await (metaFile as any).createWritable();
    await mw.write(JSON.stringify({ 
      id: chatId, 
      title: 'T', 
      createdAt: Date.now(), 
      updatedAt: Date.now(), 
      debugEnabled: false 
    }));
    await mw.close();
  };

  it('should migrate a single chat with one attachment to the new sharded structure', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await setupLegacyFile(naidanDir, VALID_UUID_1, 'img.png', 'DATA');
    await setupLegacyChat(naidanDir, CHAT_ID_1, [{ id: VALID_UUID_1, originalName: 'img.png', status: 'persisted', mimeType: 'image/png', size: 4, uploadedAt: 0 }]);

    const provider = new OPFSStorageProvider();
    await provider.init();

    const chat = await provider.loadChat(CHAT_ID_1);
    expect(chat).not.toBeNull();
    const att = chat!.root.items[0]!.attachments![0]!;
    expect(att.binaryObjectId).toBeDefined();
    expect(att.binaryObjectId).not.toBe(VALID_UUID_1);
    expect(att.status).toBe('persisted');
    
    const blob = await provider.getFile(att.binaryObjectId);
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('DATA');
  });

  it('should preserve chat structure when migrating chats with no attachments', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await setupLegacyChat(naidanDir, CHAT_ID_1, []);

    const provider = new OPFSStorageProvider();
    await provider.init();

    const chat = await provider.loadChat(CHAT_ID_1);
    expect(chat).not.toBeNull();
    expect(chat!.root.items[0]!.attachments).toHaveLength(0);
  });

  it('should initialize successfully on a fresh installation with no data', async () => {
    const provider = new OPFSStorageProvider();
    await provider.init();
    
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage');
    const stateFile = await naidanDir.getFileHandle('migration-state.json');
    expect(stateFile).toBeDefined();
  });

  it('should remove the legacy directory even if it contains no files', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await naidanDir.getDirectoryHandle('uploaded-files', { create: true });

    const provider = new OPFSStorageProvider();
    await provider.init();

    await expect(naidanDir.getDirectoryHandle('uploaded-files')).rejects.toThrow();
  });

  it('should map shared legacy attachments across different chats to the same binary object', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await setupLegacyFile(naidanDir, VALID_UUID_1, 'shared.png', 'SHARED_DATA');
    
    await setupLegacyChat(naidanDir, CHAT_ID_1, [{ id: VALID_UUID_1, originalName: 'shared.png', status: 'persisted', mimeType: 'image/png', size: 11, uploadedAt: 0 }]);
    await setupLegacyChat(naidanDir, CHAT_ID_2, [{ id: VALID_UUID_1, originalName: 'shared.png', status: 'persisted', mimeType: 'image/png', size: 11, uploadedAt: 0 }]);

    const provider = new OPFSStorageProvider();
    await provider.init();

    const chatA = await provider.loadChat(CHAT_ID_1);
    const chatB = await provider.loadChat(CHAT_ID_2);
    
    const bIdA = chatA!.root.items[0]!.attachments![0]!.binaryObjectId;
    const bIdB = chatB!.root.items[0]!.attachments![0]!.binaryObjectId;
    
    expect(bIdA).toBe(bIdB); 
  });

  it('should mark attachments as missing if their physical files are absent from legacy storage', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    const legacyDir = await naidanDir.getDirectoryHandle('uploaded-files', { create: true });
    await legacyDir.getDirectoryHandle(VALID_UUID_1, { create: true }); // Folder exists but empty

    await setupLegacyChat(naidanDir, CHAT_ID_1, [{ id: VALID_UUID_1, originalName: 'lost.png', status: 'persisted', mimeType: 'image/png', size: 0, uploadedAt: 0 }]);

    const provider = new OPFSStorageProvider();
    await provider.init();

    const chat = await provider.loadChat(CHAT_ID_1);
    expect(chat!.root.items[0]!.attachments![0]!.status).toBe('missing');
  });

  it('should skip corrupted chat content files and continue migrating valid ones', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await setupLegacyFile(naidanDir, VALID_UUID_1, 'img.png', 'DATA');
    await setupLegacyChat(naidanDir, CHAT_ID_1, [{ id: VALID_UUID_1, originalName: 'img.png', status: 'persisted', mimeType: 'image/png', size: 4, uploadedAt: 0 }]);
    
    const contentDir = await naidanDir.getDirectoryHandle('chat-contents', { create: true });
    const broken = await contentDir.getFileHandle('broken.json', { create: true });
    const w = await (broken as any).createWritable();
    await w.write('MALFORMED_JSON');
    await w.close();

    const provider = new OPFSStorageProvider();
    await provider.init(); 

    const chat = await provider.loadChat(CHAT_ID_1);
    expect(chat!.root.items[0]!.attachments![0]!.binaryObjectId).toBeDefined();
  });

  it('should remain idempotent and not modify data on repeated initializations', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await setupLegacyFile(naidanDir, VALID_UUID_1, 'img.png', 'DATA');
    await setupLegacyChat(naidanDir, CHAT_ID_1, [{ id: VALID_UUID_1, originalName: 'img.png', status: 'persisted', mimeType: 'image/png', size: 4, uploadedAt: 0 }]);

    const provider = new OPFSStorageProvider();
    await provider.init();
    
    const chat1 = await provider.loadChat(CHAT_ID_1);
    const bId = chat1!.root.items[0]!.attachments![0]!.binaryObjectId;

    await provider.init(); // Second call
    const chat2 = await provider.loadChat(CHAT_ID_1);
    expect(chat2!.root.items[0]!.attachments![0]!.binaryObjectId).toBe(bId);
  });

  it('should correctly migrate attachments located in deeply nested message branches', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    await setupLegacyFile(naidanDir, VALID_UUID_1, 'img1.png', 'D1');
    await setupLegacyFile(naidanDir, VALID_UUID_2, 'img2.png', 'D2');

    const contentDir = await naidanDir.getDirectoryHandle('chat-contents', { create: true });
    const chatFile = await contentDir.getFileHandle(`${CHAT_ID_1}.json`, { create: true });
    const cw = await (chatFile as any).createWritable();
    await cw.write(JSON.stringify({
      root: {
        items: [{
          id: MSG_ID_1, role: 'user', content: 'C1',
          attachments: [{ id: VALID_UUID_1, originalName: 'img1.png', status: 'persisted', mimeType: 'image/png', size: 2, uploadedAt: 0 }],
          timestamp: 100,
          replies: {
            items: [{
              id: MSG_ID_2, role: 'assistant', content: 'R1', timestamp: 110,
              replies: {
                items: [{
                  id: MSG_ID_3, role: 'user', content: 'Deep',
                  attachments: [{ id: VALID_UUID_2, originalName: 'img2.png', status: 'persisted', mimeType: 'image/png', size: 2, uploadedAt: 0 }],
                  timestamp: 120,
                  replies: { items: [] }
                }]
              }
            }]
          }
        }]
      },
      currentLeafId: MSG_ID_3
    }));
    await cw.close();

    const metaDir = await naidanDir.getDirectoryHandle('chat-metas', { create: true });
    const metaFile = await metaDir.getFileHandle(`${CHAT_ID_1}.json`, { create: true });
    const mw = await (metaFile as any).createWritable();
    await mw.write(JSON.stringify({ id: CHAT_ID_1, title: 'D', createdAt: 0, updatedAt: 0, debugEnabled: false }));
    await mw.close();

    const provider = new OPFSStorageProvider();
    await provider.init();

    const chat = await provider.loadChat(CHAT_ID_1);
    expect(chat).not.toBeNull();
    const bId1 = chat!.root.items[0]!.attachments![0]!.binaryObjectId;
    const bId2 = chat!.root.items[0]!.replies.items[0]!.replies.items[0]!.attachments![0]!.binaryObjectId;
    expect(bId1).not.toBe(bId2);
    expect(bId1).not.toBe(VALID_UUID_1);
    expect(bId2).not.toBe(VALID_UUID_2);
  });

  it('should migrate all files if a single legacy attachment directory contains multiple entries', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    const legacyDir = await naidanDir.getDirectoryHandle('uploaded-files', { create: true });
    const attDir = await legacyDir.getDirectoryHandle(VALID_UUID_1, { create: true });
    
    // Multiple files in one folder (anomaly case)
    const f1 = await attDir.getFileHandle('file1.png', { create: true });
    const w1 = await (f1 as any).createWritable();
    await w1.write('DATA1');
    await w1.close();
    
    const f2 = await attDir.getFileHandle('file2.png', { create: true });
    const w2 = await (f2 as any).createWritable();
    await w2.write('DATA2');
    await w2.close();

    const provider = new OPFSStorageProvider();
    await provider.init();

    const binDir = await naidanDir.getDirectoryHandle('binary-objects');
    let binaryCount = 0;
    for (let i = 0; i < 256; i++) {
      const shard = i.toString(16).padStart(2, '0');
      try {
        const sDir = await binDir.getDirectoryHandle(shard);
        for await (const entry of sDir.values()) if (entry.name.endsWith('.bin')) binaryCount++;
      } catch { /* shard not created */ }
    }
    expect(binaryCount).toBe(2);
  });

  it('should append to the completed migrations list without affecting previous entries', async () => {
    const naidanDir = await mockRoot.getDirectoryHandle('naidan-storage', { create: true });
    const stateFile = await naidanDir.getFileHandle('migration-state.json', { create: true });
    const sw = await (stateFile as any).createWritable();
    await sw.write(JSON.stringify({
      completedMigrations: [{ name: 'legacy_cleanup', completedAt: 123456 }]
    }));
    await sw.close();

    const provider = new OPFSStorageProvider();
    await provider.init();

    const updatedState = JSON.parse(await (await (await naidanDir.getFileHandle('migration-state.json')).getFile()).text());
    expect(updatedState.completedMigrations).toHaveLength(2);
    expect(updatedState.completedMigrations[0].name).toBe('legacy_cleanup');
    expect(updatedState.completedMigrations[1].name).toBe('v1_uploaded_files_to_binary_objects');
  });
});
