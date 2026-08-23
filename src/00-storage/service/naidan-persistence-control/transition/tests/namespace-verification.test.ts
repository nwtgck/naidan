import { describe, expect, it } from 'vitest';
import {
  createTransitionNamespaceVerificationCursor,
  runTransitionNamespaceVerificationSlice,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-verification';
import type { TransitionNamespaceSourcePort } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

const metadata = { createdAt: 1n, modifiedAt: 2n } as const;
const file = Uint8Array.from([1, 2, 3, 4, 5]);

function port({ changedByte, extraName, modifiedAt }: {
  changedByte: number | undefined;
  extraName: string | undefined;
  modifiedAt: bigint | undefined;
}): TransitionNamespaceSourcePort {
  return {
    readRootMetadata: async () => metadata,
    listDirectory: async ({ afterName, maximumEntries }) => {
      const all = [
        { kind: 'file', metadata: { ...metadata, modifiedAt: modifiedAt ?? metadata.modifiedAt }, name: 'file', size: 5n } as const,
        { kind: 'symlink', metadata, name: 'link' } as const,
        ...(extraName === undefined ? [] : [{ kind: 'directory', metadata, name: extraName } as const]),
      ];
      const start = afterName === undefined ? 0 : all.findIndex(entry => entry.name === afterName) + 1;
      const entries = all.slice(start, start + maximumEntries);
      return { entries, state: start + entries.length >= all.length ? 'complete' : 'more' };
    },
    readFileChunk: async ({ maximumBytes, offset }) => {
      const bytes = file.slice(Number(offset), Number(offset) + maximumBytes);
      if (changedByte !== undefined && offset === 0n) bytes[0] = changedByte;
      return { bytes, state: Number(offset) + bytes.byteLength === file.byteLength ? 'complete' : 'more' };
    },
    readSymlink: async () => '../file',
  };
}

const policy = {
  maximumBytesPerSlice: 2,
  maximumDirectoryEntriesPerRead: 1,
  maximumOperationsPerSlice: 2,
  maximumPathComponents: 16,
} as const;

async function verifyToCompletion({ source, target }: {
  source: TransitionNamespaceSourcePort;
  target: TransitionNamespaceSourcePort;
}): Promise<void> {
  let cursor = createTransitionNamespaceVerificationCursor();
  let slices = 0;
  while (cursor.state !== 'complete') {
    cursor = await runTransitionNamespaceVerificationSlice({ cursor, policy, signal: undefined, source, target });
    slices += 1;
    expect(slices).toBeLessThan(20);
  }
}

describe('bounded transition namespace verification', () => {
  it('verifies metadata and content across resumable slices', async () => {
    const source = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    const target = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    let cursor = createTransitionNamespaceVerificationCursor();
    let slices = 0;
    while (cursor.state !== 'complete') {
      cursor = await runTransitionNamespaceVerificationSlice({ cursor, policy, signal: undefined, source, target });
      slices += 1;
      expect(slices).toBeLessThan(20);
    }
    expect(cursor.verifiedBytes).toBe(5n);
    expect(cursor.verifiedEntries).toBe(2n);
  });

  it('compares canonical ordered entry streams independently of page partitioning', async () => {
    const baseSource = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    const baseTarget = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    const source = {
      ...baseSource,
      listDirectory: async ({ afterName, maximumEntries, path }) => await baseSource.listDirectory({
        afterName,
        maximumEntries: Math.min(maximumEntries, 1),
        path,
      }),
    } satisfies TransitionNamespaceSourcePort;
    const target = {
      ...baseTarget,
      listDirectory: async ({ afterName, maximumEntries, path }) => await baseTarget.listDirectory({
        afterName,
        maximumEntries: Math.min(maximumEntries, 2),
        path,
      }),
    } satisfies TransitionNamespaceSourcePort;

    await expect(verifyToCompletion({ source, target })).resolves.toBeUndefined();
  });

  it('rejects extra target entries', async () => {
    await expect(verifyToCompletion({
      source: port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined }),
      target: port({ changedByte: undefined, extraName: 'z', modifiedAt: undefined }),
    })).rejects.toMatchObject({ code: 'directory_mismatch', path: '/' });
  });

  it('continues to reject a missing entry and noncanonical ordering', async () => {
    const complete = port({ changedByte: undefined, extraName: 'z', modifiedAt: undefined });
    const missing = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    await expect(verifyToCompletion({
      source: complete,
      target: missing,
    })).rejects.toMatchObject({ code: 'directory_mismatch', path: '/' });

    const base = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    const reordered = {
      ...base,
      listDirectory: async ({ afterName, maximumEntries, path }) => {
        const page = await base.listDirectory({ afterName, maximumEntries, path });
        return { ...page, entries: [...page.entries].reverse() };
      },
    } satisfies TransitionNamespaceSourcePort;
    await expect(runTransitionNamespaceVerificationSlice({
      cursor: createTransitionNamespaceVerificationCursor(),
      policy: { ...policy, maximumDirectoryEntriesPerRead: 3 },
      signal: undefined,
      source: base,
      target: reordered,
    })).rejects.toMatchObject({ code: 'invalid_directory_page', path: '/' });
  });

  it('rejects matching but independently invalid pages and oversized chunks', async () => {
    const oversizedPage: TransitionNamespaceSourcePort = {
      ...port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined }),
      listDirectory: async () => ({
        entries: [
          { kind: 'file', metadata, name: 'a', size: 1n },
          { kind: 'file', metadata, name: 'b', size: 1n },
        ],
        state: 'complete',
      }),
    };
    await expect(runTransitionNamespaceVerificationSlice({
      cursor: createTransitionNamespaceVerificationCursor(), policy, signal: undefined, source: oversizedPage, target: oversizedPage,
    })).rejects.toMatchObject({ code: 'invalid_directory_page', path: '/' });

    const base = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    const first = await runTransitionNamespaceVerificationSlice({
      cursor: createTransitionNamespaceVerificationCursor(), policy: { ...policy, maximumOperationsPerSlice: 1 },
      signal: undefined, source: base, target: base,
    });
    const oversizedChunk: TransitionNamespaceSourcePort = {
      ...base,
      readFileChunk: async ({ maximumBytes }) => ({ bytes: new Uint8Array(maximumBytes + 1), state: 'more' }),
    };
    await expect(runTransitionNamespaceVerificationSlice({
      cursor: first, policy, signal: undefined, source: oversizedChunk, target: oversizedChunk,
    })).rejects.toMatchObject({ code: 'source_changed', path: '/file' });
  });

  it('rejects metadata and file content mismatches', async () => {
    const rootMismatch = {
      ...port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined }),
      readRootMetadata: async () => ({ createdAt: 9n, modifiedAt: 2n }),
    } satisfies TransitionNamespaceSourcePort;
    await expect(runTransitionNamespaceVerificationSlice({
      cursor: createTransitionNamespaceVerificationCursor(), policy, signal: undefined,
      source: port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined }),
      target: rootMismatch,
    })).rejects.toMatchObject({ code: 'metadata_mismatch', path: '/' });

    await expect(runTransitionNamespaceVerificationSlice({
      cursor: createTransitionNamespaceVerificationCursor(), policy, signal: undefined,
      source: port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined }),
      target: port({ changedByte: undefined, extraName: undefined, modifiedAt: 9n }),
    })).rejects.toMatchObject({ code: 'metadata_mismatch', path: '/file' });

    const source = port({ changedByte: undefined, extraName: undefined, modifiedAt: undefined });
    const target = port({ changedByte: 9, extraName: undefined, modifiedAt: undefined });
    await expect(runTransitionNamespaceVerificationSlice({
      cursor: createTransitionNamespaceVerificationCursor(), policy, signal: undefined, source, target,
    })).rejects.toMatchObject({ code: 'content_mismatch', path: '/file' });
  });
});
