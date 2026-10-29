import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPFSStorageProvider } from './opfs-storage';
import { idToRaw, toVolumeId } from '@/01-models/ids';
import type { Volume } from '@/01-models/types';

class TestFileHandle {
  readonly kind = 'file';
  content = '';
  readError: Error | undefined;
  writeError: Error | undefined;
  closeError: Error | undefined;
  abortCount = 0;

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  readonly name: string;

  async getFile(): Promise<File> {
    if (this.readError) {
      throw this.readError;
    }
    const content = this.content;
    return {
      name: this.name,
      text: async () => content,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    } as File;
  }

  async createWritable() {
    let content = '';
    return {
      write: async (data: unknown) => {
        if (this.writeError) {
          throw this.writeError;
        }
        if (typeof data === 'string') {
          content = data;
        } else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
          content = new TextDecoder().decode(data as ArrayBuffer);
        } else {
          throw new Error('Unsupported test data');
        }
      },
      close: async () => {
        if (this.closeError) {
          throw this.closeError;
        }
        this.content = content;
      },
      abort: async () => {
        this.abortCount++;
      },
    };
  }
}

class TestDirectoryHandle {
  readonly kind = 'directory';
  readonly children = new Map<string, TestDirectoryHandle | TestFileHandle>();
  readonly name: string;

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this as unknown as FileSystemHandle;
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<TestDirectoryHandle> {
    let child = this.children.get(name);
    if (child === undefined && options?.create) {
      child = new TestDirectoryHandle({ name });
      this.children.set(name, child);
    }
    if (child === undefined) {
      throw Object.assign(new Error('Directory not found'), { name: 'NotFoundError' });
    }
    if (child.kind !== 'directory') {
      throw new DOMException('Not a directory', 'TypeMismatchError');
    }
    return child;
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<TestFileHandle> {
    let child = this.children.get(name);
    if (child === undefined && options?.create) {
      child = new TestFileHandle({ name });
      this.children.set(name, child);
    }
    if (child === undefined) {
      throw Object.assign(new Error('File not found'), { name: 'NotFoundError' });
    }
    if (child.kind !== 'file') {
      throw new DOMException('Not a file', 'TypeMismatchError');
    }
    return child;
  }

  async removeEntry(name: string, _options?: FileSystemRemoveOptions): Promise<void> {
    if (!this.children.delete(name)) {
      throw Object.assign(new Error('Entry not found'), { name: 'NotFoundError' });
    }
  }

  async *values() {
    yield* this.children.values();
  }

  async *keys() {
    yield* this.children.keys();
  }
}

let root: TestDirectoryHandle;
let provider: OPFSStorageProvider;

function volume({ raw, name }: { raw: string, name: string }): Volume {
  return { id: toVolumeId({ raw }), name, type: 'opfs', createdAt: 123 };
}

async function shardDirectory({ shard }: { shard: string }): Promise<TestDirectoryHandle> {
  return await (await (await root.getDirectoryHandle('naidan-storage')).getDirectoryHandle('volumes')).getDirectoryHandle(shard);
}

async function publish({ target, volume: entry }: { target: OPFSStorageProvider, volume: Volume }): Promise<void> {
  const shard = await shardDirectory({ shard: idToRaw({ id: entry.id }).slice(-2).toLowerCase() });
  const captured = await shard.getDirectoryHandle(idToRaw({ id: entry.id }));
  await target.publishVolume({ volume: entry, root: captured as unknown as FileSystemDirectoryHandle });
}

async function listedVolumes({ target }: { target: OPFSStorageProvider }): Promise<Volume[]> {
  const volumes: Volume[] = [];
  for await (const entry of target.listVolumes()) {
    volumes.push(entry);
  }
  return volumes;
}

beforeEach(async () => {
  root = new TestDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  provider = new OPFSStorageProvider();
  await provider.init();
});

describe('OPFS volume publication', () => {
  it('probes an absent volume without creating volume directories', async () => {
    const volumeId = toVolumeId({ raw: 'missing-a1' });
    await expect(provider.probeVolumeAccess({ volumeId })).resolves.toEqual({ kind: 'missing', volumeId });
    expect((await root.getDirectoryHandle('naidan-storage')).children.has('volumes')).toBe(false);
    expect(await listedVolumes({ target: provider })).toEqual([]);
    expect((await root.getDirectoryHandle('naidan-storage')).children.has('volumes')).toBe(false);
  });

  it('rejects a captured root removed by a peer clear without recreating its metadata', async () => {
    const peer = new OPFSStorageProvider();
    await peer.init();
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    const captured = await provider.ensureVolumeDirectory({ volumeId: entry.id });

    await peer.clearAll();

    await expect(provider.publishVolume({ volume: entry, root: captured })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect((await root.getDirectoryHandle('naidan-storage')).children.has('volumes')).toBe(false);
    expect((await provider.probeVolumeAccess({ volumeId: entry.id })).kind).toBe('missing');
  });

  it('rejects an old captured root when a peer recreates the same volume path', async () => {
    const peer = new OPFSStorageProvider();
    await peer.init();
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    const captured = await provider.ensureVolumeDirectory({ volumeId: entry.id });
    await peer.clearAll();
    const replacement = await peer.ensureVolumeDirectory({ volumeId: entry.id });

    await expect(provider.publishVolume({ volume: entry, root: captured })).rejects.toMatchObject({ name: 'InvalidStateError' });
    const shard = await shardDirectory({ shard: 'a1' });
    expect(shard.children.has('index.json')).toBe(false);
    await peer.publishVolume({ volume: entry, root: replacement });
    expect(await listedVolumes({ target: peer })).toEqual([entry]);
  });

  it('keeps a peer clear behind an admitted publication until its index closes', async () => {
    const peer = new OPFSStorageProvider();
    await peer.init();
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    const captured = await provider.ensureVolumeDirectory({ volumeId: entry.id });
    const index = await (await shardDirectory({ shard: 'a1' })).getFileHandle('index.json', { create: true });
    index.content = '{"volumes":{}}';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeOpen = index.createWritable.bind(index);
    using _open = vi.spyOn(index, 'createWritable').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return nativeOpen();
    });
    const publishing = provider.publishVolume({ volume: entry, root: captured });
    await entered.promise;
    let cleared = false;
    const clearing = peer.clearAll().then(() => {
      cleared = true;
    });
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(cleared).toBe(false);
      expect((await root.getDirectoryHandle('naidan-storage')).children.has('volumes')).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([publishing, clearing]);
    }
    expect((await provider.probeVolumeAccess({ volumeId: entry.id })).kind).toBe('missing');
    expect((await root.getDirectoryHandle('naidan-storage')).children.has('volumes')).toBe(false);
  });

