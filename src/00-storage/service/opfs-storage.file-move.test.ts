// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile, type MemoryMoves } from '@/utils/file-system-publication/memory.test-support';
import { toBinaryObjectId } from '@/01-models/ids';
import { BinaryShardIndexSchemaDto } from '@/00-storage/00-dto/dto';
import { OPFSStorageProvider } from './opfs-storage';

const rawId = 'file-aa';
const binaryObjectId = toBinaryObjectId({ raw: rawId });
const save = { binaryObjectId, blob: new Blob(['new body']), name: 'image.png', mimeType: 'image/png' };
let root: MemoryDirectory, moves: MemoryMoves, provider: OPFSStorageProvider;

beforeEach(async () => {
  moves = { calls: [] };
  root = new MemoryDirectory('root', moves);
  provider = new OPFSStorageProvider();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await provider.init();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function shard(): Promise<MemoryDirectory> {
  return (await (await root.getDirectoryHandle('naidan-storage', { create: true })).getDirectoryHandle('binary-objects', { create: true })).getDirectoryHandle('aa', { create: true });
}

async function published(): Promise<MemoryDirectory> {
  return (await shard()).getDirectoryHandle('.move', { create: true });
}

async function index() {
  return BinaryShardIndexSchemaDto.parse(JSON.parse(await (await (await shard()).getFileHandle('index.json')).getFile().then(file => file.text())));
}

async function contents({ name, area }: { name: string, area: 'legacy' | 'move' }): Promise<string> {
  const directory = area === 'move' ? await published() : await shard();
  return (await (await directory.getFileHandle(name)).getFile()).text();
}

async function listed() {
  const result = [];
  for await (const entry of provider.listBinaryObjects()) {
    result.push(entry);
  }
  return result;
}

describe('binary object move publication without DTO changes', () => {
  it('commits the original index before .bin.tmp moves, then reads without probing', async () => {
    let sawStaged = false;
    moves.beforeMove = async ({ to }) => {
      if (to === `${rawId}.bin`) {
        sawStaged = true;
        expect((await index()).objects[rawId]?.size).toBe(save.blob.size);
        expect((await published()).children.has(`${rawId}.bin.tmp`)).toBe(true);
        expect((await published()).children.has(`${rawId}.bin`)).toBe(false);
      }
    };
    await provider.saveFile(save);
    expect(sawStaged).toBe(true);
    expect([...((await shard()).children.keys())].sort()).toEqual(['.move', 'index.json']);
    expect([...((await published()).children.keys())]).toEqual([`${rawId}.bin`]);
    const rawIndex = JSON.parse(await contents({ name: 'index.json', area: 'legacy' }));
    expect(Object.keys(rawIndex)).toEqual(['objects']);
    const probeCalls = moves.calls.length;
    const reader = new OPFSStorageProvider();
    await reader.init();
    expect(await (await reader.getFile({ binaryObjectId }))?.text()).toBe('new body');
    expect((await reader.getFile({ binaryObjectId }))?.type).toBe('image/png');
    expect(moves.calls).toHaveLength(probeCalls);
  });

  it('replaces an explicitly saved ID while preserving its old .complete', async () => {
    await provider.saveFile({ ...save, blob: new Blob(['old']) });
    const directory = await shard();
    const marker = await directory.getFileHandle(`.${rawId}.bin.complete`, { create: true });
    marker.data = new TextEncoder().encode('historical marker');
    await provider.saveFile(save);
    expect(await contents({ name: `.${rawId}.bin.complete`, area: 'legacy' })).toBe('historical marker');
    expect(await contents({ name: `${rawId}.bin`, area: 'move' })).toBe('new body');
    expect(moves.calls.filter(call => call.from.endsWith('.bin.tmp'))).toHaveLength(2);
    expect(moves.calls.filter(call => !call.from.endsWith('.bin.tmp'))).toHaveLength(1);
  });

  it('does not reveal an old completed body with new metadata after a failed replacement', async () => {
    await provider.saveFile({ ...save, blob: new Blob(['old']) });
    moves.beforeMove = ({ to }) => {
      if (to === `${rawId}.bin`) {
        throw new DOMException('Locked', 'NoModificationAllowedError');
      }
    };
    await expect(provider.saveFile(save)).rejects.toThrow('Locked');
    expect(await contents({ name: `${rawId}.bin`, area: 'move' })).toBe('old');
    expect(await contents({ name: `${rawId}.bin.tmp`, area: 'move' })).toBe('new body');
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
    expect(await provider.getBinaryObject({ binaryObjectId })).toBeNull();
    expect(await listed()).toEqual([]);
    moves.beforeMove = undefined;
    await provider.saveFile(save);
    expect(await (await provider.getFile({ binaryObjectId }))?.text()).toBe('new body');
  });

  it('keeps staging unpublished when index commit fails, then permits an explicit retry', async () => {
    const directory = await shard();
    const metadata = await directory.getFileHandle('index.json', { create: true });
    metadata.data = new TextEncoder().encode('{"objects":{}}');
    metadata.failWrite = true;
    await expect(provider.saveFile(save)).rejects.toThrow('Quota exceeded');
    expect(await contents({ name: `${rawId}.bin.tmp`, area: 'move' })).toBe('new body');
    expect((await published()).children.has(`${rawId}.bin`)).toBe(false);
    expect((await index()).objects).toEqual({});
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
    expect(directory.children.has(`.${rawId}.bin.complete`)).toBe(false);
    metadata.failWrite = false;
    await provider.saveFile(save);
    expect(await (await provider.getFile({ binaryObjectId }))?.text()).toBe('new body');
  });

  it('already has usable metadata if execution stops immediately after the native move', async () => {
    moves.afterMove = ({ to }) => {
      if (to === `${rawId}.bin`) {
        throw new Error('Stopped after rename');
      }
    };
    await expect(provider.saveFile(save)).rejects.toThrow('Stopped after rename');
    const reader = new OPFSStorageProvider();
    await reader.init();
    expect(await (await reader.getFile({ binaryObjectId }))?.text()).toBe('new body');
    expect((await reader.getBinaryObject({ binaryObjectId }))?.size).toBe(save.blob.size);
    expect((await published()).children.has(`${rawId}.bin.tmp`)).toBe(false);
  });

  it('does not let a legacy .complete bypass an interrupted migration', async () => {
    root = new MemoryDirectory('legacy');
    provider = new OPFSStorageProvider();
    await provider.init();
    await provider.saveFile({ ...save, blob: new Blob(['old']) });
    const directory = await shard();
    await directory.removeEntry('.move'); // An unsupported probe left an empty namespace.
    const upgraded = new MemoryDirectory('aa', moves);
    upgraded.children = directory.children;
    (await (await root.getDirectoryHandle('naidan-storage')).getDirectoryHandle('binary-objects')).children.set('aa', upgraded);
    provider = new OPFSStorageProvider();
    await provider.init();
    moves.beforeMove = ({ to }) => {
      if (to === `${rawId}.bin`) {
        throw new Error('Interrupted');
      }
    };
    await expect(provider.saveFile(save)).rejects.toThrow('Interrupted');
    expect(upgraded.children.has(`.${rawId}.bin.complete`)).toBe(true);
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
    moves.beforeMove = undefined;
    await provider.saveFile(save);
    expect(upgraded.children.has(`.${rawId}.bin.complete`)).toBe(true);
    expect(await contents({ name: `${rawId}.bin`, area: 'legacy' })).toBe('old');
    expect(await (await provider.getFile({ binaryObjectId }))?.text()).toBe('new body');
  });

  it('preserves unowned legacy temporary files and never overwrites malformed indexes', async () => {
    const directory = await shard();
    const temporary = await directory.getFileHandle(`${rawId}.bin.tmp`, { create: true });
    temporary.data = new TextEncoder().encode('unowned');
    await provider.saveFile(save);
    expect(temporary.data).toEqual(new TextEncoder().encode('unowned'));
    const bad = await directory.getFileHandle('index.json');
    bad.data = new TextEncoder().encode('{bad');
    await expect(provider.saveFile(save)).rejects.toThrow();
    await expect(provider.deleteBinaryObject({ binaryObjectId })).rejects.toThrow();
    expect(await contents({ name: 'index.json', area: 'legacy' })).toBe('{bad');
    expect(directory.children.has(`${rawId}.bin.tmp`)).toBe(true);
    expect(await contents({ name: `${rawId}.bin`, area: 'move' })).toBe('new body');
  });

  it('removes its interrupted staging only during explicit object deletion', async () => {
    moves.beforeMove = ({ to }) => {
      if (to === `${rawId}.bin`) {
        throw new Error('Interrupted');
      }
    };
    await expect(provider.saveFile(save)).rejects.toThrow('Interrupted');
    const directory = await published();
    const foreign = new MemoryFile('other.bin.tmp');
    directory.children.set(foreign.name, foreign);
    await provider.deleteBinaryObject({ binaryObjectId });
    expect([...directory.children.keys()]).toEqual([foreign.name]);
    expect((await index()).objects).toEqual({});
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
  });

  it('cleans up only its failed first index write and preserves staging for retry', async () => {
    const directory = await shard();
    const original = MemoryFile.prototype.createWritable;
    let failed = false;
    using interception = vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile, options) {
      if (this.name === 'index.json' && !failed) {
        failed = true;
        throw new DOMException('Full', 'QuotaExceededError');
      }
      return original.call(this, options);
    });
    await expect(provider.saveFile(save)).rejects.toThrow('Full');
    expect(interception).toHaveBeenCalled();
    expect(directory.children.has('index.json')).toBe(false);
    expect((await published()).children.has(`${rawId}.bin.tmp`)).toBe(true);
    await provider.saveFile(save);
    expect(await (await provider.getFile({ binaryObjectId }))?.text()).toBe('new body');
  });

  it('preserves the existing body and index but hides it if replacement metadata cannot be committed', async () => {
    await provider.saveFile({ ...save, blob: new Blob(['old']) });
    const manifest = await (await shard()).getFileHandle('index.json');
    const previous = await contents({ name: 'index.json', area: 'legacy' });
    manifest.failWrite = true;
    await expect(provider.saveFile(save)).rejects.toThrow('Quota exceeded');
    expect(await contents({ name: `${rawId}.bin`, area: 'move' })).toBe('old');
    expect((await published()).children.has(`${rawId}.bin.tmp`)).toBe(true);
    expect(await contents({ name: 'index.json', area: 'legacy' })).toBe(previous);
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
  });

  it('retains the old marker protocol when move is unsupported', async () => {
    moves.beforeMove = () => {
      throw new DOMException('Unavailable', 'NotSupportedError');
    };
    await provider.saveFile(save);
    expect((await shard()).children.has(`.${rawId}.bin.complete`)).toBe(true);
    expect(Object.keys(await index())).toEqual(['objects']);
    expect((await index()).experimental).toBeUndefined();
    expect(await (await provider.getFile({ binaryObjectId }))?.text()).toBe('new body');
  });

  it('does not downgrade a moved object to direct final writes', async () => {
    await provider.saveFile(save);
    provider = new OPFSStorageProvider();
    await provider.init();
    moves.beforeMove = () => {
      throw new DOMException('Unavailable', 'NotSupportedError');
    };
    await expect(provider.saveFile({ ...save, blob: new Blob(['replacement']) })).rejects.toThrow('requires file move');
    expect(await contents({ name: `${rawId}.bin`, area: 'move' })).toBe('new body');
    expect((await shard()).children.has(`.${rawId}.bin.complete`)).toBe(false);
  });

  it('does not recognize a markerless legacy file just because the old index has the same size', async () => {
    await provider.saveFile(save);
    const directory = await shard();
    const moved = await published();
    const legacy = await directory.getFileHandle(`${rawId}.bin`, { create: true });
    legacy.data = new TextEncoder().encode('bad body');
    await moved.removeEntry(`${rawId}.bin`);
    expect((await index()).objects[rawId]?.size).toBe(legacy.data.length);
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
  });

  it('requires matching index metadata for a moved file', async () => {
    await provider.saveFile(save);
    (await (await shard()).getFileHandle('index.json')).data = new TextEncoder().encode('{"objects":{}}');
    expect(await provider.getFile({ binaryObjectId })).toBeNull();
  });

  it('serializes readers behind a publication instead of mixing an old index and new body', async () => {
    await provider.saveFile({ ...save, blob: new Blob(['old']), mimeType: 'text/plain' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    moves.beforeMove = async ({ to }) => {
      if (to === `${rawId}.bin`) {
        entered.resolve();
        await release.promise;
      }
    };
    const saving = provider.saveFile(save);
    await using paused = {
      entered: entered.promise,
      async [Symbol.asyncDispose]() {
        release.resolve();
        await saving.catch(() => undefined);
      },
    };
    await paused.entered;
    let readFinished = false;
    const reading = provider.getFile({ binaryObjectId }).then(file => {
      readFinished = true;
      return file;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release.resolve();
    await saving;
    const file = await reading;
    expect(await file?.text()).toBe('new body');
    expect(file?.type).toBe('image/png');
  });

  it('preserves both entries when two providers save different IDs in the same shard', async () => {
    const second = new OPFSStorageProvider();
    await second.init();
    const otherId = toBinaryObjectId({ raw: 'second-aa' });
    await Promise.all([provider.saveFile(save), second.saveFile({ ...save, binaryObjectId: otherId, blob: new Blob(['second']) })]);
    expect(Object.keys((await index()).objects).sort()).toEqual(['file-aa', 'second-aa']);
    expect(await (await provider.getFile({ binaryObjectId: otherId }))?.text()).toBe('second');
    expect(await (await provider.getFile({ binaryObjectId }))?.text()).toBe('new body');
  });

  it('exports each body with metadata read under the same publication lock', async () => {
    const otherId = toBinaryObjectId({ raw: 'second-aa' });
    await provider.saveFile(save);
    await provider.saveFile({ ...save, binaryObjectId: otherId, blob: new Blob(['old']), name: 'old.txt', mimeType: 'text/plain' });
    const snapshot = await provider.dump();
    const stream = snapshot.contentStream[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.value?.type).toBe('binary_object');
    await provider.saveFile({ ...save, binaryObjectId: otherId, name: 'new.png' });
    const second = await stream.next();
    expect(second.value).toMatchObject({ type: 'binary_object', id: 'second-aa', name: 'new.png', mimeType: 'image/png', size: save.blob.size });
    if (second.value?.type !== 'binary_object') {
      throw new Error('Expected a binary object');
    }
    expect(await second.value.blob.text()).toBe('new body');
    expect((await stream.next()).done).toBe(true);
  });

  it('lists a shard with one staging enumeration instead of per-object file lookups', async () => {
    const otherId = toBinaryObjectId({ raw: 'second-aa' });
    await provider.saveFile(save);
    await provider.saveFile({ ...save, binaryObjectId: otherId });
    const directory = await published();
    await directory.getFileHandle(`${rawId}.bin.tmp`, { create: true });
    using reads = vi.spyOn(directory, 'getFileHandle');
    using enumerations = vi.spyOn(directory, 'values');
    const objects = await listed();
    expect(objects.map(object => object.id)).toEqual([otherId]);
    expect(reads).not.toHaveBeenCalled();
    expect(enumerations).toHaveBeenCalledOnce();
  });

  it('does not report an empty publication namespace as attachment data', async () => {
    await published();
    expect(await provider.hasAttachments()).toBe(false);
    await provider.saveFile(save);
    expect(await provider.hasAttachments()).toBe(true);
    await provider.deleteBinaryObject({ binaryObjectId });
    expect(await provider.hasAttachments()).toBe(false);
  });
});
