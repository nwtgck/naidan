import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useFileExplorerNavigation } from './useFileExplorerNavigation';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { SortConfig } from './types';
import type { ExplorerDirectory, ExplorerChild } from './explorer-directory';
import type { FileExplorerEntry, FileExplorerPathSegment } from './types';
import type { FileExplorerWorkerClient } from '@/services/file-explorer/worker/types';

class MockFileSystemFileHandle {
  kind = 'file' as const;
  private _size: number;
  private _lastModified: number;

  constructor(
    public name: string,
    size = 0,
    lastModified = 1000,
  ) {
    this._size = size;
    this._lastModified = lastModified;
  }

  async getFile(): Promise<{ size: number, lastModified: number }> {
    return { size: this._size, lastModified: this._lastModified };
  }
}

class MockExplorerDirectory implements ExplorerDirectory {
  readonly readOnly = false;
  private _entries = new Map<string, MockExplorerDirectory | MockFileSystemFileHandle>();

  constructor(public readonly name: string) {}

  async *children(): AsyncIterable<ExplorerChild> {
    for (const [, entry] of this._entries) {
      if (entry instanceof MockExplorerDirectory) {
        yield { kind: 'directory', name: entry.name, readOnly: false, directory: entry };
      } else {
        yield { kind: 'file', name: entry.name, readOnly: false, fileHandle: entry as unknown as FileSystemFileHandle };
      }
    }
  }

  async subdir({ name }: { name: string }): Promise<ExplorerDirectory | null> {
    const e = this._entries.get(name);
    return e instanceof MockExplorerDirectory ? e : null;
  }

  async subdirCreate({ name }: { name: string }): Promise<ExplorerDirectory> {
    let d = this._entries.get(name);
    if (!(d instanceof MockExplorerDirectory)) {
      d = new MockExplorerDirectory(name);
      this._entries.set(name, d);
    }
    return d;
  }

  async file({ name }: { name: string }): Promise<FileSystemFileHandle | null> {
    const e = this._entries.get(name);
    return e instanceof MockExplorerDirectory ? null : (e as unknown as FileSystemFileHandle) ?? null;
  }

  async fileCreate({ name }: { name: string }): Promise<FileSystemFileHandle> {
    let fh = this._entries.get(name);
    if (!fh || fh instanceof MockExplorerDirectory) {
      fh = new MockFileSystemFileHandle(name);
      this._entries.set(name, fh);
    }
    return fh as unknown as FileSystemFileHandle;
  }

  async remove({ name }: { name: string, recursive: boolean }): Promise<void> {
    this._entries.delete(name);
  }

  async isSameAs({ other }: { other: ExplorerDirectory }): Promise<boolean> {
    return this === other;
  }

  addFile(name: string, size = 0, lastModified = 1000): MockFileSystemFileHandle {
    const fh = new MockFileSystemFileHandle(name, size, lastModified);
    this._entries.set(name, fh);
    return fh;
  }

  addDir(nameOrDir: string | MockExplorerDirectory): MockExplorerDirectory {
    if (nameOrDir instanceof MockExplorerDirectory) {
      this._entries.set(nameOrDir.name, nameOrDir);
      return nameOrDir;
    }
    const d = new MockExplorerDirectory(nameOrDir);
    this._entries.set(nameOrDir, d);
    return d;
  }
}

let activeRoot: MockExplorerDirectory;

function normalizePath(path: string): string {
  return path === '/' ? '/' : `/${path.split('/').filter(Boolean).join('/')}`;
}

function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

async function resolveDirectory({ path }: { path: string }): Promise<MockExplorerDirectory> {
  let current = activeRoot;
  for (const segment of splitPath(path)) {
    const next = await current.subdir({ name: segment });
    if (!(next instanceof MockExplorerDirectory)) {
      throw new Error(`Directory not found: ${path}`);
    }
    current = next;
  }
  return current;
}

