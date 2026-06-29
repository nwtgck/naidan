import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import {
  createFileExplorerDirectoryArchive,
  type FileExplorerDirectoryArchiveAccess,
  type FileExplorerDirectoryArchiveSourceEntry,
} from './directory-archive';

function createTextStream({ text }: { text: string }): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createAccess({
  directories,
  files,
}: {
  directories: ReadonlyMap<string, readonly FileExplorerDirectoryArchiveSourceEntry[]>,
  files: ReadonlyMap<string, string>,
}): FileExplorerDirectoryArchiveAccess {
  return {
    async listDirectory({ path }) {
      const entries = directories.get(path);
      if (entries === undefined) throw new Error(`Missing directory: ${path}`);
      return entries.map(entry => ({ ...entry }));
    },
    async openFileStream({ path }) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`Missing file: ${path}`);
      return createTextStream({ text });
    },
  };
}

async function loadZip({ blob }: { blob: Blob }): Promise<JSZip> {
  return JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
}

describe('createFileExplorerDirectoryArchive', () => {
  it('always places the selected directory at the ZIP root', async () => {
    const access = createAccess({
      directories: new Map([
        ['/hoge/my-project', [
          { name: 'src', kind: 'directory', modifiedAt: undefined },
          { name: 'package.json', kind: 'file', modifiedAt: undefined },
        ]],
        ['/hoge/my-project/src', [
          { name: 'main.ts', kind: 'file', modifiedAt: undefined },
        ]],
      ]),
      files: new Map([
        ['/hoge/my-project/package.json', '{}'],
        ['/hoge/my-project/src/main.ts', 'export {};'],
      ]),
    });

    const result = await createFileExplorerDirectoryArchive({
      access,
      sourceRootPath: '/hoge/my-project',
      archiveRootName: 'my-project',
      excludedRelativePaths: [],
      signal: new AbortController().signal,
    });
    const zip = await loadZip({ blob: result.blob });

    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining([
      'my-project/',
      'my-project/src/',
      'my-project/src/main.ts',
      'my-project/package.json',
    ]));
    expect(zip.file('package.json')).toBeNull();
    expect(zip.files['src/']).toBeUndefined();
    expect(zip.files['src/main.ts']).toBeUndefined();
    expect(await zip.file('my-project/src/main.ts')?.async('string')).toBe('export {};');
  });

  it('recursively excludes selected subdirectories and files', async () => {
    const access = createAccess({
      directories: new Map([
        ['/my-project', [
          { name: 'dist', kind: 'directory', modifiedAt: undefined },
          { name: 'src', kind: 'directory', modifiedAt: undefined },
          { name: 'debug.log', kind: 'file', modifiedAt: undefined },
        ]],
        ['/my-project/dist', [{ name: 'bundle.js', kind: 'file', modifiedAt: undefined }]],
        ['/my-project/src', [{ name: 'main.ts', kind: 'file', modifiedAt: undefined }]],
      ]),
      files: new Map([
        ['/my-project/debug.log', 'debug'],
        ['/my-project/dist/bundle.js', 'bundle'],
        ['/my-project/src/main.ts', 'main'],
      ]),
    });

    const result = await createFileExplorerDirectoryArchive({
      access,
      sourceRootPath: '/my-project',
      archiveRootName: 'my-project',
      excludedRelativePaths: ['dist', 'debug.log'],
      signal: new AbortController().signal,
    });
    const zip = await loadZip({ blob: result.blob });

    expect(zip.file('my-project/src/main.ts')).not.toBeNull();
    expect(zip.file('my-project/debug.log')).toBeNull();
    expect(zip.files['my-project/dist/']).toBeUndefined();
  });

  it('stops before traversing when already cancelled', async () => {
    const abortController = new AbortController();
    abortController.abort(new DOMException('cancelled', 'AbortError'));
    const listDirectory = vi.fn();

    await expect(createFileExplorerDirectoryArchive({
      access: {
        listDirectory,
        async openFileStream() {
          throw new Error('Unexpected file stream');
        },
      },
      sourceRootPath: '/project',
      archiveRootName: 'project',
      excludedRelativePaths: [],
      signal: abortController.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('preserves an empty selected directory', async () => {
    const result = await createFileExplorerDirectoryArchive({
      access: createAccess({
        directories: new Map([['/empty', []]]),
        files: new Map(),
      }),
      sourceRootPath: '/empty',
      archiveRootName: 'empty',
      excludedRelativePaths: [],
      signal: new AbortController().signal,
    });
    const zip = await loadZip({ blob: result.blob });
    expect(zip.files['empty/']?.dir).toBe(true);
  });

  it('skips unsafe child path segments instead of writing traversal entries', async () => {
    const openFileStream = vi.fn();
    const result = await createFileExplorerDirectoryArchive({
      access: {
        async listDirectory() {
          return [
            { name: '../outside.txt', kind: 'file', modifiedAt: undefined },
            { name: 'safe.txt', kind: 'file', modifiedAt: undefined },
          ];
        },
        async openFileStream({ path }) {
          openFileStream(path);
          return createTextStream({ text: 'safe' });
        },
      },
      sourceRootPath: '/project',
      archiveRootName: 'project',
      excludedRelativePaths: [],
      signal: new AbortController().signal,
    });
    const zip = await loadZip({ blob: result.blob });

    expect(result.skippedEntryCount).toBe(1);
    expect(openFileStream).toHaveBeenCalledExactlyOnceWith('/project/safe.txt');
    expect(zip.file('project/safe.txt')).not.toBeNull();
    expect(Object.keys(zip.files).some(name => name.includes('..'))).toBe(false);
  });

  it('rejects an unsafe ZIP root directory name', async () => {
    await expect(createFileExplorerDirectoryArchive({
      access: createAccess({
        directories: new Map([['/project', []]]),
        files: new Map(),
      }),
      sourceRootPath: '/project',
      archiveRootName: '..',
      excludedRelativePaths: [],
      signal: new AbortController().signal,
    })).rejects.toThrow('Unsafe ZIP root directory name');
  });

  it('cancels a file stream immediately when the archive signal aborts', async () => {
    let resolveStreamOpened!: () => void;
    const streamOpened = new Promise<void>((resolve) => {
      resolveStreamOpened = resolve;
    });
    const cancel = vi.fn();
    const abortController = new AbortController();
    const archivePromise = createFileExplorerDirectoryArchive({
      access: {
        async listDirectory() {
          return [{ name: 'blocked.txt', kind: 'file', modifiedAt: undefined }];
        },
        async openFileStream() {
          resolveStreamOpened();
          return new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined);
            },
            cancel,
          });
        },
      },
      sourceRootPath: '/project',
      archiveRootName: 'project',
      excludedRelativePaths: [],
      signal: abortController.signal,
    });

    await streamOpened;
    abortController.abort(new DOMException('cancelled', 'AbortError'));

    await expect(archivePromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
