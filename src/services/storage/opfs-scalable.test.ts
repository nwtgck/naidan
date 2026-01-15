import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';
import type { Chat } from '../../models/types';
import { v7 as uuidv7 } from 'uuid';

// --- Mocks for OPFS ---
class MockFileSystemFileHandle {
  kind = 'file' as const;
  constructor(public name: string, private content: string = '') {}
  async getFile() {
    // Return an object that looks like a File/Blob with a text() method
    return { 
      text: async () => this.content 
    };
  }
  async createWritable() {
    return {
      write: async (data: string) => { this.content = data; },
      close: async () => {},
    };
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  public entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();
  
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name) && options?.create) {
      this.entries.set(name, new MockFileSystemDirectoryHandle(name));
    }
    const entry = this.entries.get(name);
    return entry as MockFileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name) && options?.create) {
      this.entries.set(name, new MockFileSystemFileHandle(name));
    }
    const entry = this.entries.get(name);
    return entry as MockFileSystemFileHandle;
  }

  async removeEntry(name: string) {
    this.entries.delete(name);
  }

  async *keys() {
    for (const key of this.entries.keys()) {
      yield key;
    }
  }
}

const mockOpfsRoot = new MockFileSystemDirectoryHandle('opfs-root');

describe('OPFSStorageProvider Scalability (Split Storage)', () => {
  let provider: OPFSStorageProvider;

  beforeEach(async () => {
    mockOpfsRoot.entries.clear();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () => Promise.resolve(mockOpfsRoot),
      },
    });
    provider = new OPFSStorageProvider();
    await provider.init();
  });

  it('should split chat into meta index and content file on save', async () => {
    const chatId = uuidv7();
    const mockChat: Chat = {
      id: chatId,
      title: 'Large Chat',
      root: { 
        items: [{
          id: uuidv7(),
          role: 'user',
          content: 'Huge Content'.repeat(100),
          timestamp: Date.now(),
          replies: { items: [] }
        }]
      },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);

    // 1. Verify Meta Index (Should NOT contain message content)
    const storageDir = mockOpfsRoot.entries.get('naidan_storage') as MockFileSystemDirectoryHandle;
    const metaFile = storageDir.entries.get('chat_metas.json') as MockFileSystemFileHandle;
    const metaText = await (await metaFile.getFile()).text();
    const metaJson = JSON.parse(metaText);
    
    expect(metaJson.entries[0].id).toBe(chatId);
    expect(metaJson.entries[0].root).toBeUndefined(); // Important: Content should be stripped

    // 2. Verify Content File (Should contain message content)
    const contentsDir = storageDir.entries.get('chat_contents') as MockFileSystemDirectoryHandle;
    const contentFile = contentsDir.entries.get(`${chatId}.json`) as MockFileSystemFileHandle;
    const contentText = await (await contentFile.getFile()).text();
    const contentJson = JSON.parse(contentText);

    expect(contentJson.root.items[0].content).toContain('Huge Content');
  });

  it('should reassemble meta and content correctly on load', async () => {
    const chatId = uuidv7();
    const mockChat: Chat = {
      id: chatId,
      title: 'Join Test',
      root: { items: [{ id: uuidv7(), role: 'user', content: 'Hello', timestamp: 1, replies: { items: [] } }] },
      modelId: 'gpt-4',
      createdAt: 100,
      updatedAt: 200,
      debugEnabled: true,
    };

    await provider.saveChat(mockChat, 0);
    const loaded = await provider.loadChat(chatId);

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(chatId);
    expect(loaded?.title).toBe('Join Test');
    expect(loaded?.root.items[0]?.content).toBe('Hello');
  });

  it('should delete both meta entry and content file', async () => {
    const chatId = uuidv7();
    const mockChat: Chat = {
      id: chatId,
      title: 'Delete Me',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);
    
    const storageDir = mockOpfsRoot.entries.get('naidan_storage') as MockFileSystemDirectoryHandle;
    const contentsDir = storageDir.entries.get('chat_contents') as MockFileSystemDirectoryHandle;
    
    expect(contentsDir.entries.has(`${chatId}.json`)).toBe(true);

    await provider.deleteChat(chatId);

    // Verify metadata removed from index
    const metaFile = storageDir.entries.get('chat_metas.json') as MockFileSystemFileHandle;
    const metaText = await (await metaFile.getFile()).text();
    const metaJson = JSON.parse(metaText);
    expect(metaJson.entries.find((m: any) => m.id === chatId)).toBeUndefined();

    // Verify content file removed
    expect(contentsDir.entries.has(`${chatId}.json`)).toBe(false);
  });
});
