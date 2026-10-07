import { afterEach, expect, it, vi } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';
import { MemoryStorageProvider } from './memory-storage';

const registry = { version: 1 as const, id: 'registry-example', connections: [] };
const filename = 'naidan-rpc-connections.json';
/** A writable buffers changes until close, as an OPFS replacement does. */
function opfsFixture() {
  const failures: { directoryLookup: Error | undefined, lookup: Error | undefined, read: Error | undefined, write: Error | undefined, close: Error | undefined } = {
    directoryLookup: undefined,
    lookup: undefined,
    read: undefined,
    write: undefined,
    close: undefined,
  };
  const aborted = vi.fn();
  class MockDirectory {
    readonly files = new Map<string, { content: string }>();
    readonly directories = new Map<string, MockDirectory>();
    readonly path: string;
    private state: 'available' | 'removed' = 'available';
    constructor({ path }: { path: string }) {
      this.path = path;
    }
    private checkAvailable(): void {
      if (this.state === 'removed') throw new DOMException('Removed directory', 'NotFoundError');
    }
    private markRemoved(): void {
      this.state = 'removed';
      for (const directory of this.directories.values()) directory.markRemoved();
    }
    getDirectoryHandle = vi.fn(async (name: string, options?: FileSystemGetDirectoryOptions): Promise<MockDirectory> => {
      this.checkAvailable();
      if (this.path === 'naidan-storage' && failures.directoryLookup) throw failures.directoryLookup;
      let directory = this.directories.get(name);
      if (!directory) {
        if (!options?.create) throw new DOMException('Missing directory', 'NotFoundError');
        directory = new MockDirectory({ path: this.path ? `${this.path}/${name}` : name });
        this.directories.set(name, directory);
      }
      return directory;
    });
    getFileHandle = vi.fn(async (name: string, options?: FileSystemGetFileOptions) => {
      this.checkAvailable();
      if (failures.lookup) throw failures.lookup;
      let file = this.files.get(name);
      if (!file) {
        if (!options?.create) throw new DOMException('Missing file', 'NotFoundError');
        file = { content: '' }; this.files.set(name, file);
      }
      const stored = file;
      return {
        getFile: async () => {
          this.checkAvailable();
          if (failures.read) throw failures.read;
          return { text: async () => stored.content };
        },
        createWritable: async () => {
          let pending = '';
          return {
            write: async (value: string) => {
              if (failures.write) throw failures.write;
              pending = value;
            },
            close: async () => {
              this.checkAvailable();
              if (failures.close) throw failures.close;
              stored.content = pending;
            },
            abort: aborted,
          };
        },
      };
    });
    removeEntry = vi.fn(async (name: string, options?: FileSystemRemoveOptions) => {
      this.checkAvailable();
      if (this.files.delete(name)) return;
      const directory = this.directories.get(name);
      if (!directory) throw new DOMException('Missing entry', 'NotFoundError');
      if (!options?.recursive && (directory.files.size || directory.directories.size)) throw new DOMException('Directory is not empty', 'InvalidModificationError');
      directory.markRemoved();
      this.directories.delete(name);
    });
    async *keys() {
      this.checkAvailable();
      yield* this.files.keys();
      yield* this.directories.keys();
    }
  }
  const root = new MockDirectory({ path: '' });
  const storage = new MockDirectory({ path: 'naidan-storage' });
  const directory = new MockDirectory({ path: 'naidan-storage/experimental' });
  root.directories.set('naidan-storage', storage);
  storage.directories.set('experimental', directory);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  return { files: directory.files, failures, aborted, root, storage, directory, provider: new OPFSStorageProvider() };
}
afterEach(() => vi.unstubAllGlobals());
it('stores the registry in the experimental directory under the Naidan OPFS root', async () => {
  const { provider, root, storage, files } = opfsFixture();
  expect(await provider.loadNaidanRpcRegistry()).toBeUndefined();
  await provider.saveNaidanRpcRegistry({ registry });
  expect(root.getDirectoryHandle).toHaveBeenCalledWith('naidan-storage', { create: true });
  expect(storage.getDirectoryHandle).toHaveBeenCalledWith('experimental', { create: false });
  expect(storage.getDirectoryHandle).toHaveBeenCalledWith('experimental', { create: true });
  expect(storage.files.size).toBe(0);
  expect([...files.keys()]).toEqual([filename]);
  expect(await provider.loadNaidanRpcRegistry()).toEqual(registry);
});
it('does not create a missing experimental directory when reading or removing the registry', async () => {
  const { provider, storage } = opfsFixture();
  await storage.removeEntry('experimental', { recursive: true });
  expect(await provider.loadNaidanRpcRegistry()).toBeUndefined();
  await provider.saveNaidanRpcRegistry({ registry: undefined });
  expect(storage.directories.has('experimental')).toBe(false);
  expect(storage.getDirectoryHandle.mock.calls).toEqual([
    ['experimental', { create: false }],
    ['experimental', { create: false }],
  ]);
});
it('creates the experimental directory on the first registry save', async () => {
  const { provider, storage } = opfsFixture();
  await storage.removeEntry('experimental', { recursive: true });
  await provider.saveNaidanRpcRegistry({ registry });
  expect(storage.directories.get('experimental')?.files.get(filename)?.content).toBe(JSON.stringify(registry));
  expect(await provider.loadNaidanRpcRegistry()).toEqual(registry);
});
it('validates the registry before creating its directory', async () => {
  const { provider, storage } = opfsFixture();
  await storage.removeEntry('experimental', { recursive: true });
  await expect(provider.saveNaidanRpcRegistry({ registry: { ...registry, id: 'bad' } })).rejects.toThrow();
  expect(storage.directories.has('experimental')).toBe(false);
});
it('propagates directory access failures for reads, writes and removals', async () => {
  const { provider, failures } = opfsFixture();
  failures.directoryLookup = new DOMException('Directory denied', 'NotAllowedError');
  await expect(provider.loadNaidanRpcRegistry()).rejects.toThrow('Directory denied');
  await expect(provider.saveNaidanRpcRegistry({ registry })).rejects.toThrow('Directory denied');
  await expect(provider.saveNaidanRpcRegistry({ registry: undefined })).rejects.toThrow('Directory denied');
});
it('leaves the old root-level registry untouched without reading or migrating it', async () => {
  const { provider, storage, files } = opfsFixture();
  const oldFilename = 'experimental-naidan-rpc-connections.json';
  const oldContent = JSON.stringify({ ...registry, id: 'old-registry-example' });
  storage.files.set(oldFilename, { content: oldContent });
  expect(await provider.loadNaidanRpcRegistry()).toBeUndefined();
  await provider.saveNaidanRpcRegistry({ registry });
  expect(JSON.parse(files.get(filename)!.content)).toEqual(registry);
  await provider.saveNaidanRpcRegistry({ registry: undefined });
  expect(storage.files.get(oldFilename)?.content).toBe(oldContent);
  expect(storage.getFileHandle).not.toHaveBeenCalled();
});
it('removes only the registry and preserves the shared experimental directory and image data', async () => {
  const { provider, storage, directory, files } = opfsFixture();
  const images = await directory.getDirectoryHandle('image-generation', { create: true });
  images.files.set('catalog.json', { content: 'image catalog' });
  await provider.saveNaidanRpcRegistry({ registry });
  await provider.saveNaidanRpcRegistry({ registry: undefined });
  await provider.saveNaidanRpcRegistry({ registry: undefined });
  expect(files.has(filename)).toBe(false);
  expect(storage.directories.get('experimental')).toBe(directory);
  expect(directory.directories.get('image-generation')?.files.get('catalog.json')?.content).toBe('image catalog');
  expect(await provider.loadNaidanRpcRegistry()).toBeUndefined();
});
it('reopens the experimental directory after clearing all storage', async () => {
  const { provider, storage, directory } = opfsFixture();
  await provider.saveNaidanRpcRegistry({ registry });
  await provider.clearAll();
  expect(storage.directories.size).toBe(0);
  expect(await provider.loadNaidanRpcRegistry()).toBeUndefined();
  expect(storage.directories.size).toBe(0);
  const replacement = { ...registry, id: 'replacement-example' };
  await provider.saveNaidanRpcRegistry({ registry: replacement });
  expect(storage.directories.get('experimental')).not.toBe(directory);
  expect(await provider.loadNaidanRpcRegistry()).toEqual(replacement);
});
it('does not turn access failures or failures after lookup into an empty registry', async () => {
  const { provider, failures, files } = opfsFixture();
  failures.lookup = new DOMException('Denied', 'NotAllowedError');
  await expect(provider.loadNaidanRpcRegistry()).rejects.toThrow('Denied');
  failures.lookup = undefined; files.set(filename, { content: JSON.stringify(registry) });
  failures.read = new DOMException('Removed after lookup', 'NotFoundError');
  await expect(provider.loadNaidanRpcRegistry()).rejects.toThrow('Removed after lookup');
});
it('rejects corrupted content without replacing it', async () => {
  const { provider, files } = opfsFixture(); files.set(filename, { content: '{' });
  await expect(provider.loadNaidanRpcRegistry()).rejects.toThrow();
  expect(files.get(filename)?.content).toBe('{');
});
it('aborts a failed replacement and preserves the previously committed registry', async () => {
  const { provider, failures, files, aborted } = opfsFixture();
  await provider.saveNaidanRpcRegistry({ registry }); failures.close = new Error('close failed');
  await expect(provider.saveNaidanRpcRegistry({ registry: { ...registry, id: 'replacement-example' } })).rejects.toThrow('close failed');
  expect(aborted).toHaveBeenCalledOnce(); expect(JSON.parse(files.get(filename)!.content)).toEqual(registry);
});
it('removes a newly created empty file after the first save fails, allowing retry', async () => {
  const { provider, failures, files } = opfsFixture(); failures.write = new Error('quota');
  await expect(provider.saveNaidanRpcRegistry({ registry })).rejects.toThrow('quota');
  expect(files.has(filename)).toBe(false); expect(await provider.loadNaidanRpcRegistry()).toBeUndefined();
  failures.write = undefined; await provider.saveNaidanRpcRegistry({ registry });
  expect(await provider.loadNaidanRpcRegistry()).toEqual(registry);
});
it('keeps memory registries private to a provider instance and clears them with the other data', async () => {
  const first = new MemoryStorageProvider(), other = new MemoryStorageProvider();
  await first.saveNaidanRpcRegistry({ registry });
  const loaded = await first.loadNaidanRpcRegistry(); if (!loaded) throw new Error('Registry missing');
  loaded.id = 'mutated-example';
  expect((await first.loadNaidanRpcRegistry())?.id).toBe(registry.id);
  expect(await other.loadNaidanRpcRegistry()).toBeUndefined();
  await first.clearAll(); expect(await first.loadNaidanRpcRegistry()).toBeUndefined();
});