async function readDirectory({ path }: { path: string }): Promise<{
  directoryName: string,
  directoryPath: string,
  readOnly: boolean,
  pathSegments: FileExplorerPathSegment[],
  entries: FileExplorerEntry[],
}> {
  const normalizedPath = normalizePath(path);
  const directory = await resolveDirectory({ path: normalizedPath });
  const entries: FileExplorerEntry[] = [];
  for await (const child of directory.children()) {
    switch (child.kind) {
    case 'directory':
      entries.push({
        path: normalizedPath === '/' ? `/${child.name}` : `${normalizedPath}/${child.name}`,
        name: child.name,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly: false,
        canNavigate: true,
        canMutate: true,
      });
      break;
    case 'file': {
      const file = await child.fileHandle.getFile();
      const extension = child.name.includes('.') ? `.${child.name.split('.').pop()}` : '';
      entries.push({
        path: normalizedPath === '/' ? `/${child.name}` : `${normalizedPath}/${child.name}`,
        name: child.name,
        kind: 'file',
        size: file.size,
        lastModified: file.lastModified,
        extension,
        mimeCategory: 'binary',
        readOnly: false,
        canNavigate: false,
        canMutate: true,
      });
      break;
    }
    default: {
      const _exhaustiveCheck: never = child;
      throw new Error(`Unhandled child kind: ${JSON.stringify(_exhaustiveCheck)}`);
    }
    }
  }

  const segments = splitPath(normalizedPath);
  return {
    directoryName: segments.at(-1) ?? activeRoot.name,
    directoryPath: normalizedPath,
    readOnly: false,
    pathSegments: [
      { name: activeRoot.name, path: '/' },
      ...segments.map((name, index) => ({
        name,
        path: `/${segments.slice(0, index + 1).join('/')}`,
      })),
    ],
    entries,
  };
}

const defaultSort = ref<SortConfig>({ field: 'name', direction: 'ascending' });
const defaultFilter = ref<string>('');

