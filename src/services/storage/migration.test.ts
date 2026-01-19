import { describe, it, expect, vi } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import type { Chat, ChatGroup, Settings } from '../../models/types';
import type { MigrationChunkDto } from '../../models/dto';

// --- Mocks for OPFS ---
class MockFileSystemFileHandle {
  kind = 'file' as const;
  constructor(public name: string, private content: string = '') {}
  getFile() {
    return Promise.resolve({
      text: () => Promise.resolve(this.content),
    });
  }
  createWritable() {
    return Promise.resolve({
      write: (data: string) => { this.content = data; Promise.resolve(); },
      close: () => Promise.resolve(),
    });
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  private entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();
  
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemDirectoryHandle(name));
      } else {
        throw new Error('Directory not found');
      }
    }
    return this.entries.get(name);
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemFileHandle(name));
      } else {
        throw new Error('File not found');
      }
    }
    return this.entries.get(name);
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    this.entries.delete(name);
  }

  // async generator for values()
  async *values() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  // async generator for keys()
  async *keys() {
    for (const key of this.entries.keys()) {
      yield key;
    }
  }
}

const mockRoot = new MockFileSystemDirectoryHandle('root');
// Mock global navigator.storage
const mockNavigatorStorage = {
  getDirectory: () => Promise.resolve(mockRoot),
};
vi.stubGlobal('navigator', { storage: mockNavigatorStorage });


// --- Test Data ---
const mockChat: Chat = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  title: 'Test Chat',
  root: { items: [] },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  systemPrompt: undefined,
  debugEnabled: false,
};

const mockChatGroup: ChatGroup = {
  id: '987fcdeb-51a2-43d1-9456-426614174000',
  name: 'Test Group',
  updatedAt: Date.now(),
  items: [],
  isCollapsed: false,
};

const mockSettings: Settings = {
  endpointType: 'openai',
  endpointUrl: undefined,
  endpointHttpHeaders: undefined,
  autoTitleEnabled: true,
  storageType: 'local',
  providerProfiles: [],
};

// --- Test Suite ---

describe('Storage Migration (Round-Trip)', () => {

  const runRoundTripTest = async (provider: LocalStorageProvider | OPFSStorageProvider) => {
    // 1. Setup Data
    await provider.init();
    await provider.clearAll();
    await provider.saveSettings(mockSettings);
    await provider.saveChatGroup(mockChatGroup);
    // Link chat to chat group to test relationships? 
    // For simplicity, just saving them individually first.
    // Ideally we should test the relationship preservation but DTOs handle IDs.
    await provider.saveChat(mockChat, 0);

    // 2. Dump
    const dumpStream = provider.dump();
    const chunks: MigrationChunkDto[] = [];
    for await (const chunk of dumpStream) {
      chunks.push(chunk);
    }

    // Verify dump content minimally
    expect(chunks.find(c => c.type === 'settings')).toBeDefined();
    expect(chunks.find(c => c.type === 'chat_group')).toBeDefined();
    expect(chunks.find(c => c.type === 'chat')).toBeDefined();

    // 3. Clear (Simulate fresh install)
    await provider.clearAll();
    const emptyChats = await provider.listChats();
    expect(emptyChats).toHaveLength(0);

    // 4. Restore
    async function* arrayToGenerator(array: MigrationChunkDto[]) {
      for (const item of array) yield item;
    }
    await provider.restore(arrayToGenerator(chunks));

    // 5. Verify Data Integrity
    const loadedSettings = await provider.loadSettings();
    expect(loadedSettings).toEqual(mockSettings);

    const chatGroups = await provider.listChatGroups();
    expect(chatGroups).toHaveLength(1);
    expect(chatGroups[0]?.id).toBe(mockChatGroup.id);
    expect(chatGroups[0]?.name).toBe(mockChatGroup.name);
    
    // Check Chat
    const loadedChat = await provider.loadChat(mockChat.id);
    expect(loadedChat).toEqual(mockChat);
  };

  describe('LocalStorageProvider', () => {
    it('should pass dump-restore round trip', async () => {
      localStorage.clear();
      const provider = new LocalStorageProvider();
      await runRoundTripTest(provider);
    });
  });

  describe('OPFSStorageProvider', () => {
    it('should pass dump-restore round trip', async () => {
      // Clear mock OPFS
      // @ts-expect-error: Accessing private property for testing
      mockRoot.entries.clear(); 
      const provider = new OPFSStorageProvider();
      await runRoundTripTest(provider);
    });
  });

});
