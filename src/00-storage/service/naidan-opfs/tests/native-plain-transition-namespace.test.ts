import { describe, expect, it, vi } from 'vitest';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  assertNativePlainTransitionSourceCompatible,
  createNativePlainTransitionNamespaceSession,
  projectNativePlainTransitionSource,
} from '@/00-storage/service/naidan-opfs/native-plain-transition-namespace';
import type { TransitionNamespaceSourcePort } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

function session(): StorageFileSystemSession {
  return {
    capabilities: {
      atomicMove: 'unsupported',
      directBlob: 'unsupported',
      symbolicLink: 'unsupported',
      wholeFileClone: 'unsupported',
    },
    close: vi.fn(async () => undefined),
    root: createInMemoryStorageRoot({ name: 'root' }),
  };
}

describe('native plain transition namespace', () => {
  it('applies idempotent bounded file writes and projects timestamps out of verification', async () => {
    const opened = session();
    const stageLifecycle = vi.fn(async () => undefined);
    const target = createNativePlainTransitionNamespaceSession({ bridge: { stageLifecycle }, session: opened });
    await target.target.setRootMetadata({ metadata: { createdAt: undefined, modifiedAt: undefined } });
    await target.target.ensureDirectory({ metadata: { createdAt: undefined, modifiedAt: undefined }, path: ['naidan-storage'] });
    await target.target.writeFileChunk({ bytes: Uint8Array.of(1, 2), offset: 0n, path: ['naidan-storage', 'file.bin'] });
    await target.target.writeFileChunk({ bytes: Uint8Array.of(1, 2), offset: 0n, path: ['naidan-storage', 'file.bin'] });
    await target.target.writeFileChunk({ bytes: Uint8Array.of(3), offset: 2n, path: ['naidan-storage', 'file.bin'] });
    await target.target.finalizeFile({ metadata: { createdAt: undefined, modifiedAt: undefined }, path: ['naidan-storage', 'file.bin'], size: 3n });
    await target.target.completeNamespace();

    await expect(target.source.readRootMetadata()).resolves.toEqual({ createdAt: undefined, modifiedAt: undefined });
    const directory = await target.source.listDirectory({ afterName: undefined, maximumEntries: 8, path: ['naidan-storage'] });
    expect(directory.entries).toEqual([{
      kind: 'file',
      metadata: { createdAt: undefined, modifiedAt: undefined },
      name: 'file.bin',
      size: 3n,
    }]);
    await expect(target.source.readFileChunk({ maximumBytes: 8, offset: 0n, path: ['naidan-storage', 'file.bin'] }))
      .resolves.toEqual({ bytes: Uint8Array.of(1, 2, 3), state: 'complete' });
    expect(stageLifecycle).toHaveBeenCalledWith({ lifecycle: 'sealed' });
  });

  it('rejects synthetic timestamps, unsafe sizes, and symbolic links', async () => {
    const target = createNativePlainTransitionNamespaceSession({
      bridge: { stageLifecycle: async () => undefined },
      session: session(),
    });
    await expect(target.target.setRootMetadata({ metadata: { createdAt: 1n, modifiedAt: undefined } }))
      .rejects.toThrow('cannot preserve source timestamps');
    await expect(target.target.writeSymlink({ metadata: { createdAt: undefined, modifiedAt: undefined }, path: ['link'], target: 'target' }))
      .rejects.toThrow('does not support symbolic links');
    await expect(target.target.finalizeFile({
      metadata: { createdAt: undefined, modifiedAt: undefined },
      path: ['file'],
      size: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    })).rejects.toThrow('safe-integer range');
  });

  it('projects the same absent timestamps into copy and verification views', async () => {
    const exact: TransitionNamespaceSourcePort = {
      listDirectory: async () => ({
        entries: [{ kind: 'directory', metadata: { createdAt: 10n, modifiedAt: 20n }, name: 'child' }],
        state: 'complete',
      }),
      readFileChunk: async () => ({ bytes: new Uint8Array(), state: 'complete' }),
      readRootMetadata: async () => ({ createdAt: 1n, modifiedAt: 2n }),
      readSymlink: async () => 'target',
    };
    const projected = projectNativePlainTransitionSource({ source: exact });
    await expect(projected.readRootMetadata()).resolves.toEqual({ createdAt: undefined, modifiedAt: undefined });
    await expect(projected.listDirectory({ afterName: undefined, maximumEntries: 1, path: [] })).resolves.toEqual({
      entries: [{ kind: 'directory', metadata: { createdAt: undefined, modifiedAt: undefined }, name: 'child' }],
      state: 'complete',
    });
  });

  it('rejects symlinks during bounded preflight before target mutation', async () => {
    let reads = 0;
    const source: TransitionNamespaceSourcePort = {
      listDirectory: async ({ path }) => {
        reads += 1;
        return path.length === 0
          ? { entries: [{ kind: 'directory', metadata: {}, name: 'directory' }], state: 'complete' }
          : { entries: [{ kind: 'symlink', metadata: {}, name: 'link' }], state: 'complete' };
      },
      readFileChunk: async () => ({ bytes: new Uint8Array(), state: 'complete' }),
      readRootMetadata: async () => ({}),
      readSymlink: async () => 'target',
    };
    await expect(assertNativePlainTransitionSourceCompatible({ maximumDirectoryEntriesPerRead: 1, source }))
      .rejects.toThrow('does not support symbolic links');
    expect(reads).toBe(2);
  });
});
