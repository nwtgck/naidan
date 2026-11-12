// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile, type MemoryMoves } from '@/utils/file-system-publication/memory.test-support';
import { createFileMoveSupportCache, moveStagedFile, temporaryFileName } from '@/utils/file-system-publication';

function native({ directory }: { directory: MemoryDirectory }): FileSystemDirectoryHandle {
  return directory as unknown as FileSystemDirectoryHandle;
}

afterEach(() => vi.restoreAllMocks());

describe('file move capability cache', () => {
  it('detects an absent method and removes its probe', async () => {
    const directory = new MemoryDirectory('files');
    const support = createFileMoveSupportCache();
    expect(await support.detect({ directory: native({ directory }) })).toBe('unsupported');
    expect(directory.children.size).toBe(0);
  });

  it('shares concurrent probes and aliases of the same physical directory', async () => {
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const alias = new MemoryDirectory('alias', moves);
    alias.children = directory.children;
    using identity = vi.spyOn(directory, 'isSameEntry').mockImplementation(async other => other === directory || other === alias);
    const support = createFileMoveSupportCache();
    expect(await Promise.all([
      support.detect({ directory: native({ directory }) }),
      support.detect({ directory: native({ directory: alias }) }),
      support.detect({ directory: native({ directory }) }),
    ])).toEqual(['supported', 'supported', 'supported']);
    expect(identity).toHaveBeenCalled();
    expect(moves.calls).toHaveLength(1);
    expect(directory.children.size).toBe(0);
    const other = new MemoryDirectory('other', moves);
    expect(await support.detect({ directory: native({ directory: other }) })).toBe('supported');
    expect(moves.calls).toHaveLength(2);
  });

  it('caches explicit non-support, but clear permits a new probe', async () => {
    const moves: MemoryMoves = {
      calls: [],
      beforeMove: () => {
        throw new DOMException('Unsupported', 'NotSupportedError');
      },
    };
    const directory = new MemoryDirectory('files', moves);
    const support = createFileMoveSupportCache();
    expect(await support.detect({ directory: native({ directory }) })).toBe('unsupported');
    moves.beforeMove = undefined;
    expect(await support.detect({ directory: native({ directory }) })).toBe('unsupported');
    support.clear();
    expect(await support.detect({ directory: native({ directory }) })).toBe('supported');
    expect(moves.calls).toHaveLength(2);
    expect(directory.children.size).toBe(0);
  });

  it.each(['NotAllowedError', 'NoModificationAllowedError', 'QuotaExceededError', 'InvalidModificationError'])('does not cache %s as unsupported', async name => {
    const failure = new DOMException('Transient failure', name);
    const moves: MemoryMoves = {
      calls: [],
      beforeMove: () => {
        throw failure;
      },
    };
    const directory = new MemoryDirectory('files', moves);
    const support = createFileMoveSupportCache();
    await expect(support.detect({ directory: native({ directory }) })).rejects.toBe(failure);
    expect(directory.children.size).toBe(0);
    moves.beforeMove = undefined;
    expect(await support.detect({ directory: native({ directory }) })).toBe('supported');
    expect(moves.calls).toHaveLength(2);
  });

  it('falls back for an ambiguous move-probe abort without caching non-support', async () => {
    const moves: MemoryMoves = {
      calls: [],
      beforeMove: () => {
        throw new DOMException('Operation aborted', 'AbortError');
      },
    };
    const directory = new MemoryDirectory('files', moves);
    const support = createFileMoveSupportCache();
    expect(await support.detect({ directory: native({ directory }) })).toBe('unsupported');
    expect(directory.children.size).toBe(0);
    moves.beforeMove = undefined;
    expect(await support.detect({ directory: native({ directory }) })).toBe('supported');
    expect(await support.detect({ directory: native({ directory }) })).toBe('supported');
    expect(moves.calls).toHaveLength(2);
  });

  it('propagates writer aborts instead of mistaking them for a disabled move', async () => {
    const directory = new MemoryDirectory('files', { calls: [] });
    using writer = vi.spyOn(MemoryFile.prototype, 'createWritable').mockRejectedValue(new DOMException('Write aborted', 'AbortError'));
    await expect(createFileMoveSupportCache().detect({ directory: native({ directory }) })).rejects.toMatchObject({ name: 'AbortError' });
    expect(writer).toHaveBeenCalledOnce();
    expect(directory.children.size).toBe(0);
  });

  it('never claims or deletes an existing probe name', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    using random = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
    const directory = new MemoryDirectory('files', { calls: [] });
    const file = await directory.getFileHandle(`.${id}.tmp`, { create: true });
    file.data = new Uint8Array([7]);
    await expect(createFileMoveSupportCache().detect({ directory: native({ directory }) })).rejects.toThrow('collision');
    expect(random).toHaveBeenCalledOnce();
    expect(directory.children.get(file.name)).toBe(file);
    expect(file.data).toEqual(new Uint8Array([7]));
  });

  it('does not remove a foreign destination after a failed probe', async () => {
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const foreign = new MemoryFile('foreign');
    moves.beforeMove = ({ to }) => {
      directory.children.set(to, foreign);
      throw new DOMException('Denied', 'NotAllowedError');
    };
    await expect(createFileMoveSupportCache().detect({ directory: native({ directory }) })).rejects.toThrow('Denied');
    expect([...directory.children.values()]).toEqual([foreign]);
  });
});

