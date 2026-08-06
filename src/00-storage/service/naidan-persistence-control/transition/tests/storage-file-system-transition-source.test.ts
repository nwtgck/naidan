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
