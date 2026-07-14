import { generateId } from '@/01-models/id';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';
import type { Chat } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import type { ChatId, MessageId } from '@/01-models/ids';

// --- Mocks for OPFS ---
class MockFileSystemFileHandle {
  kind = 'file' as const;
  constructor(public name: string, private content: Blob = new Blob()) {}
  async getFile(): Promise<File> {
    return new File([this.content], this.name);
  }
  async createWritable() {
    return {
      write: async (data: BlobPart) => {
        this.content = new Blob([data]);
      },
      close: async () => {},
    };
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  public entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();

  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemDirectoryHandle(name));
      } else {
        const err = new Error(`Directory not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
    }
    const entry = this.entries.get(name);
    if (entry?.kind !== 'directory') throw new Error(`Not a directory: ${name}`);
    return entry as MockFileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemFileHandle(name));
      } else {
        const err = new Error(`File not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
    }
    const entry = this.entries.get(name);
    if (entry?.kind !== 'file') throw new Error(`Not a file: ${name}`);
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

  async *values() {
    for (const val of this.entries.values()) {
      yield val;
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
    const chatId = generateId<ChatId>();
    const mockChat: Chat = {
      id: chatId,
      title: 'Large Chat',
      root: {
        items: [{
          id: generateId<MessageId>(),
          role: 'user',
          content: 'Huge Content'.repeat(100),
          timestamp: Date.now(),
          replies: { items: [] },
        }],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };

    await provider.saveChatContent({ id: mockChat.id, content: mockChat });
    await provider.saveChatMeta({ meta: mockChat });

    // 1. Verify Meta File (Should NOT contain message content)
    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;
    const metaDir = storageDir.entries.get('chat-metas') as MockFileSystemDirectoryHandle;
    const metaFile = metaDir.entries.get(idToRaw({ id: chatId }) + '.json') as MockFileSystemFileHandle;
    const metaText = await (await metaFile.getFile()).text();
    const metaJson = JSON.parse(metaText);

    expect(metaJson.id).toBe(chatId);
    expect(metaJson.root).toBeUndefined(); // Important: Content should be stripped

    // 2. Verify Content File (Should contain message content)
    const contentsDir = storageDir.entries.get('chat-contents') as MockFileSystemDirectoryHandle;
    const contentFile = contentsDir.entries.get(idToRaw({ id: chatId }) + '.json') as MockFileSystemFileHandle;
    const contentText = await (await contentFile.getFile()).text();
    const contentJson = JSON.parse(contentText);

    expect(contentJson.root.items[0].content).toContain('Huge Content');
  });

  it('should reassemble meta and content correctly on load', async () => {
    const chatId = generateId<ChatId>();
    const mockChat: Chat = {
      id: chatId,
      title: 'Join Test',
      root: { items: [{ id: generateId<MessageId>(), role: 'user', content: 'Hello', timestamp: 1, replies: { items: [] } }] },
      createdAt: 100,
      updatedAt: 200,
      debugEnabled: true,
    };

    await provider.saveChatContent({ id: mockChat.id, content: mockChat });
    await provider.saveChatMeta({ meta: mockChat });
    const loaded = await provider.loadChat({ id: chatId });

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(chatId);
    expect(loaded?.title).toBe('Join Test');
    expect(loaded?.root.items[0]?.content).toBe('Hello');
  });

  it('should validate persisted sidebar DTOs before mapping experimental endpoints', async () => {
    const chatId = '123e4567-e89b-12d3-a456-426614174000';
    const groupId = '123e4567-e89b-12d3-a456-426614174001';
    const legacyEndpoint = {
      type: 'experimental_type',
      experimental: { type: 'prompt_api' },
    };
    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;
    const metaDir = await storageDir.getDirectoryHandle('chat-metas', { create: true });
    const groupDir = await storageDir.getDirectoryHandle('chat-groups', { create: true });
    const metaFile = await metaDir.getFileHandle(`${chatId}.json`, { create: true });
    const groupFile = await groupDir.getFileHandle(`${groupId}.json`, { create: true });

    const metaWriter = await metaFile.createWritable();
    await metaWriter.write(JSON.stringify({
      id: chatId,
      title: 'Legacy chat',
      createdAt: 1,
      updatedAt: 2,
      debugEnabled: false,
      endpoint: legacyEndpoint,
    }));
    await metaWriter.close();

    const groupWriter = await groupFile.createWritable();
    await groupWriter.write(JSON.stringify({
      id: groupId,
      name: 'Legacy group',
      updatedAt: 2,
      isCollapsed: false,
      endpoint: legacyEndpoint,
    }));
    await groupWriter.close();

    await provider.saveHierarchy({ hierarchy: {
      items: [
        { type: 'chat', id: chatId },
        { type: 'chat_group', id: groupId, chat_ids: [] },
      ],
    } });

    const snapshot = await provider.dump();

    expect(snapshot.structure.chatMetas[0]?.endpoint).toEqual({
      type: 'unsupported_experimental_endpoint',
      persistedType: 'prompt_api',
    });
    expect(snapshot.structure.chatGroups[0]?.endpoint).toEqual({
      type: 'unsupported_experimental_endpoint',
      persistedType: 'prompt_api',
    });
  });

  it('should delete both meta entry and content file', async () => {
    const chatId = generateId<ChatId>();
    const mockChat: Chat = {
      id: chatId,
      title: 'Delete Me',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };

    await provider.saveChatContent({ id: mockChat.id, content: mockChat });
    await provider.saveChatMeta({ meta: mockChat });

    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;
    const metaDir = storageDir.entries.get('chat-metas') as MockFileSystemDirectoryHandle;
    const contentsDir = storageDir.entries.get('chat-contents') as MockFileSystemDirectoryHandle;

    expect(metaDir.entries.has(idToRaw({ id: chatId }) + '.json')).toBe(true);
    expect(contentsDir.entries.has(idToRaw({ id: chatId }) + '.json')).toBe(true);

    await provider.deleteChat({ id: chatId });

    // Verify metadata removed
    expect(metaDir.entries.has(idToRaw({ id: chatId }) + '.json')).toBe(false);

    // Verify content file removed
    expect(contentsDir.entries.has(idToRaw({ id: chatId }) + '.json')).toBe(false);
  });

  describe('Hierarchy Persistence', () => {
    it('should save and load hierarchy from naidan-storage/hierarchy.json', async () => {
      const mockHierarchy = {
        items: [
          { type: 'chat' as const, id: '019bd241-2d57-716b-a9fd-1efbba88cfb1' },
          { type: 'chat_group' as const, id: '019bd241-2d57-716b-a9fd-1efbba88cfb2', chat_ids: ['019bd241-2d57-716b-a9fd-1efbba88cfb3'] },
        ],
      };

      await provider.saveHierarchy({ hierarchy: mockHierarchy });
      const loaded = await provider.loadHierarchy();
      expect(loaded).toEqual(mockHierarchy);

      const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;
      expect(storageDir.entries.has('hierarchy.json')).toBe(true);
    });

    it('should return empty items if hierarchy is missing', async () => {
      const loaded = await provider.loadHierarchy();
      expect(loaded).toEqual({ items: [] });
    });
  });
});
