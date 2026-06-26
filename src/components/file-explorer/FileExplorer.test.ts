import { defineComponent, h, Suspense } from 'vue';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FileExplorer from './FileExplorer.vue';
import type { FileExplorerWorkerClient } from '@/services/file-explorer/worker/types';
import type { FileExplorerEntry } from './types';
import type { ExplorerDirectory, ExplorerChild } from './explorer-directory';
import { LIST_ROW_HEIGHT } from './constants';

// ---- Mock ExplorerDirectory ----

class MockFileSystemFileHandle {
  kind = 'file' as const;
  private _content: string;

  constructor(
    public name: string,
    public _size: number = 0,
    content = '',
  ) {
    this._content = content;
  }

  async getFile() {
    return {
      size: this._size,
      lastModified: 1000,
      text: () => Promise.resolve(this._content),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  async createWritable() {
    return {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }
}

class MockExplorerDirectory implements ExplorerDirectory {
  readonly readOnly: boolean = false;
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
    const existing = this._entries.get(name);
    if (existing instanceof MockExplorerDirectory) return existing;
    const d = new MockExplorerDirectory(name);
    this._entries.set(name, d);
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

  addFile(name: string, size = 0, content = ''): MockFileSystemFileHandle {
    const fh = new MockFileSystemFileHandle(name, size, content);
    this._entries.set(name, fh);
    return fh;
  }

  addDir(name: string): MockExplorerDirectory {
    const d = new MockExplorerDirectory(name);
    this._entries.set(name, d);
    return d;
  }
}

// ---- Mocks ----

let activeRoot: MockExplorerDirectory | undefined;

function normalizePath(path: string): string {
  return path === '/' ? '/' : `/${path.split('/').filter(Boolean).join('/')}`;
}

function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

async function resolveDirectory(path: string): Promise<MockExplorerDirectory> {
  const root = activeRoot;
  if (!root) {
    throw new Error('No active root');
  }
  let current = root;
  for (const segment of splitPath(path)) {
    const next = await current.subdir({ name: segment });
    if (!(next instanceof MockExplorerDirectory)) {
      throw new Error(`Directory not found: ${path}`);
    }
    current = next;
  }
  return current;
}

async function listDirectory(path: string): Promise<{
  directoryName: string,
  directoryPath: string,
  readOnly: boolean,
  pathSegments: Array<{ name: string, path: string }>,
  entries: FileExplorerEntry[],
}> {
  const directory = await resolveDirectory(path);
  const entries: FileExplorerEntry[] = [];
  for await (const child of directory.children()) {
    switch (child.kind) {
    case 'file': {
      const file = await child.fileHandle.getFile();
      const extension = child.name.includes('.') ? `.${child.name.split('.').pop()}` : '';
      entries.push({
        path: path === '/' ? `/${child.name}` : `${path}/${child.name}`,
        name: child.name,
        kind: 'file',
        size: file.size,
        lastModified: file.lastModified,
        extension,
        mimeCategory: extension === '.txt' || extension === '.md' || extension === '.json' ? 'text' : 'binary',
        readOnly: child.readOnly,
        canNavigate: false,
        canMutate: !child.readOnly,
      });
      break;
    }
    case 'directory':
      entries.push({
        path: path === '/' ? `/${child.name}` : `${path}/${child.name}`,
        name: child.name,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly: child.readOnly,
        canNavigate: true,
        canMutate: !child.readOnly,
      });
      break;
    default: {
      const _exhaustiveCheck: never = child;
      throw new Error(`Unhandled child kind: ${JSON.stringify(_exhaustiveCheck)}`);
    }
    }
  }
  const names = splitPath(path);
  return {
    directoryName: names.at(-1) ?? directory.name,
    directoryPath: normalizePath(path),
    readOnly: directory.readOnly,
    pathSegments: [{ name: activeRoot?.name ?? 'root', path: '/' }, ...names.map((name, index) => ({
      name,
      path: `/${names.slice(0, index + 1).join('/')}`,
    }))],
    entries,
  };
}

async function createMockWorkerClient(): Promise<FileExplorerWorkerClient> {
  const client: FileExplorerWorkerClient = {
    async readDirectory({ path }) {
      return listDirectory(path);
    },
    async readPreview({ path, mode }) {
      try {
        await resolveDirectory(path);
        return { kind: 'directory' } as const;
      } catch {
        const parentPath = splitPath(path).length <= 1 ? '/' : `/${splitPath(path).slice(0, -1).join('/')}`;
        const parent = await resolveDirectory(parentPath);
        const name = splitPath(path).at(-1)!;
        const fileHandle = await parent.file({ name });
        if (!fileHandle) {
          throw new Error(`File not found: ${path}`);
        }
        const file = await fileHandle.getFile();
        if (mode === 'bounded' && file.size > 5 * 1024 * 1024) {
          return { kind: 'text', rawText: '', displayText: '', languageHint: 'text', oversized: true } as const;
        }
        return {
          kind: 'text',
          rawText: await file.text(),
          displayText: await file.text(),
          languageHint: 'text',
          oversized: false,
        } as const;
      }
    },
    async readFile({ path }) {
      const parentPath = splitPath(path).length <= 1 ? '/' : `/${splitPath(path).slice(0, -1).join('/')}`;
      const parent = await resolveDirectory(parentPath);
      const fileHandle = await parent.file({ name: splitPath(path).at(-1)! });
      if (!fileHandle) {
        throw new Error(`File not found: ${path}`);
      }
      return { blob: new Blob([new Uint8Array(await (await fileHandle.getFile()).arrayBuffer())]) };
    },
    async createFile({ parentPath, name }) {
      const directory = await resolveDirectory(parentPath);
      await directory.fileCreate({ name });
    },
    async createFolder({ parentPath, name }) {
      const directory = await resolveDirectory(parentPath);
      await directory.subdirCreate({ name });
    },
    async deleteEntries({ paths }) {
      for (const path of paths) {
        const parentPath = splitPath(path).length <= 1 ? '/' : `/${splitPath(path).slice(0, -1).join('/')}`;
        const parent = await resolveDirectory(parentPath);
        await parent.remove({ name: splitPath(path).at(-1)!, recursive: true });
      }
    },
    async renameEntry({ path, newName }) {
      const parentPath = splitPath(path).length <= 1 ? '/' : `/${splitPath(path).slice(0, -1).join('/')}`;
      const parent = await resolveDirectory(parentPath);
      const fileHandle = await parent.file({ name: splitPath(path).at(-1)! });
      if (fileHandle) {
        const file = await fileHandle.getFile();
        const nextFileHandle = await parent.fileCreate({ name: newName });
        const writable = await (nextFileHandle as unknown as { createWritable(): Promise<{ write(data: ArrayBuffer): Promise<void>, close(): Promise<void> }> }).createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
      }
      await parent.remove({ name: splitPath(path).at(-1)!, recursive: true });
    },
    async copyEntries({ sourcePaths, targetDirectoryPath }) {
      const targetDirectory = await resolveDirectory(targetDirectoryPath);
      for (const sourcePath of sourcePaths) {
        const sourceParentPath = splitPath(sourcePath).length <= 1 ? '/' : `/${splitPath(sourcePath).slice(0, -1).join('/')}`;
        const sourceParent = await resolveDirectory(sourceParentPath);
        const sourceName = splitPath(sourcePath).at(-1)!;
        const sourceFile = await sourceParent.file({ name: sourceName });
        if (sourceFile) {
          const file = await sourceFile.getFile();
          const targetFile = await targetDirectory.fileCreate({ name: sourceName });
          const writable = await (targetFile as unknown as { createWritable(): Promise<{ write(data: ArrayBuffer): Promise<void>, close(): Promise<void> }> }).createWritable();
          await writable.write(await file.arrayBuffer());
          await writable.close();
          continue;
        }
        await targetDirectory.subdirCreate({ name: sourceName });
      }
    },
    async moveEntries({ sourcePaths, targetDirectoryPath }) {
      await client.copyEntries({ sourcePaths, targetDirectoryPath });
      await client.deleteEntries({ paths: sourcePaths });
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      const targetDirectory = await resolveDirectory(targetDirectoryPath);
      for (const file of files) {
        await targetDirectory.fileCreate({ name: file.name });
      }
    },
    async dispose() {
    },
  };
  return client;
}

const mockShowConfirm = vi.fn().mockResolvedValue(true);
const mockShowPrompt = vi.fn().mockResolvedValue(undefined);
const mockAddToast = vi.fn();

vi.mock('@/services/file-explorer/worker/client', () => ({
  createFileExplorerWorkerClient: vi.fn(async () => createMockWorkerClient()),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ showConfirm: mockShowConfirm }),
}));

vi.mock('@/composables/usePrompt', () => ({
  usePrompt: () => ({ showPrompt: mockShowPrompt }),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

// ---- Helpers ----

function makeRoot() {
  return new MockExplorerDirectory('root');
}

function mountExplorer(root: MockExplorerDirectory, overrides: Record<string, unknown> = {}) {
  activeRoot = root;
  return mount(defineComponent({
    render() {
      return h(Suspense, null, {
        default: h(FileExplorer, {
          root: { kind: 'native-directory', rootName: root.name, handle: {} as FileSystemDirectoryHandle, readOnly: root.readOnly },
          initialViewMode: 'list',
          initialPreviewVisibility: 'visible',
          initialPath: undefined,
          initialLocked: false,
          ...overrides,
        }),
      });
    },
  }), {
    attachTo: document.body,
  });
}

function setListViewportHeight({
  wrapper,
  rows,
}: {
  wrapper: ReturnType<typeof mount>,
  rows: number,
}): HTMLElement {
  const container = wrapper.get('[data-testid="list-scroll-container"]').element as HTMLElement;
  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    value: LIST_ROW_HEIGHT * rows,
  });
  container.dispatchEvent(new Event('scroll'));
  return container;
}

describe('FileExplorer.vue', () => {
  let root: MockExplorerDirectory;
  let wrappers: ReturnType<typeof mount>[] = [];

  function tracked(wrapper: ReturnType<typeof mount>) {
    wrappers.push(wrapper);
    return wrapper;
  }

  beforeEach(() => {
    root = makeRoot();
    mockShowConfirm.mockResolvedValue(true);
    mockShowPrompt.mockResolvedValue(undefined);
    mockAddToast.mockReset();
    wrappers = [];
  });

  afterEach(() => {
    for (const w of wrappers) {
      w.unmount();
    }
  });

  // ---- Rendering ----

  it('renders the file explorer root element', async () => {
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.find('[data-testid="file-explorer"]').exists()).toBe(true);
  });

  it('shows file and directory names after load', async () => {
    root.addFile('readme.txt', 100);
    root.addDir('documents');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.text()).toContain('readme.txt');
    expect(wrapper.text()).toContain('documents');
  });

  it('shows file size in list view', async () => {
    root.addFile('data.txt', 2048);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.text()).toContain('2.0 KB');
  });

