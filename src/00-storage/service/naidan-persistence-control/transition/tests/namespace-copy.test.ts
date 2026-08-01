import { describe, expect, it } from 'vitest';
import {
  createTransitionNamespaceCopyCursor,
  runTransitionNamespaceCopySlice,
  type TransitionNamespaceEntry,
  type TransitionNamespaceMetadata,
  type TransitionNamespaceSourcePort,
  type TransitionNamespaceTargetPort,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

const metadata: TransitionNamespaceMetadata = { createdAt: 1n, modifiedAt: 2n };
const entries = new Map<string, readonly TransitionNamespaceEntry[]>([
  ['', [
    { kind: 'directory', metadata, name: 'a' },
    { kind: 'file', metadata, name: 'large', size: 7n },
    { kind: 'symlink', metadata, name: 'link' },
  ]],
  ['a', [{ kind: 'file', metadata, name: 'small', size: 2n }]],
]);
const contents = new Map([['large', Uint8Array.from([1, 2, 3, 4, 5, 6, 7])], ['a/small', Uint8Array.from([8, 9])]]);

function source(): TransitionNamespaceSourcePort {
  return {
    readRootMetadata: async () => metadata,
    listDirectory: async ({ afterName, maximumEntries, path }) => {
      const all = entries.get(path.join('/')) ?? [];
      const start = afterName === undefined ? 0 : all.findIndex(entry => entry.name === afterName) + 1;
      const page = all.slice(start, start + maximumEntries);
      return { entries: page, state: start + page.length >= all.length ? 'complete' : 'more' };
    },
    readFileChunk: async ({ maximumBytes, offset, path }) => {
      const bytes = contents.get(path.join('/')) ?? new Uint8Array();
      const start = Number(offset);
      const chunk = bytes.slice(start, start + maximumBytes);
      return { bytes: chunk, state: start + chunk.byteLength === bytes.byteLength ? 'complete' : 'more' };
    },
    readSymlink: async () => '../large',
  };
}

function target() {
  const files = new Map<string, number[]>();
  const directories: string[] = [];
  const symlinks = new Map<string, string>();
  let completionCount = 0;
  const port: TransitionNamespaceTargetPort = {
    setRootMetadata: async ({ metadata: rootMetadata }) => {
      expect(rootMetadata).toEqual(metadata);
    },
    completeNamespace: async () => {
      completionCount += 1;
    },
    ensureDirectory: async ({ path }) => {
      directories.push(path.join('/'));
    },
    finalizeFile: async ({ path, size }) => {
      expect(files.get(path.join('/'))?.length ?? 0).toBe(Number(size));
    },
    writeFileChunk: async ({ bytes, offset, path }) => {
      const key = path.join('/');
      const value = files.get(key) ?? [];
      value.splice(Number(offset), bytes.byteLength, ...bytes);
      files.set(key, value);
    },
    writeSymlink: async ({ path, target: linkTarget }) => {
      symlinks.set(path.join('/'), linkTarget);
    },
  };
  return { completionCount: () => completionCount, directories, files, port, symlinks };
}

const policy = {
  maximumBytesPerSlice: 3,
  maximumDirectoryEntriesPerRead: 2,
  maximumOperationsPerSlice: 3,
  maximumPathComponents: 16,
} as const;

describe('bounded transition namespace copy', () => {
  it('resumes deterministically without materializing a whole file or directory', async () => {
    const output = target();
    let cursor = createTransitionNamespaceCopyCursor();
    let slices = 0;
    while (cursor.state !== 'complete') {
      cursor = await runTransitionNamespaceCopySlice({ cursor, policy, signal: undefined, source: source(), target: output.port });
      slices += 1;
      expect(slices).toBeLessThan(30);
    }
    expect(output.directories).toEqual(['a']);
    expect(output.files).toEqual(new Map([['a/small', [8, 9]], ['large', [1, 2, 3, 4, 5, 6, 7]]]));
    expect(output.symlinks).toEqual(new Map([['link', '../large']]));
    expect(output.completionCount()).toBe(1);
    expect(cursor.completedBytes).toBe(9n);
    expect(cursor.completedEntries).toBe(4n);
    expect(slices).toBeGreaterThan(2);
  });

  it('retries the explicit completion gate after a lost response', async () => {
    let completionAttempts = 0;
    const emptySource: TransitionNamespaceSourcePort = {
      ...source(),
      listDirectory: async () => ({ entries: [], state: 'complete' }),
    };
    const retryingTarget: TransitionNamespaceTargetPort = {
      ...target().port,
      completeNamespace: async () => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error('injected lost completion response');
      },
    };
    const cursor = createTransitionNamespaceCopyCursor();

    await expect(runTransitionNamespaceCopySlice({
      cursor, policy, signal: undefined, source: emptySource, target: retryingTarget,
    })).rejects.toThrow('injected lost completion response');
    const completed = await runTransitionNamespaceCopySlice({
      cursor, policy, signal: undefined, source: emptySource, target: retryingTarget,
    });

    expect(completed.state).toBe('complete');
    expect(completionAttempts).toBe(2);
  });

  it('rejects non-canonical source pages instead of skipping or duplicating entries', async () => {
    const bad: TransitionNamespaceSourcePort = {
      ...source(),
      listDirectory: async () => ({ entries: [
        { kind: 'file', metadata, name: 'z', size: 1n },
        { kind: 'file', metadata, name: 'a', size: 1n },
      ], state: 'complete' }),
    };
    await expect(runTransitionNamespaceCopySlice({
      cursor: createTransitionNamespaceCopyCursor(), policy, signal: undefined, source: bad, target: target().port,
    })).rejects.toMatchObject({ code: 'invalid_directory_page' });
  });

  it('rejects names and symbolic-link targets outside the portable HizoFS profile', async () => {
    const overlongName = 'é'.repeat(128);
    const badName: TransitionNamespaceSourcePort = {
      ...source(),
      listDirectory: async () => ({ entries: [{ kind: 'directory', metadata, name: overlongName }], state: 'complete' }),
    };
    await expect(runTransitionNamespaceCopySlice({
      cursor: createTransitionNamespaceCopyCursor(), policy, signal: undefined, source: badName, target: target().port,
    })).rejects.toMatchObject({ code: 'invalid_entry_name' });

    const badTarget: TransitionNamespaceSourcePort = {
      ...source(),
      listDirectory: async () => ({ entries: [{ kind: 'symlink', metadata, name: 'link' }], state: 'complete' }),
      readSymlink: async () => 'x'.repeat(4097),
    };
    await expect(runTransitionNamespaceCopySlice({
      cursor: createTransitionNamespaceCopyCursor(), policy, signal: undefined, source: badTarget, target: target().port,
    })).rejects.toMatchObject({ code: 'invalid_symlink_target' });
  });

  it('rejects a file whose completion marker contradicts the captured size', async () => {
    const bad: TransitionNamespaceSourcePort = {
      ...source(),
      listDirectory: async () => ({ entries: [{ kind: 'file', metadata, name: 'bad', size: 5n }], state: 'complete' }),
      readFileChunk: async () => ({ bytes: Uint8Array.of(1), state: 'complete' }),
    };
    await expect(runTransitionNamespaceCopySlice({
      cursor: createTransitionNamespaceCopyCursor(), policy, signal: undefined, source: bad, target: target().port,
    })).rejects.toMatchObject({ code: 'file_size_mismatch' });
  });
});
