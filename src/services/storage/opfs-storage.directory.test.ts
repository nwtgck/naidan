import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';

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
      write: (data: string) => { this.content = data; return Promise.resolve(); },
      close: () => Promise.resolve(),
    });
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
        throw new Error(`Directory not found: ${name}`);
      }
    }
    const entry = this.entries.get(name);
    if (entry?.kind !== 'directory') throw new Error(`Entry is not a directory: ${name}`);
    return entry;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemFileHandle(name));
      } else {
        throw new Error(`File not found: ${name}`);
      }
    }
    const entry = this.entries.get(name);
    if (entry?.kind !== 'file') throw new Error(`Entry is not a file: ${name}`);
    return entry;
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    this.entries.delete(name);
  }

  async *keys() {
    for (const key of this.entries.keys()) {
      yield key;
    }
  }
}

const mockOpfsRoot = new MockFileSystemDirectoryHandle('opfs-root');

describe('OPFSStorageProvider Directory Isolation', () => {
  beforeEach(() => {
    mockOpfsRoot.entries.clear();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () => Promise.resolve(mockOpfsRoot),
      },
    });
  });

  it('should create and use "naidan-storage" directory within OPFS root', async () => {
    const provider = new OPFSStorageProvider();
    
    // Initial state: root is empty
    expect(mockOpfsRoot.entries.size).toBe(0);

    // After init, the storage directory should exist
    await provider.init();
    expect(mockOpfsRoot.entries.has('naidan-storage')).toBe(true);
    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;
    expect(storageDir.kind).toBe('directory');

    // Saving settings should put the file inside the subdirectory, NOT the root
    await provider.saveSettings({
      endpointType: 'openai',
      autoTitleEnabled: true,
      storageType: 'opfs',
      providerProfiles: [],
    });

    expect(mockOpfsRoot.entries.has('settings.json')).toBe(false);
    expect(storageDir.entries.has('settings.json')).toBe(true);
  });

  it('should only clear contents within the "naidan-storage" directory', async () => {
    const provider = new OPFSStorageProvider();
    await provider.init();
    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;

    // Manually add a file to root (outside our app's control)
    mockOpfsRoot.entries.set('other-app-data.txt', new MockFileSystemFileHandle('other-app-data.txt'));
    
    // Save some app data
    await provider.saveSettings({
      endpointType: 'openai',
      autoTitleEnabled: true,
      storageType: 'opfs',
      providerProfiles: [],
    });

    expect(storageDir.entries.size).toBeGreaterThan(0);
    expect(mockOpfsRoot.entries.has('other-app-data.txt')).toBe(true);

    // Clear all
    await provider.clearAll();

    // App data should be gone from the subdirectory
    expect(storageDir.entries.size).toBe(0);
    
    // Subdirectory itself should still exist (or be re-created by init/clearAll logic)
    // Actually clearAll in opfs-storage.ts currently does:
    // for await (const key of this.root!.keys()) { await this.root!.removeEntry(key, ...); }
    // Since this.root is the SUBDIRECTORY, it clears contents of the subdirectory.
    
    // The file in the OPFS root should remain untouched
    expect(mockOpfsRoot.entries.has('other-app-data.txt')).toBe(true);
  });
});