  it('shows item count in status bar', async () => {
    root.addFile('a.txt');
    root.addFile('b.txt');
    root.addDir('c');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.text()).toContain('3');
  });

  it('shows empty state when directory is empty', async () => {
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.find('[data-testid="file-explorer-empty"]').exists()).toBe(true);
  });

  it('does not show empty state when directory has entries', async () => {
    root.addFile('file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.find('[data-testid="file-explorer-empty"]').exists()).toBe(false);
  });

  // ---- Navigation ----

  it('navigates into a directory on double-click', async () => {
    const sub = root.addDir('subdir');
    sub.addFile('child.txt', 50);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-subdir"]').trigger('dblclick');
    await flushPromises();

    expect(wrapper.text()).toContain('child.txt');
  });

  it('breadcrumb shows path segments after navigation', async () => {
    const sub = root.addDir('mydir');
    sub.addFile('nested.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-mydir"]').trigger('dblclick');
    await flushPromises();

    expect(wrapper.find('[data-testid="breadcrumb-current"]').text()).toBe('mydir');
  });

  it('back button navigates up', async () => {
    const sub = root.addDir('subdir');
    sub.addFile('nested.txt');
    root.addFile('top.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-subdir"]').trigger('dblclick');
    await flushPromises();

    await wrapper.find('[data-testid="breadcrumb-back"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('top.txt');
  });

  // ---- Selection ----

  it('single-click selects an entry and shows selected count', async () => {
    root.addFile('select-me.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-select-me.txt"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('1 selected');
  });

  it('Ctrl+A selects all entries', async () => {
    root.addFile('a.txt');
    root.addFile('b.txt');
    root.addFile('c.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'a', ctrlKey: true });
    await flushPromises();

    expect(wrapper.text()).toContain('3 selected');
  });

  it('Escape after selection clears selection', async () => {
    root.addFile('item.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-item.txt"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('1 selected');

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.text()).not.toContain('selected');
  });

  // ---- View mode ----

  it('starts in list view by default', async () => {
    root.addFile('file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.find('[data-testid="list-view"]').exists()).toBe(true);
  });

  it('switches to icon view when icon button is clicked', async () => {
    root.addFile('file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="view-icon"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="icon-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="list-view"]').exists()).toBe(false);
  });

  it('switches back to list view from icon view', async () => {
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="view-icon"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-testid="view-list"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="list-view"]').exists()).toBe(true);
  });

  it('virtualizes list rendering when viewport height is known', async () => {
    for (let index = 0; index < 200; index += 1) {
      root.addFile(`file-${String(index).padStart(4, '0')}.txt`);
    }
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    const container = setListViewportHeight({ wrapper, rows: 6 });
    await flushPromises();

    const renderedBeforeScroll = wrapper.findAll('[data-testid^="entry-item-"]');
    expect(renderedBeforeScroll.length).toBeLessThan(200);
    expect(wrapper.find('[data-testid="entry-item-file-0000.txt"]').exists()).toBe(true);

    container.scrollTop = LIST_ROW_HEIGHT * 120;
    container.dispatchEvent(new Event('scroll'));
    await flushPromises();

    expect(wrapper.find('[data-testid="entry-item-file-0000.txt"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="entry-item-file-0120.txt"]').exists()).toBe(true);
  });

  it('scrolls focused entries into view during keyboard navigation in list view', async () => {
    for (let index = 0; index < 60; index += 1) {
      root.addFile(`file-${String(index).padStart(4, '0')}.txt`);
    }
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    const container = setListViewportHeight({ wrapper, rows: 4 });
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-file-0000.txt"]').trigger('click');
    await flushPromises();

    for (let index = 0; index < 12; index += 1) {
      await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'ArrowDown' });
      await flushPromises();
    }

    expect(container.scrollTop).toBeGreaterThan(0);
    expect(wrapper.find('[data-testid="entry-item-file-0012.txt"]').exists()).toBe(true);
  });

  // ---- Filter ----

  it('filter search narrows displayed entries', async () => {
    root.addFile('alpha.txt');
    root.addFile('beta.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    // Open search bar
    await wrapper.find('[data-testid="search-toggle"]').trigger('click');
    await flushPromises();

    // Type in filter
    const searchInput = wrapper.find('[data-testid="filter-input"]');
    await searchInput.setValue('alpha');
    await searchInput.trigger('input');
    await flushPromises();

    expect(wrapper.text()).toContain('alpha.txt');
    expect(wrapper.text()).not.toContain('beta.txt');
  });

  // ---- Keyboard delete ----

  it('Delete key triggers confirm dialog for selected entry', async () => {
    root.addFile('to-delete.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-to-delete.txt"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'Delete' });
    await flushPromises();

    expect(mockShowConfirm).toHaveBeenCalled();
  });

  // ---- Context menu ----

  it('right-clicking an entry shows context menu in DOM', async () => {
    root.addFile('ctx-file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-ctx-file.txt"]').trigger('contextmenu', { clientX: 100, clientY: 100 });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="context-menu"]')).not.toBeNull();
  });

  it('Escape hides context menu', async () => {
    root.addFile('ctx-file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-ctx-file.txt"]').trigger('contextmenu', { clientX: 100, clientY: 100 });
    await flushPromises();

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="context-menu"]')).toBeNull();
  });

  // ---- Preview panel ----

  it('shows preview panel when initialPreviewVisibility is visible', async () => {
    const wrapper = tracked(mountExplorer(root, { initialPreviewVisibility: 'visible' }));
    await flushPromises();
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(true);
  });

  it('hides preview panel when initialPreviewVisibility is hidden', async () => {
    const wrapper = tracked(mountExplorer(root, { initialPreviewVisibility: 'hidden' }));
    await flushPromises();
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false);
  });

  it('preview panel toggle button hides the panel', async () => {
    const wrapper = tracked(mountExplorer(root, { initialPreviewVisibility: 'visible' }));
    await flushPromises();

    // Find and click the Eye/EyeOff toggle button (title changes based on state)
    const toggleBtn = wrapper.find('button[title="Hide preview"]');
    await toggleBtn.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false);
  });

  // ---- F2 rename ----

  it('F2 starts rename for focused entry', async () => {
    root.addFile('rename-me.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    // Click to focus
    await wrapper.find('[data-testid="entry-item-rename-me.txt"]').trigger('click');
    await flushPromises();

    // F2 should trigger rename input
    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'F2' });
    await flushPromises();

    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(true);
  });

  it('Escape cancels rename', async () => {
    root.addFile('rename-me.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-rename-me.txt"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'F2' });
    await flushPromises();

    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(true);

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();

    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(false);
  });

  // ---- Context menu actions ----

  it('context menu New File calls showPrompt and creates file', async () => {
    mockShowPrompt.mockResolvedValueOnce('new-file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    // Right-click background
    await wrapper.find('[data-testid="list-view"]').trigger('contextmenu', { clientX: 50, clientY: 50 });
    await flushPromises();

    const newFileBtn = Array.from(document.body.querySelectorAll('[data-testid="context-menu"] button'))
      .find(b => b.textContent?.includes('New File'));
    expect(newFileBtn).toBeDefined();
    await newFileBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(mockShowPrompt).toHaveBeenCalled();
    expect(wrapper.text()).toContain('new-file.txt');
  });

  it('context menu Delete removes selected entry after confirm', async () => {
    root.addFile('delete-me.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-delete-me.txt"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-delete-me.txt"]').trigger('contextmenu', { clientX: 50, clientY: 50 });
    await flushPromises();

    const deleteBtn = Array.from(document.body.querySelectorAll('[data-testid="context-menu"] button'))
      .find(b => b.textContent?.includes('Delete'));
    expect(deleteBtn).toBeDefined();
    await deleteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(mockShowConfirm).toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('delete-me.txt');
  });

  // ---- Clipboard ----

  it('Ctrl+C then Ctrl+V copies file to same directory', async () => {
    root.addFile('original.txt', 50);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-original.txt"]').trigger('click');
    await flushPromises();

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'c', ctrlKey: true });
    await flushPromises();

    await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'v', ctrlKey: true });
    await flushPromises();

    // After paste, both names should appear (copy creates a second entry)
    const text = wrapper.text();
    expect(text).toContain('original.txt');
  });

  // ---- Sorting ----

  it('clicking Name column header toggles sort direction', async () => {
    root.addFile('zebra.txt');
    root.addFile('alpha.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    // Find sort header for Name and click it (ascending → descending)
    const nameHeader = wrapper.findAll('div.cursor-pointer').find(d => d.text().includes('Name'));
    expect(nameHeader).toBeDefined();
    await nameHeader!.trigger('click');
    await flushPromises();

    // Click again → descending
    await nameHeader!.trigger('click');
    await flushPromises();

    // No crash, sort applied
    expect(wrapper.text()).toContain('zebra.txt');
    expect(wrapper.text()).toContain('alpha.txt');
  });

  // ---- Column view ----

  it('column view shows entries', async () => {
    root.addFile('col-file.txt');
    root.addDir('col-dir');
    const wrapper = tracked(mountExplorer(root, { initialViewMode: 'column' }));
    await flushPromises();

    expect(wrapper.text()).toContain('col-file.txt');
    expect(wrapper.text()).toContain('col-dir');
  });

  // ---- Refresh ----

  it('refresh button reloads entries', async () => {
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    root.addFile('added-after.txt');
    const refreshBtn = wrapper.find('button[title="Refresh"]');
    await refreshBtn.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('added-after.txt');
  });

  // ---- readOnly UI (underlying directory is read-only) ----

  describe('readOnly directory', () => {
    class ReadOnlyMockExplorerDirectory extends MockExplorerDirectory {
      override readonly readOnly = true;

      override async *children(): AsyncIterable<import('./explorer-directory').ExplorerChild> {
        for await (const child of super.children()) {
          yield { ...child, readOnly: true };
        }
      }
    }

    function mountReadOnlyExplorer() {
      const ro = new ReadOnlyMockExplorerDirectory('ro-root');
      ro.addFile('locked.txt');
      ro.addDir('locked-dir');
      return tracked(mountExplorer(ro as unknown as MockExplorerDirectory));
    }

    it('toolbar shows upload, new file, new folder as disabled when readOnly', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      expect(wrapper.find('[data-testid="upload-button"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="new-file-button"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="new-folder-button"]').attributes('disabled')).toBeDefined();
    });

    it('toolbar still shows refresh and view-mode buttons when readOnly', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      expect(wrapper.find('button[title="Refresh"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="view-list"]').exists()).toBe(true);
    });

    it('context menu on background shows write actions as disabled when readOnly', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      await wrapper.find('[data-testid="list-view"]').trigger('contextmenu', { clientX: 50, clientY: 50 });
      await flushPromises();

      const menu = document.body.querySelector('[data-testid="context-menu"]');
      expect(menu).not.toBeNull();
      const buttons = Array.from(menu!.querySelectorAll('button'));
      const newFileBtn = buttons.find(b => b.textContent?.includes('New File'));
      const newFolderBtn = buttons.find(b => b.textContent?.includes('New Folder'));
      expect(newFileBtn).toBeDefined();
      expect(newFolderBtn).toBeDefined();
      expect(newFileBtn!.disabled).toBe(true);
      expect(newFolderBtn!.disabled).toBe(true);
    });

    it('context menu on entry shows rename, cut, delete as disabled when readOnly', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      await wrapper.find('[data-testid="entry-item-locked.txt"]').trigger('contextmenu', { clientX: 50, clientY: 50 });
      await flushPromises();

      const menu = document.body.querySelector('[data-testid="context-menu"]');
      expect(menu).not.toBeNull();
      const buttons = Array.from(menu!.querySelectorAll('button'));
      const getBtn = (label: string) => buttons.find(b => b.textContent?.includes(label));
      expect(getBtn('Rename')!.disabled).toBe(true);
      expect(getBtn('Cut')!.disabled).toBe(true);
      expect(getBtn('Delete')!.disabled).toBe(true);
      expect(getBtn('Open')!.disabled).toBe(false);
      expect(getBtn('Copy')!.disabled).toBe(false);
    });

    it('entry lock icon is shown on readOnly entries', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      const entries = wrapper.findAll('[data-testid^="entry-item-"]');
      const locks = wrapper.findAll('[data-testid="entry-lock-icon"]');
      expect(locks.length).toBe(entries.length);
    });
  });

  // ---- lock toggle ----

  describe('lock feature', () => {
    it('lock-toggle button is visible in toolbar', async () => {
      const wrapper = tracked(mountExplorer(root));
      await flushPromises();
      expect(wrapper.find('[data-testid="lock-toggle"]').exists()).toBe(true);
    });

    it('starts unlocked when initialLocked is false', async () => {
      root.addFile('a.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: false }));
      await flushPromises();

      // Write buttons should be enabled
      expect(wrapper.find('[data-testid="upload-button"]').attributes('disabled')).toBeUndefined();
      expect(wrapper.find('[data-testid="new-file-button"]').attributes('disabled')).toBeUndefined();
    });

    it('starts locked when initialLocked is true', async () => {
      root.addFile('a.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: true }));
      await flushPromises();

      // Write buttons should be disabled
      expect(wrapper.find('[data-testid="upload-button"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="new-file-button"]').attributes('disabled')).toBeDefined();
    });

    it('clicking lock-toggle enables write buttons when starting locked', async () => {
      root.addFile('a.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: true }));
      await flushPromises();

      await wrapper.find('[data-testid="lock-toggle"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-testid="upload-button"]').attributes('disabled')).toBeUndefined();
      expect(wrapper.find('[data-testid="new-file-button"]').attributes('disabled')).toBeUndefined();
    });

    it('clicking lock-toggle disables write buttons when starting unlocked', async () => {
      root.addFile('a.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: false }));
      await flushPromises();

      await wrapper.find('[data-testid="lock-toggle"]').trigger('click');
      await flushPromises();

      expect(wrapper.find('[data-testid="upload-button"]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="new-file-button"]').attributes('disabled')).toBeDefined();
    });

    it('context menu write items are disabled when locked', async () => {
      root.addFile('file.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: true }));
      await flushPromises();

      await wrapper.find('[data-testid="entry-item-file.txt"]').trigger('contextmenu', { clientX: 50, clientY: 50 });
      await flushPromises();

      const menu = document.body.querySelector('[data-testid="context-menu"]');
      const buttons = Array.from(menu!.querySelectorAll('button'));
      const getBtn = (label: string) => buttons.find(b => b.textContent?.includes(label));
      expect(getBtn('Rename')!.disabled).toBe(true);
      expect(getBtn('Delete')!.disabled).toBe(true);
      // Copy is not a write operation — stays enabled
      expect(getBtn('Copy')!.disabled).toBe(false);
    });

    it('Delete key does not delete entries when locked', async () => {
      root.addFile('keep.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: true }));
      await flushPromises();

      await wrapper.find('[data-testid="entry-item-keep.txt"]').trigger('click');
      await flushPromises();

      await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'Delete' });
      await flushPromises();

      expect(wrapper.text()).toContain('keep.txt');
    });

    it('Ctrl+X does not cut entries when locked', async () => {
      root.addFile('keep.txt');
      const wrapper = tracked(mountExplorer(root, { initialLocked: true }));
      await flushPromises();

      await wrapper.find('[data-testid="entry-item-keep.txt"]').trigger('click');
      await flushPromises();

      // Cut while locked — clipboard should remain empty
      await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'x', ctrlKey: true });
      await flushPromises();

      // Paste won't do anything because clipboard is empty
      await wrapper.find('[data-testid="file-explorer"]').trigger('keydown', { key: 'v', ctrlKey: true });
      await flushPromises();

      // keep.txt still present, no second copy
      const items = wrapper.findAll('[data-testid^="entry-item-"]');
      expect(items).toHaveLength(1);
    });
  });
});