  it('waits for a peer clear before checking a captured root for publication', async () => {
    const peer = new OPFSStorageProvider();
    await peer.init();
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    const captured = await provider.ensureVolumeDirectory({ volumeId: entry.id });
    const storage = await root.getDirectoryHandle('naidan-storage');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const nativeRemove = storage.removeEntry.bind(storage);
    using _remove = vi.spyOn(storage, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === 'volumes') {
        entered.resolve();
        await release.promise;
      }
      await nativeRemove(name, options);
    });
    const clearing = peer.clearAll();
    await entered.promise;
    let publicationSettled = false;
    const publishing = provider.publishVolume({ volume: entry, root: captured }).finally(() => {
      publicationSettled = true;
    });
    const rejected = expect(publishing).rejects.toMatchObject({ name: 'NotFoundError' });
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(publicationSettled).toBe(false);
      expect((await shardDirectory({ shard: 'a1' })).children.has('index.json')).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([clearing, rejected]);
    }
    expect(storage.children.has('volumes')).toBe(false);
  });

  it('publishes linked-folder metadata without creating an OPFS volume root', async () => {
    const entry: Volume = { ...volume({ raw: 'linked-a1', name: 'Linked' }), type: 'host' };
    await provider.publishVolume({ volume: entry, root: undefined });

    expect(await listedVolumes({ target: provider })).toEqual([entry]);
    expect([...(await shardDirectory({ shard: 'a1' })).children.keys()]).toEqual(['index.json']);
  });

  it('leaves storage unchanged when deleting an absent volume', async () => {
    const volumeId = toVolumeId({ raw: 'missing-a1' });
    await provider.deleteVolume({ volumeId });
    expect((await root.getDirectoryHandle('naidan-storage')).children.has('volumes')).toBe(false);
  });

  it('keeps an unpublished normal root incomplete across provider recreation until publication', async () => {
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    await provider.ensureVolumeDirectory({ volumeId: entry.id });
    const shard = await shardDirectory({ shard: 'a1' });
    const directory = await shard.getDirectoryHandle('documents-a1');
    (await directory.getFileHandle('notes.txt', { create: true })).content = 'saved edit';

    const reloaded = new OPFSStorageProvider();
    await reloaded.init();
    expect((await reloaded.probeVolumeAccess({ volumeId: entry.id })).kind).toBe('incomplete');
    expect(await reloaded.getVolumeDirectoryHandle({ volumeId: entry.id })).toBeNull();
    expect(await listedVolumes({ target: reloaded })).toEqual([]);
    expect(shard.children.has('index.json')).toBe(false);

    await publish({ target: provider, volume: entry });
    await expect(reloaded.probeVolumeAccess({ volumeId: entry.id })).resolves.toMatchObject({ kind: 'native', volume: entry });
    expect(await listedVolumes({ target: reloaded })).toEqual([entry]);
    expect([...directory.children.keys()]).toEqual(['notes.txt']);
    expect([...shard.children.keys()].sort()).toEqual(['documents-a1', 'index.json']);
  });

  it.each(['{broken', '{"volumes":{"bad":{"type":"invalid"}}}'])('never overwrites an invalid index: %s', async content => {
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    await provider.ensureVolumeDirectory({ volumeId: entry.id });
    const shard = await shardDirectory({ shard: 'a1' });
    const index = await shard.getFileHandle('index.json', { create: true });
    index.content = content;

    await expect(provider.probeVolumeAccess({ volumeId: entry.id })).rejects.toThrow();
    await expect(publish({ target: provider, volume: entry })).rejects.toThrow();
    expect(index.content).toBe(content);
    expect(shard.children.has('documents-a1')).toBe(true);
  });

  it('propagates unreadable index errors instead of treating them as absence', async () => {
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    await provider.ensureVolumeDirectory({ volumeId: entry.id });
    const index = await (await shardDirectory({ shard: 'a1' })).getFileHandle('index.json', { create: true });
    index.content = '{"volumes":{}}';
    index.readError = new DOMException('Access denied', 'NotAllowedError');

    await expect(provider.probeVolumeAccess({ volumeId: entry.id })).rejects.toThrow('Access denied');
    await expect(publish({ target: provider, volume: entry })).rejects.toThrow('Access denied');
    expect(index.content).toBe('{"volumes":{}}');
  });

  it('preserves simultaneous same-shard publications from different providers', async () => {
    const second = new OPFSStorageProvider();
    await second.init();
    const entries = [volume({ raw: 'first-a1', name: 'First' }), volume({ raw: 'second-a1', name: 'Second' })];
    await Promise.all(entries.map(entry => provider.ensureVolumeDirectory({ volumeId: entry.id })));
    await Promise.all(entries.map((entry, index) => publish({ target: index === 0 ? provider : second, volume: entry })));

    expect((await listedVolumes({ target: provider })).map(entry => idToRaw({ id: entry.id })).sort()).toEqual(['first-a1', 'second-a1']);
  });

  it('uses the same index lock for publication, rename, and deletion', async () => {
    const entries = ['first-a1', 'second-a1', 'third-a1'].map(raw => volume({ raw, name: raw }));
    await Promise.all(entries.map(entry => provider.ensureVolumeDirectory({ volumeId: entry.id })));
    await publish({ target: provider, volume: entries[0]! });
    await publish({ target: provider, volume: entries[1]! });
    await Promise.all([
      provider.renameVolume({ volumeId: entries[0]!.id, name: 'Renamed' }),
      provider.deleteVolume({ volumeId: entries[1]!.id }),
      publish({ target: provider, volume: entries[2]! }),
    ]);

    const volumes = await listedVolumes({ target: provider });
    expect(volumes).toHaveLength(2);
    expect(volumes).toContainEqual({ ...entries[0]!, name: 'Renamed' });
    expect(volumes).toContainEqual(entries[2]);
  });

  it('removes only explicitly selected unpublished data and refuses published folders', async () => {
    const first = volume({ raw: 'first-a1', name: 'First' });
    const second = volume({ raw: 'second-a1', name: 'Second' });
    await provider.ensureVolumeDirectory({ volumeId: first.id });
    await provider.ensureVolumeDirectory({ volumeId: second.id });
    await publish({ target: provider, volume: second });
    await provider.deleteUnpublishedVolumeDirectory({ volumeId: first.id });
    await provider.deleteUnpublishedVolumeDirectory({ volumeId: first.id });

    await expect(provider.probeVolumeAccess({ volumeId: first.id })).resolves.toEqual({ kind: 'missing', volumeId: first.id });
    await expect(provider.deleteUnpublishedVolumeDirectory({ volumeId: second.id })).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect((await provider.probeVolumeAccess({ volumeId: second.id })).kind).toBe('native');
  });

  it.each(['write', 'close'] as const)('does not publish or discard copied data when index %s fails, and permits retry', async failure => {
    const entry = volume({ raw: 'documents-a1', name: 'Documents' });
    await provider.ensureVolumeDirectory({ volumeId: entry.id });
    const shard = await shardDirectory({ shard: 'a1' });
    const directory = await shard.getDirectoryHandle('documents-a1');
    (await directory.getFileHandle('notes.txt', { create: true })).content = 'saved edit';
    const index = await shard.getFileHandle('index.json', { create: true });
    index.content = '{"volumes":{}}';
    const error = new DOMException('Disk full', 'QuotaExceededError');
    if (failure === 'write') {
      index.writeError = error;
    } else {
      index.closeError = error;
    }

    await expect(publish({ target: provider, volume: entry })).rejects.toThrow('Disk full');
    expect((await provider.probeVolumeAccess({ volumeId: entry.id })).kind).toBe('incomplete');
    expect((await directory.getFileHandle('notes.txt')).content).toBe('saved edit');
    expect(index.abortCount).toBe(1);
    index.writeError = undefined;
    index.closeError = undefined;
    await publish({ target: provider, volume: entry });
    expect((await provider.probeVolumeAccess({ volumeId: entry.id })).kind).toBe('native');
  });

  it('keeps the eager file import API complete on return', async () => {
    const file = {
      arrayBuffer: async () => new TextEncoder().encode('original').buffer,
    } as File;
    const entry = await provider.createVolumeFromFiles({ name: 'Documents', entries: [{ relativePath: 'nested/notes.txt', file }] });
    const access = await provider.probeVolumeAccess({ volumeId: entry.id });
    expect(access.kind).toBe('native');
    const shard = await shardDirectory({ shard: idToRaw({ id: entry.id }).slice(-2).toLowerCase() });
    const directory = await shard.getDirectoryHandle(idToRaw({ id: entry.id }));
    expect((await (await directory.getDirectoryHandle('nested')).getFileHandle('notes.txt')).content).toBe('original');
  });

  it('keeps eager directory copies and empty child directories intact', async () => {
    const source = new TestDirectoryHandle({ name: 'Documents' });
    await source.getDirectoryHandle('empty', { create: true });
    (await source.getFileHandle('notes.txt', { create: true })).content = 'original';
    const entry = await provider.createVolume({ name: 'Documents', type: 'opfs', sourceHandle: source as unknown as FileSystemDirectoryHandle });
    const access = await provider.probeVolumeAccess({ volumeId: entry.id });
    expect(access.kind).toBe('native');
    const shard = await shardDirectory({ shard: idToRaw({ id: entry.id }).slice(-2).toLowerCase() });
    const directory = await shard.getDirectoryHandle(idToRaw({ id: entry.id }));
    expect((await directory.getFileHandle('notes.txt')).content).toBe('original');
    expect((await directory.getDirectoryHandle('empty')).children.size).toBe(0);
  });
});
