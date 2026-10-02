import { createBlobStorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import { createStorageFileSystemTransitionSource } from '@/00-storage/service/naidan-persistence-control/transition/storage-file-system-transition-source';
import { describe, expect, it, vi } from 'vitest';

function entry({ bytes, kind, name, target }: {
  bytes?: Uint8Array;
  kind: StorageEntryHandle['kind'];
  name: string;
  target?: string;
}): StorageEntryHandle {
  const stat = vi.fn(async () => ({ createdAt: 11, modifiedAt: undefined, size: bytes?.byteLength ?? 0 }));
  switch (kind) {
  case 'file': return {
    kind,
    name,
    stat,
    openReadable: vi.fn(async ({ mimeType }) => createBlobStorageBinaryObjectReadHandle({ blob: new Blob([Uint8Array.from(bytes ?? new Uint8Array(0))]), mimeType })),
    createWritable: vi.fn(),
  };
  case 'symlink': return { kind, name, stat, readTarget: vi.fn(async () => target ?? '') };
  case 'directory': return directory({ entries: [], name });
  default: return kind satisfies never;
  }
}

function directory({ entries, name = 'root' }: {
  entries: readonly StorageEntryHandle[];
  name?: string;
}): StorageDirectoryHandle {
  const byName = new Map(entries.map(value => [value.name, value]));
  return {
    kind: 'directory',
    name,
    stat: vi.fn(async () => ({ createdAt: undefined, modifiedAt: undefined, size: 0 })),
    entries: async function* () {
      for (const value of entries) yield [value.name, value] as const;
    },
    getEntryHandle: vi.fn(async ({ name: childName }) => {
      const value = byName.get(childName);
      if (value === undefined) throw new Error('missing entry');
      return value;
    }),
    getFileHandle: vi.fn(),
    getDirectoryHandle: vi.fn(),
    removeEntry: vi.fn(),
    createSymlink: vi.fn(),
    moveEntry: vi.fn(),
    cloneFile: vi.fn(),
  };
}

function session({ root }: { root: StorageDirectoryHandle }): StorageFileSystemSession {
  return {
    root,
    capabilities: { atomicMove: 'unsupported', directBlob: 'supported', symbolicLink: 'supported', wholeFileClone: 'unsupported' },
    close: vi.fn(),
    sync: vi.fn(async () => undefined),
  };
}

describe('storage filesystem transition source', () => {
  it('uses ordered pages directly and resumes after a partially consumed page', async () => {
    const names = ['entry-a', 'entry-\uFF21', 'entry-\u{10400}', 'entry-\u{10401}'];
    const handles = names.map(name => entry({ kind: 'file', name }));
    const root = directory({ entries: handles });
    const enumerate = vi.spyOn(root, 'entries');
    const listEntriesPage = vi.fn<NonNullable<StorageDirectoryHandle['listEntriesPage']>>(async ({ afterName, maximumEntries }) => {
      const start = afterName === undefined ? 0 : names.indexOf(afterName) + 1;
      return { entries: handles.slice(start, start + maximumEntries).map(handle => [handle.name, handle] as const), truncated: start + maximumEntries < names.length };
    });
    root.listEntriesPage = listEntriesPage;
    const source = createStorageFileSystemTransitionSource({ session: session({ root }) });
    for (const [afterName, expected] of [[undefined, names.slice(0, 2)], [names[0], names.slice(1, 3)], [names[2], names.slice(3)]] as const) {
      const page = await source.listDirectory({ afterName, maximumEntries: 2, path: [] });
      expect(page.entries.map(value => value.name)).toEqual(expected);
    }
    expect(listEntriesPage.mock.calls.map(([request]) => request)).toEqual([
      { afterName: undefined, maximumEntries: 2 },
      { afterName: names[0], maximumEntries: 2 },
      { afterName: names[2], maximumEntries: 2 },
    ]);
    expect(enumerate).not.toHaveBeenCalled();
    expect(handles.map(handle => vi.mocked(handle.stat).mock.calls.length)).toEqual([1, 2, 1, 1]);
  });

  it.each([
    { names: ['a', 'b'], afterName: undefined, maximumEntries: 1, truncated: false },
    { names: ['b', 'a'], afterName: undefined, maximumEntries: 2, truncated: false },
    { names: ['a', 'a'], afterName: undefined, maximumEntries: 2, truncated: false },
    { names: ['a'], afterName: 'a', maximumEntries: 2, truncated: false },
    { names: [], afterName: undefined, maximumEntries: 2, truncated: true },
  ])('rejects an invalid direct page $names after $afterName', async ({ names, afterName, maximumEntries, truncated }) => {
    const root = directory({ entries: [] });
    root.listEntriesPage = async () => ({ entries: names.map(name => [name, entry({ kind: 'file', name })] as const), truncated });
    const source = createStorageFileSystemTransitionSource({ session: session({ root }) });
    await expect(source.listDirectory({ afterName, maximumEntries, path: [] })).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects direct page names that disagree with their handles', async () => {
    const root = directory({ entries: [] });
    root.listEntriesPage = async () => ({ entries: [['a', entry({ kind: 'file', name: 'b' })]], truncated: false });
    const source = createStorageFileSystemTransitionSource({ session: session({ root }) });
    await expect(source.listDirectory({ afterName: undefined, maximumEntries: 2, path: [] })).rejects.toThrow('disagrees');
  });

  it('keeps the filename contract error for an illegal direct page name', async () => {
    const root = directory({ entries: [] });
    root.listEntriesPage = async () => ({ entries: [['../bad', entry({ kind: 'file', name: '../bad' })]], truncated: false });
    const source = createStorageFileSystemTransitionSource({ session: session({ root }) });
    await expect(source.listDirectory({ afterName: undefined, maximumEntries: 2, path: [] })).rejects.toMatchObject({ code: 'invalid_entry_name' });
  });

  it('returns a bounded canonical page without retaining the whole directory', async () => {
    const source = createStorageFileSystemTransitionSource({ session: session({ root: directory({ entries: [
      entry({ kind: 'file', name: 'z' }),
      entry({ kind: 'directory', name: 'b' }),
      entry({ kind: 'symlink', name: 'a', target: '../x' }),
      entry({ kind: 'file', name: 'c' }),
    ] }) }) });
    await expect(source.listDirectory({ afterName: undefined, maximumEntries: 2, path: [] })).resolves.toEqual({
      entries: [
        { kind: 'symlink', metadata: { createdAt: 11n, modifiedAt: undefined }, name: 'a' },
        { kind: 'directory', metadata: { createdAt: undefined, modifiedAt: undefined }, name: 'b' },
      ],
      state: 'more',
    });
    await expect(source.listDirectory({ afterName: 'b', maximumEntries: 2, path: [] })).resolves.toMatchObject({
      entries: [{ name: 'c' }, { name: 'z' }],
      state: 'complete',
    });
  });

  it('reads bounded file chunks and reports exact completion', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const source = createStorageFileSystemTransitionSource({ session: session({ root: directory({ entries: [entry({ bytes, kind: 'file', name: 'file' })] }) }) });
    await expect(source.readFileChunk({ maximumBytes: 3, offset: 0n, path: ['file'] })).resolves.toEqual({ bytes: bytes.slice(0, 3), state: 'more' });
    await expect(source.readFileChunk({ maximumBytes: 3, offset: 3n, path: ['file'] })).resolves.toEqual({ bytes: bytes.slice(3), state: 'complete' });
  });

  it.each([
    { label: 'close undefined', primary: undefined, cleanup: undefined },
    { label: 'read undefined', primary: { cause: undefined }, cleanup: new Error('close failed') },
    { label: 'read Error', primary: { cause: new Error('read failed') }, cleanup: new Error('close failed') },
    { label: 'read null', primary: { cause: null }, cleanup: undefined },
  ])('preserves $label without replacing the primary read failure', async ({ primary, cleanup }) => {
    const file = entry({ bytes: Uint8Array.of(1), kind: 'file', name: 'file' });
    if (file.kind !== 'file') throw new Error('expected file fixture');
    const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
    vi.spyOn(file, 'openReadable').mockResolvedValue(readable);
    if (primary !== undefined) vi.spyOn(readable, 'read').mockRejectedValue(primary.cause);
    const close = vi.spyOn(readable, 'close').mockRejectedValue(cleanup);
    const source = createStorageFileSystemTransitionSource({ session: session({ root: directory({ entries: [file] }) }) });

    await expect(source.readFileChunk({ maximumBytes: 1, offset: 0n, path: ['file'] }))
      .rejects.toBe(primary === undefined ? cleanup : primary.cause);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([1, 2])('orders Unicode filenames by canonical UTF-8 bytes across pages of %s', async (maximumEntries) => {
    const names = ['entry-a', 'entry-\uFF21', 'entry-\u{10400}', 'entry-\u{10401}'];
    const source = createStorageFileSystemTransitionSource({ session: session({ root: directory({
      entries: [...names].reverse().map(name => entry({ kind: 'file', name })),
    }) }) });
    let afterName: string | undefined;
    for (let offset = 0; offset < names.length; offset += maximumEntries) {
      const expectedNames = names.slice(offset, offset + maximumEntries);
      const page = await source.listDirectory({ afterName, maximumEntries, path: [] });
      expect(page.entries.map(value => value.name)).toEqual(expectedNames);
      expect(page.state).toBe(offset + maximumEntries < names.length ? 'more' : 'complete');
      afterName = expectedNames.at(-1);
    }
    await expect(source.listDirectory({ afterName, maximumEntries, path: [] })).resolves.toEqual({
      entries: [], state: 'complete',
    });
  });

  it('reads symlinks without interpreting their target', async () => {
    const source = createStorageFileSystemTransitionSource({ session: session({ root: directory({ entries: [entry({ kind: 'symlink', name: 'link', target: '../target' })] }) }) });
    await expect(source.readSymlink({ path: ['link'] })).resolves.toBe('../target');
  });

  it('rejects unsafe numeric metadata instead of rounding it', async () => {
    const file = entry({ kind: 'file', name: 'file' });
    file.stat = vi.fn(async () => ({ createdAt: Number.MAX_SAFE_INTEGER + 1, modifiedAt: undefined, size: 0 }));
    const source = createStorageFileSystemTransitionSource({ session: session({ root: directory({ entries: [file] }) }) });
    await expect(source.listDirectory({ afterName: undefined, maximumEntries: 1, path: [] })).rejects.toThrow('safe integer');
  });
});
