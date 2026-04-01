import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useFileExplorerNavigation } from './useFileExplorerNavigation';
import type { SortConfig } from './types';
import type { ExplorerDirectory, ExplorerChild } from './explorer-directory';

// ---- Mock ExplorerDirectory ----

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

  async remove({ name }: { name: string; recursive: boolean }): Promise<void> {
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

// ---- Test helpers ----

const defaultSort = ref<SortConfig>({ field: 'name', direction: 'ascending' });
const defaultFilter = ref<string>('');

function makeNav(root: MockExplorerDirectory) {
  return useFileExplorerNavigation({
    root,
    sortConfig: defaultSort,
    filterQuery: defaultFilter,
    initialStack: undefined,
  });
}

// ---- Tests ----

describe('useFileExplorerNavigation', () => {
  let root: MockExplorerDirectory;

  beforeEach(() => {
    root = new MockExplorerDirectory('root');
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
    await navigateToDirectory({ directory: sub });
    expect(pathSegments.value).toHaveLength(2);
    expect(pathSegments.value[1]!.name).toBe('sub');
  });

  it('navigateToDirectory loads subdirectory entries', async () => {
    const sub = root.addDir('sub');
    sub.addFile('child.txt', 10);
    const { entries, navigateToDirectory } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ directory: sub });
    expect(entries.value.some(e => e.name === 'child.txt')).toBe(true);
  });

  it('navigateUp returns to parent directory', async () => {
    const sub = root.addDir('sub');
    root.addFile('top.txt');
    const { entries, pathSegments, navigateToDirectory, navigateUp } = makeNav(root);
    await flushPromises();
    await navigateToDirectory({ directory: sub });
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
    await navigateToDirectory({ directory: sub });
    await navigateToDirectory({ directory: deep });
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
    await navigateToDirectory({ directory: sub });
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

  it('currentDirectory reflects current directory', async () => {
    const sub = root.addDir('sub');
    const { currentDirectory, navigateToDirectory } = makeNav(root);
    await flushPromises();
    expect(currentDirectory.value.name).toBe('root');
    await navigateToDirectory({ directory: sub });
    expect(currentDirectory.value.name).toBe('sub');
  });

  // ---- column view ----

  it('columnPanes initialized with root pane', async () => {
    const { columnPanes } = makeNav(root);
    await flushPromises();
    expect(columnPanes.value).toHaveLength(1);
    expect(columnPanes.value[0]!.directory.name).toBe('root');
  });

  it('selectColumnEntry adds a new pane for a directory', async () => {
    root.addDir('sub');
    const { columnPanes, selectColumnEntry } = makeNav(root);
    await flushPromises();
    await selectColumnEntry({ paneIndex: 0, entryName: 'sub' });
    await flushPromises();
    expect(columnPanes.value.length).toBeGreaterThanOrEqual(2);
    expect(columnPanes.value[1]!.directory.name).toBe('sub');
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
    const badRoot = new class extends MockExplorerDirectory {
      // Override children to throw before yielding anything
      override async *children(): AsyncIterable<ExplorerChild> {
        throw new Error('permission denied');

        yield* [];
      }
    }('bad');
    const { isLoading, loadError } = makeNav(badRoot);
    await flushPromises();
    expect(isLoading.value).toBe(false);
    expect(loadError.value).toContain('permission denied');
  });

  describe('initialStack', () => {
    it('opens directly at the deepest directory when initialStack is provided', async () => {
      const child = new MockExplorerDirectory('child');
      child.addFile('deep.txt', 42);
      root.addDir(child);

      const nav = useFileExplorerNavigation({
        root,
        sortConfig: defaultSort,
        filterQuery: defaultFilter,
        initialStack: [child],
      });
      await flushPromises();

      expect(nav.currentDirectory.value).toBe(child);
      expect(nav.entries.value.map(e => e.name)).toEqual(['deep.txt']);
    });

    it('pathSegments includes root and every stack entry', async () => {
      const mid = new MockExplorerDirectory('mid');
      const leaf = new MockExplorerDirectory('leaf');
      root.addDir(mid);
      mid.addDir(leaf);

      const nav = useFileExplorerNavigation({
        root,
        sortConfig: defaultSort,
        filterQuery: defaultFilter,
        initialStack: [mid, leaf],
      });
      await flushPromises();

      const names = nav.pathSegments.value.map(s => s.name);
      expect(names).toEqual(['root', 'mid', 'leaf']);
    });

    it('can navigate up after being opened with initialStack', async () => {
      const child = new MockExplorerDirectory('child');
      root.addFile('top.txt');
      root.addDir(child);

      const nav = useFileExplorerNavigation({
        root,
        sortConfig: defaultSort,
        filterQuery: defaultFilter,
        initialStack: [child],
      });
      await flushPromises();

      await nav.navigateUp();
      await flushPromises();

      expect(nav.currentDirectory.value).toBe(root);
      const names = nav.entries.value.map(e => e.name).sort();
      expect(names).toEqual(['child', 'top.txt']);
    });
  });
});