function makeClient(): FileExplorerWorkerClient {
  return {
    readDirectory: vi.fn(async ({ path }: { path: string }) => readDirectory({ path })),
    readPreview: vi.fn(),
    readFile: vi.fn(),
    createFile: vi.fn(),
    createFolder: vi.fn(),
    deleteEntries: vi.fn(),
    renameEntry: vi.fn(),
    copyEntries: vi.fn(),
    moveEntries: vi.fn(),
    uploadFiles: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeNav(root: MockExplorerDirectory, initialPath: string | undefined = '/') {
  activeRoot = root;
  return useFileExplorerNavigation({
    client: makeClient(),
    sortConfig: defaultSort,
    filterQuery: defaultFilter,
    initialPath,
  });
}

describe('useFileExplorerNavigation', () => {
  let root: MockExplorerDirectory;

  beforeEach(() => {
    root = new MockExplorerDirectory('root');
    activeRoot = root;
    defaultSort.value = { field: 'name', direction: 'ascending' };
    defaultFilter.value = '';
  });

  it('loads root directory entries on init', async () => {
    root.addFile('a.txt', 100);
    root.addDir('subdir');
    const { entries, isLoading } = makeNav(root);
    await flushPromises();
    expect(isLoading.value).toBe(false);
    expect(entries.value.length).toBe(2);
  });

  it('entries include correct kind and extension', async () => {
    root.addFile('hello.md', 50);
    root.addDir('docs');
    const { entries } = makeNav(root);
    await flushPromises();
    const file = entries.value.find(e => e.name === 'hello.md');
    expect(file?.kind).toBe('file');
    expect(file?.extension).toBe('.md');
    const dir = entries.value.find(e => e.name === 'docs');
    expect(dir?.kind).toBe('directory');
    expect(dir?.extension).toBe('');
  });

  it('entries have size and lastModified populated for files', async () => {
    root.addFile('data.txt', 1024, 2000);
    const { entries } = makeNav(root);
    await flushPromises();
    const file = entries.value.find(e => e.name === 'data.txt');
    expect(file?.size).toBe(1024);
    expect(file?.lastModified).toBe(2000);
  });

  it('sortedFilteredEntries returns sorted entries — directories first', async () => {
    root.addFile('z.txt');
    root.addFile('a.txt');
    root.addDir('m');
    const { sortedFilteredEntries } = makeNav(root);
    await flushPromises();
    const names = sortedFilteredEntries.value.map(e => e.name);
    expect(names[0]).toBe('m');
    expect(names[1]).toBe('a.txt');
    expect(names[2]).toBe('z.txt');
  });

  it('sortedFilteredEntries filters by query', async () => {
    root.addFile('alpha.txt');
    root.addFile('beta.txt');
    const { sortedFilteredEntries } = makeNav(root);
    await flushPromises();
    defaultFilter.value = 'alpha';
    await flushPromises();
    expect(sortedFilteredEntries.value.map(e => e.name)).toEqual(['alpha.txt']);
  });

  it('pathSegments starts with root only', async () => {
    const { pathSegments } = makeNav(root);
    await flushPromises();
    expect(pathSegments.value).toHaveLength(1);
    expect(pathSegments.value[0]!.name).toBe('root');
  });

  it('navigateToDirectory pushes to path stack', async () => {
    root.addDir('sub');
    const { pathSegments, navigateToDirectory } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ path: '/sub' });
    expect(pathSegments.value).toHaveLength(2);
    expect(pathSegments.value[1]!.name).toBe('sub');
  });

  it('navigateToDirectory loads subdirectory entries', async () => {
    const sub = root.addDir('sub');
    sub.addFile('child.txt', 10);
    const { entries, navigateToDirectory } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ path: '/sub' });
    expect(entries.value.some(e => e.name === 'child.txt')).toBe(true);
  });

  it('navigateUp returns to parent directory', async () => {
    root.addDir('sub');
    root.addFile('top.txt');
    const { entries, pathSegments, navigateToDirectory, navigateUp } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ path: '/sub' });
    await navigateUp();
    expect(pathSegments.value).toHaveLength(1);
    expect(entries.value.some(e => e.name === 'top.txt')).toBe(true);
  });

  it('navigateUp is a no-op at root', async () => {
    const { pathSegments, navigateUp } = makeNav(root);
    await flushPromises();
    await navigateUp();
    expect(pathSegments.value).toHaveLength(1);
  });

  it('jumpToBreadcrumb navigates to ancestor', async () => {
    const sub = root.addDir('sub');
    sub.addDir('deep');
    root.addFile('root-file.txt');
    const { entries, pathSegments, navigateToDirectory, jumpToBreadcrumb } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ path: '/sub' });
    await navigateToDirectory({ path: '/sub/deep' });
    expect(pathSegments.value).toHaveLength(3);
    await jumpToBreadcrumb({ index: 0 });
    expect(pathSegments.value).toHaveLength(1);
    expect(entries.value.some(e => e.name === 'root-file.txt')).toBe(true);
  });

  it('jumpToBreadcrumb is a no-op for current (last) segment', async () => {
    root.addDir('sub');
    const { pathSegments, navigateToDirectory, jumpToBreadcrumb } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ path: '/sub' });
    await jumpToBreadcrumb({ index: 1 });
    expect(pathSegments.value).toHaveLength(2);
  });

  it('refresh reloads the current directory', async () => {
    const { entries, refresh } = makeNav(root);
    await flushPromises();
    expect(entries.value).toHaveLength(0);
    root.addFile('new.txt');
    await refresh();
    expect(entries.value.some(e => e.name === 'new.txt')).toBe(true);
  });

  it('shows a clearer message when the directory is no longer accessible', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    const client = makeClient();
    client.readDirectory = vi.fn(async () => {
      throw new DOMException(
        'A requested file or directory could not be found at the time an operation was processed.',
        'NotFoundError',
      );
    });
    activeRoot = root;
    const nav = useFileExplorerNavigation({
      client,
      sortConfig: defaultSort,
      filterQuery: defaultFilter,
      initialPath: '/missing',
    });
    await flushPromises();
    expect(nav.loadError.value).toBe(
      'Failed to load directory: This folder is no longer available. It may have been moved, deleted, or its access was revoked in the browser.',
    );
  });
});
