import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useFileExplorerNavigation } from './useFileExplorerNavigation';
import type { SortConfig } from './types';

// ---- Mock FileSystem API ----

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

  async getFile(): Promise<{ size: number; lastModified: number }> {
    return { size: this._size, lastModified: this._lastModified };
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();

  constructor(public name: string) {}

  async *values() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  addFile(name: string, size = 0, lastModified = 1000): MockFileSystemFileHandle {
    const fh = new MockFileSystemFileHandle(name, size, lastModified);
    this.entries.set(name, fh);
    return fh;
  }

  addDir(name: string): MockFileSystemDirectoryHandle {
    const dh = new MockFileSystemDirectoryHandle(name);
    this.entries.set(name, dh);
    return dh;
  }
}

// ---- Test helpers ----

const defaultSort = ref<SortConfig>({ field: 'name', direction: 'ascending' });
const defaultFilter = ref<string>('');

function makeNav(root: MockFileSystemDirectoryHandle) {
  return useFileExplorerNavigation({
    root: root as unknown as FileSystemDirectoryHandle,
    sortConfig: defaultSort,
    filterQuery: defaultFilter,
  });
}

// ---- Tests ----

describe('useFileExplorerNavigation', () => {
  let root: MockFileSystemDirectoryHandle;

  beforeEach(() => {
    root = new MockFileSystemDirectoryHandle('root');
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
    // directories first, then files alphabetically
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
    const sub = root.addDir('sub');
    const { pathSegments, navigateToDirectory } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ handle: sub as unknown as FileSystemDirectoryHandle });
    expect(pathSegments.value).toHaveLength(2);
    expect(pathSegments.value[1]!.name).toBe('sub');
  });

  it('navigateToDirectory loads subdirectory entries', async () => {
    const sub = root.addDir('sub');
    sub.addFile('child.txt', 10);
    const { entries, navigateToDirectory } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ handle: sub as unknown as FileSystemDirectoryHandle });
    expect(entries.value.some(e => e.name === 'child.txt')).toBe(true);
  });

  it('navigateUp returns to parent directory', async () => {
    const sub = root.addDir('sub');
    root.addFile('top.txt');
    const { entries, pathSegments, navigateToDirectory, navigateUp } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ handle: sub as unknown as FileSystemDirectoryHandle });
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
    const deep = sub.addDir('deep');
    root.addFile('root-file.txt');
    const { entries, pathSegments, navigateToDirectory, jumpToBreadcrumb } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ handle: sub as unknown as FileSystemDirectoryHandle });
    await navigateToDirectory({ handle: deep as unknown as FileSystemDirectoryHandle });
    expect(pathSegments.value).toHaveLength(3);
    // jump back to root (index 0)
    await jumpToBreadcrumb({ index: 0 });
    expect(pathSegments.value).toHaveLength(1);
    expect(entries.value.some(e => e.name === 'root-file.txt')).toBe(true);
  });

  it('jumpToBreadcrumb is a no-op for current (last) segment', async () => {
    const sub = root.addDir('sub');
    const { pathSegments, navigateToDirectory, jumpToBreadcrumb } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ handle: sub as unknown as FileSystemDirectoryHandle });
    await jumpToBreadcrumb({ index: 1 }); // index of current (last) → no-op
    expect(pathSegments.value).toHaveLength(2);
  });

  it('refresh reloads the current directory', async () => {
    const { entries, refresh } = makeNav(root);
    await flushPromises();
    expect(entries.value).toHaveLength(0);
    // Add a file after initial load
    root.addFile('new.txt');
    await refresh();
    expect(entries.value.some(e => e.name === 'new.txt')).toBe(true);
  });

  it('currentHandle reflects current directory', async () => {
    const sub = root.addDir('sub');
    const { currentHandle, navigateToDirectory } = makeNav(root);
    await flushPromises();
    expect(currentHandle.value.name).toBe('root');
    await navigateToDirectory({ handle: sub as unknown as FileSystemDirectoryHandle });
    expect(currentHandle.value.name).toBe('sub');
  });

  // ---- column view ----

  it('columnPanes initialized with root pane', async () => {
    const { columnPanes } = makeNav(root);
    await flushPromises();
    expect(columnPanes.value).toHaveLength(1);
    expect(columnPanes.value[0]!.handle.name).toBe('root');
  });

  it('selectColumnEntry adds a new pane for a directory', async () => {
    root.addDir('sub');
    const { columnPanes, selectColumnEntry } = makeNav(root);
    await flushPromises();
    await selectColumnEntry({ paneIndex: 0, entryName: 'sub' });
    await flushPromises();
    expect(columnPanes.value.length).toBeGreaterThanOrEqual(2);
    expect(columnPanes.value[1]!.handle.name).toBe('sub');
  });

  it('selectColumnEntry updates selectedEntryName in pane', async () => {
    root.addDir('sub');
    const { columnPanes, selectColumnEntry } = makeNav(root);
    await flushPromises();
    await selectColumnEntry({ paneIndex: 0, entryName: 'sub' });
    await flushPromises();
    expect(columnPanes.value[0]!.selectedEntryName).toBe('sub');
  });

  it('selectColumnEntry on a file does not add new pane', async () => {
    root.addFile('a.txt');
    const { columnPanes, selectColumnEntry } = makeNav(root);
    await flushPromises();
    const initialLength = columnPanes.value.length;
    await selectColumnEntry({ paneIndex: 0, entryName: 'a.txt' });
    await flushPromises();
    expect(columnPanes.value.length).toBe(initialLength);
  });

  it('mimeCategory is set based on extension', async () => {
    root.addFile('photo.png');
    const { entries } = makeNav(root);
    await flushPromises();
    const entry = entries.value.find(e => e.name === 'photo.png');
    expect(entry?.mimeCategory).toBe('image');
  });

  it('loadError is set on directory read failure', async () => {
    const badRoot = new MockFileSystemDirectoryHandle('bad');
    // Override values to throw before yielding anything
    badRoot.values = async function*() {
      yield* ((): never[] => {
        throw new Error('permission denied');
      })();
    };
    const { isLoading, loadError } = makeNav(badRoot);
    await flushPromises();
    expect(isLoading.value).toBe(false);
    expect(loadError.value).toContain('permission denied');
  });
});