describe('staged file publication', () => {
  it('uses the same short suffix for any producer and moves only closed files', async () => {
    expect(temporaryFileName({ name: 'export.json' })).toBe('export.json.tmp');
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const handle = await directory.getFileHandle('export.json.tmp', { create: true });
    const writer = await handle.createWritable();
    await writer.write('result');
    await writer.close();
    const result = await moveStagedFile({ directory: native({ directory }), name: 'export.json', handle: handle as unknown as FileSystemFileHandle, snapshot: await handle.getFile(), moveSupport: createFileMoveSupportCache() });
    expect(await (await result.getFile()).text()).toBe('result');
    expect([...directory.children.keys()]).toEqual(['export.json']);
    expect(moves.calls).toEqual([{ from: 'export.json.tmp', to: 'export.json' }]);
  });

  it('does not overwrite an existing destination', async () => {
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const handle = await directory.getFileHandle('file.tmp', { create: true });
    const final = await directory.getFileHandle('file', { create: true });
    await expect(moveStagedFile({ directory: native({ directory }), name: 'file', handle: handle as unknown as FileSystemFileHandle, snapshot: await handle.getFile(), moveSupport: createFileMoveSupportCache() })).rejects.toThrow('already exists');
    expect(directory.children.get('file')).toBe(final);
    expect(directory.children.get('file.tmp')).toBe(handle);
    expect(moves.calls).toHaveLength(0);
  });

  it('replaces only an explicitly supplied unchanged destination', async () => {
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const previous = await directory.getFileHandle('file', { create: true });
    previous.data = new TextEncoder().encode('old');
    const handle = await directory.getFileHandle('file.tmp', { create: true });
    handle.data = new TextEncoder().encode('new');
    const result = await moveStagedFile({ directory: native({ directory }), name: 'file', handle: handle as unknown as FileSystemFileHandle, snapshot: await handle.getFile(), moveSupport: createFileMoveSupportCache(), replacement: { handle: previous as unknown as FileSystemFileHandle, snapshot: await previous.getFile() } });
    expect(await (await result.getFile()).text()).toBe('new');
    expect(directory.children.get('file')).toBe(handle);
    expect(directory.children.has('file.tmp')).toBe(false);
  });

  it.each(['removed', 'replaced', 'modified'] as const)('preserves both entries when the requested replacement was %s', async change => {
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const previous = await directory.getFileHandle('file', { create: true });
    const replacement = { handle: previous as unknown as FileSystemFileHandle, snapshot: await previous.getFile() };
    const handle = await directory.getFileHandle('file.tmp', { create: true });
    switch (change) {
    case 'removed': directory.children.delete('file');
      break;
    case 'replaced': directory.children.set('file', new MemoryFile('file'));
      break;
    case 'modified': previous.modified++;
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    const current = directory.children.get('file');
    await expect(moveStagedFile({ directory: native({ directory }), name: 'file', handle: handle as unknown as FileSystemFileHandle, snapshot: await handle.getFile(), moveSupport: createFileMoveSupportCache(), replacement })).rejects.toThrow('replacement changed');
    expect(directory.children.get('file')).toBe(current);
    expect(directory.children.get('file.tmp')).toBe(handle);
    expect(moves.calls).toHaveLength(0);
  });

  it('preserves changed staging and invalidates capability after an actual move fails', async () => {
    const moves: MemoryMoves = { calls: [] };
    const directory = new MemoryDirectory('files', moves);
    const support = createFileMoveSupportCache();
    await support.detect({ directory: native({ directory }) });
    const handle = await directory.getFileHandle('file.tmp', { create: true });
    const snapshot = await handle.getFile();
    handle.modified++;
    await expect(moveStagedFile({ directory: native({ directory }), name: 'file', handle: handle as unknown as FileSystemFileHandle, snapshot, moveSupport: support })).rejects.toThrow('changed');
    moves.beforeMove = () => {
      throw new DOMException('Locked', 'NoModificationAllowedError');
    };
    await expect(moveStagedFile({ directory: native({ directory }), name: 'file', handle: handle as unknown as FileSystemFileHandle, snapshot: await handle.getFile(), moveSupport: support })).rejects.toThrow('Locked');
    expect(directory.children.get('file.tmp')).toBe(handle);
    expect(directory.children.has('file')).toBe(false);
    moves.beforeMove = undefined;
    await support.detect({ directory: native({ directory }) });
    expect(moves.calls).toHaveLength(3);
  });
});
