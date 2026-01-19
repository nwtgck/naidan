import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storageService } from './index';

describe('Storage Migration - Blob rescue via switchProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    
    // Mock navigator.storage with full directory handle simulation
    const entries = new Map();
    const mockRoot = {
      getDirectoryHandle: vi.fn().mockImplementation(async (name, opts) => {
        if (!entries.has(name) && opts?.create) {
          entries.set(name, createMockDir(name));
        }
        return entries.get(name);
      }),
      getFileHandle: vi.fn().mockImplementation(async (name, _opts) => {
        return createMockFile(name);
      }),
      removeEntry: vi.fn().mockResolvedValue(undefined),
      keys: async function* () { for (const k of entries.keys()) yield k; },
      values: async function* () { for (const v of entries.values()) yield v; },
    };

    function createMockFile(name: string) {
      let content = '{}';
      return {
        kind: 'file',
        name,
        createWritable: vi.fn().mockResolvedValue({
          write: vi.fn().mockImplementation(async (data) => { content = data; }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        getFile: vi.fn().mockImplementation(async () => ({
          text: async () => content,
        }))
      };
    }

    function createMockDir(name: string) {
      const subEntries = new Map();
      return {
        kind: 'directory',
        name,
        getDirectoryHandle: vi.fn().mockImplementation(async (n, _opts) => {
          if (!subEntries.has(n) && _opts?.create) subEntries.set(n, createMockDir(n));
          return subEntries.get(n);
        }),
        getFileHandle: vi.fn().mockImplementation(async (n, _opts) => {
          if (!subEntries.has(n) && _opts?.create) subEntries.set(n, createMockFile(n));
          return subEntries.get(n);
        }),
        removeEntry: vi.fn().mockResolvedValue(undefined),
        keys: async function* () { for (const k of subEntries.keys()) yield k; },
        values: async function* () { for (const v of subEntries.values()) yield v; },
      };
    }

    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(mockRoot) }
    });
  });

  it('should rescue memory blobs during switchProvider from Local to OPFS', async () => {
    // Force re-init to ensure we start fresh with LocalStorage
    await storageService.init('local');

    // Setup valid settings to avoid Zod validation errors during switchProvider
    await storageService.saveSettings({
      endpointType: 'openai',
      endpointUrl: 'http://localhost:11434',
      autoTitleEnabled: true,
      storageType: 'local',
      providerProfiles: []
    });
    
    const mockBlob = new Blob(['binary-content'], { type: 'image/png' });
    const chat = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Test',
      root: {
        items: [{
          id: '550e8400-e29b-41d4-a716-446655440001',
          role: 'user',
          content: 'text',
          timestamp: Date.now(),
          attachments: [{
            id: '550e8400-e29b-41d4-a716-446655440002',
            originalName: 'test.png',
            mimeType: 'image/png',
            size: 100,
            uploadedAt: Date.now(),
            status: 'memory',
            blob: mockBlob
          }],
          replies: { items: [] }
        }]
      },
      modelId: 'm1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    };
    
    await storageService.saveChat(chat as any, 0);
    await storageService.updateHierarchy((curr) => {
      curr.items.push({ type: 'chat', id: chat.id });
      return curr;
    });
    await storageService.switchProvider('opfs');
    
    const loadedChat = await storageService.loadChat('550e8400-e29b-41d4-a716-446655440000');
    expect(loadedChat).toBeDefined();
    const firstNode = loadedChat!.root.items[0]!;
    expect(firstNode).toBeDefined();
    expect(firstNode.attachments).toBeDefined();
    // In our test environment, switchProvider will rescue the blob and updated status should be persisted
    const firstAttachment = firstNode.attachments![0]!;
    expect(firstAttachment.status).toBe('persisted');
  });
});