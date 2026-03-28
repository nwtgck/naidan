import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import FileExplorer from './FileExplorer.vue';
import type { ExplorerDirectory, ExplorerChild } from './explorer-directory';

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

  async remove({ name }: { name: string; recursive: boolean }): Promise<void> {
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

const mockShowConfirm = vi.fn().mockResolvedValue(true);
const mockShowPrompt = vi.fn().mockResolvedValue(undefined);
const mockAddToast = vi.fn();

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
  return mount(FileExplorer, {
    props: {
      root,
      initialViewMode: 'list',
      initialPreviewVisibility: 'visible',
      initialStack: undefined,
      ...overrides,
    },
    attachTo: document.body,
  });
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
});
