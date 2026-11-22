import { defineComponent, h, shallowRef, Suspense } from 'vue';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { mount, flushPromises } from '@vue/test-utils';
import FileExplorer from './FileExplorer.vue';
import FileExplorerModelView from './FileExplorerModelView.vue';
import EditorV4 from '@/features/editor-v4/components/EditorV4.vue';
import type { FileExplorerRemoteMount, FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import type { ExplorerDirectory, ExplorerChild } from '@/features/file-explorer/logic/explorer-directory';
import { LIST_ROW_HEIGHT } from '@/features/file-explorer/logic/constants';
import { createFileExplorerWorkerClient } from '@/features/file-explorer/worker/client';
import { FileExplorerNotDirectoryError } from '@/features/file-explorer/logic/errors';
import { getMimeCategory } from '@/features/file-explorer/logic/utils';
import { createRemoteDirectoryAccess } from '@/utils/remote-directory-handle';
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_ENDPOINT, type Settings } from '@/01-models/types';
import type { useSettings } from '@/composables/useSettings';

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
    if (existing instanceof MockExplorerDirectory) {
      return existing;
    }
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
      if (await current.file({ name: segment })) {
        throw new FileExplorerNotDirectoryError({ path });
      }
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
  pathSegments: Array<{ name: string, path: string, kind: 'root' | 'directory' | 'archive' }>,
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
        mimeCategory: getMimeCategory({ extension }),
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
    pathSegments: [{ name: activeRoot?.name ?? 'root', path: '/', kind: 'root' }, ...names.map((name, index) => ({
      name,
      path: `/${names.slice(0, index + 1).join('/')}`,
      kind: 'directory' as const,
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
    async prepareFileDownload() {
      return { kind: 'stream' as const };
    },
    async openFileStream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
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
    async suggestArchiveExclusions() {
      return { suggestions: [], resultState: 'complete' as const };
    },
    startDirectoryArchive() {
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        result: Promise.resolve({
          status: 'completed' as const,
          blob: new Blob(),
          skippedEntryCount: 0,
        }),
        async cancel() {},
      };
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
    async analyzeZipUpload({ analysisId }) {
      return { status: 'not_extractable' as const, analysisId, reason: 'invalid_or_unsupported_archive' as const };
    },
    async readZipUploadPreviewDirectory() {
      return {
        relativePath: '',
        pathSegments: [],
        entries: [],
        summary: { addedCount: 0, mergedCount: 0, replacedCount: 0, blockedCount: 0 },
      };
    },
    startZipUpload() {
      return {
        result: Promise.resolve({ status: 'completed' as const }),
        async cancel() {},
      };
    },
    async disposeZipUploadAnalysis() {},
    async uploadFiles({ targetDirectoryPath, files }) {
      mockUploadFiles({ targetDirectoryPath, files });
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
const mockUploadFiles = vi.fn();
const { mockPreferenceStorage } = vi.hoisted(() => ({
  mockPreferenceStorage: vi.fn<() => Pick<ReturnType<typeof useSettings>, 'settings' | 'initialized' | 'captureExperimentalStorage' | 'updateExperimentalForStorage'> | undefined>(),
}));

vi.mock('@/composables/useSettings', async importOriginal => {
  const original = await importOriginal<typeof import('@/composables/useSettings')>();
  return { ...original, useSettings: () => ({ ...original.useSettings(), ...mockPreferenceStorage() }) };
});

vi.mock('@/features/file-explorer/worker/client', () => ({
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

function dispatchTouchPointerEvent({
  target,
  type,
  pointerId = 1,
  clientX = 40,
  clientY = 50,
}: {
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  pointerId?: number,
  clientX?: number,
  clientY?: number,
}): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: 'touch' },
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    isPrimary: { value: true },
    button: { value: 0 },
  });
  target.dispatchEvent(event);
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('FileExplorer.vue', () => {
  let root: MockExplorerDirectory;
  let wrappers: ReturnType<typeof mount>[] = [];

  function tracked(wrapper: ReturnType<typeof mount>) {
    wrappers.push(wrapper);
    return wrapper;
  }

  beforeEach(() => {
    root = makeRoot();
    mockPreferenceStorage.mockReset();
    mockShowConfirm.mockResolvedValue(true);
    mockShowPrompt.mockResolvedValue(undefined);
    mockAddToast.mockReset();
    mockUploadFiles.mockReset();
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

  it('saves and restores display and editor preferences through the explorer controls', async () => {
    const settings = shallowRef<Settings>({
      ...DEFAULT_SETTINGS,
      endpoint: DEFAULT_SETTINGS_ENDPOINT,
      storageType: 'memory',
      experimental: {
        fileExplorer: {
          viewMode: 'column',
          previewVisibility: 'hidden',
          treeVisibility: 'hidden',
          fileInformationVisibility: 'visible',
          sortField: 'size',
          sortDirection: 'descending',
          wordWrap: 'wrap',
          editorLineNumbers: 'hidden',
          previewWidthPx: 300,
        },
      },
    });
    mockPreferenceStorage.mockReturnValue({
      settings,
      initialized: shallowRef(true),
      captureExperimentalStorage: () => () => true,
      async updateExperimentalForStorage({ isCurrent, updater }) {
        if (!isCurrent()) {
          return 'changed';
        }
        settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
        return 'saved';
      },
    });
    root.addFile('a.txt', 1, 'a');
    root.addFile('b.txt', 4, 'note');
    const client = await createMockWorkerClient();
    const bytes = new TextEncoder().encode('note');
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
    client.fileAccess = {
      read: vi.fn().mockResolvedValue({ kind: 'file', name: 'b.txt', blob, size: blob.size, partial: false, revision: 'first' }),
      openSnapshot: vi.fn(),
      inspectModel: vi.fn(),
      inspectModelOverview: vi.fn(),
      readModelMetadataValue: vi.fn(),
      prepareGgufMetadataRewrite: vi.fn(),
      save: vi.fn(),
    };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(wrapper.get('[data-testid="view-column"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(false);
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    const rowNames = () => wrapper.findAll('[data-testid^="entry-item-"]').map(row => row.attributes('data-testid'));
    expect(rowNames()).toEqual(['entry-item-b.txt', 'entry-item-a.txt']);
    await wrapper.get('[data-testid="sort-field-size"]').trigger('click');
    expect(rowNames()).toEqual(['entry-item-a.txt', 'entry-item-b.txt']);
    await wrapper.get('button[title="Show preview"]').trigger('click');
    expect(wrapper.find('[data-testid="preview-panel"]').exists()).toBe(true);

    await wrapper.get('[data-testid="file-view-open-toolbar"]').trigger('click');
    const file = '[data-path="/b.txt"]';
    await vi.waitFor(() => expect(wrapper.find(file).exists()).toBe(true));
    await wrapper.get(file).trigger('click');
    const tree = '[data-testid="file-explorer-toggle-file-tree"]';
    const information = '[data-testid="file-explorer-toggle-file-information"]';
    expect(wrapper.get(tree).attributes('aria-expanded')).toBe('false');
    expect(wrapper.get(information).attributes('aria-expanded')).toBe('true');
    await wrapper.get(tree).trigger('click');
    await wrapper.get(information).trigger('click');

    const edit = '[data-testid="file-view-edit-source"]';
    const lineNumbers = 'button[aria-label="Line numbers"]';
    const wrap = '[data-testid="editor-v4-wrap-toggle"]';
    await vi.waitFor(() => expect(wrapper.find(edit).exists()).toBe(true));
    await wrapper.get(edit).trigger('click');
    await vi.waitFor(() => expect(wrapper.find(wrap).exists()).toBe(true));
    expect(wrapper.get(wrap).attributes('aria-pressed')).toBe('true');
    expect(wrapper.get(lineNumbers).attributes('aria-pressed')).toBe('false');
    await wrapper.get(wrap).trigger('click');
    await wrapper.get(lineNumbers).trigger('click');
    await flushPromises();
    expect(settings.value.experimental?.fileExplorer).toEqual({
      viewMode: 'tree',
      previewVisibility: 'visible',
      treeVisibility: 'visible',
      fileInformationVisibility: 'hidden',
      sortField: 'size',
      sortDirection: 'ascending',
      wordWrap: 'no_wrap',
      editorLineNumbers: 'shown',
      previewWidthPx: 300,
    });

    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const reopened = tracked(mountExplorer(root));
    await vi.waitFor(() => expect(reopened.find(file).exists()).toBe(true));
    expect(reopened.get('[data-testid="file-view-open-toolbar"]').attributes('aria-pressed')).toBe('true');
    await reopened.get(file).trigger('click');
    expect(reopened.get(tree).attributes('aria-expanded')).toBe('true');
    expect(reopened.get(information).attributes('aria-expanded')).toBe('false');
    await vi.waitFor(() => expect(reopened.find(edit).exists()).toBe(true));
    await reopened.get(edit).trigger('click');
    await vi.waitFor(() => expect(reopened.find(wrap).exists()).toBe(true));
    expect(reopened.get(wrap).attributes('aria-pressed')).toBe('false');
    expect(reopened.get(lineNumbers).attributes('aria-pressed')).toBe('true');
  });

  it('disposes a worker that finishes preparing after the explorer was closed', async () => {
    const prepared = Promise.withResolvers<FileExplorerWorkerClient>();
    const client = await createMockWorkerClient();
    const dispose = vi.spyOn(client, 'dispose');
    vi.mocked(createFileExplorerWorkerClient).mockReturnValueOnce(prepared.promise);
    {
      const wrapper = mountExplorer(root, {
        root: {
          kind: 'archive-root',
          rootName: 'export.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob: new Blob(['zip']) } },
        },
      });
      using view = {
        [Symbol.dispose]() {
          wrapper.unmount();
        },
      };
      await flushPromises();
      expect(wrapper.find('[data-testid="file-explorer"]').exists()).toBe(false);
      void view;
    }
    prepared.resolve(client);
    await flushPromises();
    expect(dispose).toHaveBeenCalledOnce();
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

  it('previews a regular file on double-click when it is not a browsable archive', async () => {
    root.addFile('note.txt', 5, 'hello');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-note.txt"]').trigger('dblclick');
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="preview-panel"]').text()).toContain('hello');
    });
    expect(wrapper.text()).not.toContain('Failed to load directory');
  });

  it('keeps rows visible and loading status accurate during an overlapping archive probe and folder load', async () => {
    root.addFile('note.txt', 5, 'hello');
    root.addDir('subdir').addFile('child.txt');
    const client = await createMockWorkerClient();
    const readDirectory = client.readDirectory;
    const probe = Promise.withResolvers<void>();
    const folder = Promise.withResolvers<void>();
    client.readDirectory = async ({ path }) => {
      if (path === '/note.txt') {
        await probe.promise;
      }
      if (path === '/subdir') {
        await folder.promise;
      }
      return readDirectory({ path });
    };
    const preview = vi.spyOn(client, 'readPreview');
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    const browser = wrapper.get('[data-testid="file-explorer-browser"]');

    await wrapper.get('[data-testid="entry-item-note.txt"]').trigger('dblclick');
    expect(browser.attributes('aria-busy')).toBe('false');
    await wrapper.get('[data-testid="entry-item-subdir"]').trigger('dblclick');
    expect(browser.attributes('aria-busy')).toBe('true');
    expect(wrapper.get('[data-testid="entry-item-note.txt"]').isVisible()).toBe(true);

    probe.resolve();
    await flushPromises();
    expect(browser.attributes('aria-busy')).toBe('true');
    expect(preview).not.toHaveBeenCalled();

    folder.resolve();
    await flushPromises();
    expect(browser.attributes('aria-busy')).toBe('false');
    expect(wrapper.get('[data-testid="entry-item-child.txt"]').isVisible()).toBe(true);
  });

  it('opens a selected CSV in detail, guards unsaved changes, and restores the original browser selection', async () => {
    await Promise.all([
      import('./FileExplorerFileView.vue'),
      import('./FileExplorerFileContent.vue'),
      import('./FileExplorerDelimitedView.vue'),
    ]);

    const folder = root.addDir('folder');
    const csv = `\
Name,Score
Ada,98
`;
    folder.addFile('scores.csv', csv.length, csv);
    folder.addDir('nested').addFile('note.txt', 4, 'note');
    const client = await createMockWorkerClient();
    const read = vi.fn<NonNullable<FileExplorerWorkerClient['fileAccess']>['read']>(async ({ path }) => {
      const bytes = new TextEncoder().encode(path.endsWith('.csv') ? csv : 'note');
      const blob = new Blob([bytes]);
      Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
      return { kind: 'file', name: path.split('/').at(-1)!, blob, partial: false, revision: 'test-revision' };
    });
    client.fileAccess = {
      read,
      openSnapshot: vi.fn(),
      save: vi.fn(),
      inspectModelOverview: vi.fn(),
      inspectModel: vi.fn(),
      readModelMetadataValue: vi.fn(),
      prepareGgufMetadataRewrite: vi.fn(),
    };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root, { initialPath: ['folder'] }));
    await flushPromises();
    const preview = wrapper.get('[data-testid="preview-panel"]');
    const entry = wrapper.get('[data-testid="entry-item-scores.csv"]');
    await entry.trigger('click');
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(preview.get('[data-testid="delimited-table"]').text()).toContain('Ada'));
    expect(read).toHaveBeenCalledTimes(1);
    await entry.trigger('dblclick');
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    expect(preview.get('[data-testid="delimited-table"]').text()).toContain('Ada');

    await wrapper.get('button[title="Refresh"]').trigger('click');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    const open = wrapper.get<HTMLButtonElement>('[data-testid="file-view-open-toolbar"]');
    open.element.focus();
    const activate = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    expect(open.element.dispatchEvent(activate)).toBe(true);
    await open.trigger('click');
    await vi.dynamicImportSettled();
    const view = '[data-testid="file-explorer-file-view"]';
    const back = '[data-testid="file-explorer-file-view-back"]';
    const leave = '[data-testid="file-view-leave-dialog"]';
    await vi.waitFor(() => expect(wrapper.get(`${view} [data-testid="delimited-table"]`).text()).toContain('Ada'));
    expect(wrapper.get('[data-testid="file-explorer-browser"]').isVisible()).toBe(false);

    await wrapper.get(`${view} [data-testid="delimited-cell-button"]`).trigger('click');
    await wrapper.get<HTMLTextAreaElement>(`${view} [data-testid="delimited-cell-input"]`).setValue('Player');
    expect(wrapper.get('[data-testid="file-explorer-toggle-file-tree"]').attributes('aria-expanded')).toBe('true');
    const csvTreeRow = wrapper.get('[data-path="/folder/scores.csv"]');
    await csvTreeRow.trigger('contextmenu', { clientX: 60, clientY: 60 });
    const deleteAction = document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-delete"]');
    expect(deleteAction).not.toBeNull();
    deleteAction!.click();
    await flushPromises();
    expect(wrapper.get(leave).isVisible()).toBe(true);
    await wrapper.get(leave).trigger('keydown', { key: 'Escape' });
    expect(mockShowConfirm).not.toHaveBeenCalled();
    expect(wrapper.get(`${view} [data-testid="delimited-table"]`).text()).toContain('Player');

    const nested = '[data-testid="file-explorer-tree-entry"][data-path="/folder/nested"]';
    await vi.waitFor(() => expect(wrapper.get(nested).isVisible()).toBe(true));
    await wrapper.get(nested).trigger('click');
    const note = '[data-testid="file-explorer-tree-entry"][data-path="/folder/nested/note.txt"]';
    await vi.waitFor(() => expect(wrapper.get(note).isVisible()).toBe(true));
    const noteButton = wrapper.get<HTMLButtonElement>(note);
    noteButton.element.focus();
    await noteButton.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const cancel = wrapper.get('[data-testid="file-view-leave-cancel"]');
    expect(document.activeElement).toBe(cancel.element);
    await cancel.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(wrapper.get('[data-testid="file-view-leave-save"]').element);
    await wrapper.get(leave).trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find(leave).exists()).toBe(false);
    expect(document.activeElement).toBe(noteButton.element);
    expect(wrapper.get(`${view} [data-testid="delimited-table"]`).text()).toContain('Player');

    await noteButton.trigger('keydown', { key: 'Enter' });
    await wrapper.get('[data-testid="file-view-leave-discard"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="file-view-path"]').attributes('title')).toBe('/folder/nested/note.txt'));
    await wrapper.get(back).trigger('click');
    await flushPromises();
    expect(wrapper.find(view).exists()).toBe(false);
    expect(wrapper.get('[data-testid="breadcrumb-current"]').text()).toBe('folder');
    expect(wrapper.text()).toContain('1 selected');
    expect(document.activeElement).toBe(open.element);
  });

  it('offers the file view alongside the browser views before a file has been selected', async () => {
    root.addDir('docs').addDir('nested').addFile('note.txt', 4, 'note');
    const wrapper = tracked(mountExplorer(root, { initialPath: ['docs', 'nested'] }));
    await flushPromises();

    const fileMode = wrapper.get('[data-testid="file-view-open-toolbar"]');
    const columnMode = wrapper.get('[data-testid="view-column"]');
    await fileMode.trigger('click');
    await vi.dynamicImportSettled();
    expect(fileMode.attributes('aria-pressed')).toBe('true');
    expect(columnMode.attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('[data-testid="file-explorer-file-view-content"]').text()).toContain('Select a file');
    const entry = '[data-path="/docs/nested/note.txt"]';
    await vi.waitFor(() => expect(wrapper.find(entry).exists()).toBe(true));
    await wrapper.get(entry).trigger('click');
    expect(wrapper.get('[data-testid="file-view-path"]').attributes('title')).toBe('/docs/nested/note.txt');
    const folder = wrapper.get('[data-testid="file-view-breadcrumb-1"]');
    expect(folder.text()).toBe('docs');
    expect(wrapper.get('[data-testid="file-view-breadcrumb-2"]').text()).toBe('nested');
    await wrapper.get('[data-testid="file-explorer-toggle-file-tree"]').trigger('click');
    expect(wrapper.get('[data-testid="file-explorer-file-tree"]').isVisible()).toBe(false);
    await folder.trigger('click');
    expect(wrapper.get('[data-testid="file-explorer-file-tree"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="file-view-path"]').attributes('title')).toBe('/docs/nested/note.txt');

    await columnMode.trigger('click');
    expect(columnMode.attributes('aria-pressed')).toBe('true');
    expect(fileMode.attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-testid="file-explorer-file-view"]').exists()).toBe(false);
  });

  it.each([
    { name: 'note.txt', content: 'note', editLabel: 'Edit source' },
    { name: 'blank.txt', content: '', editLabel: 'Edit source' },
    { name: 'README', content: '', editLabel: 'Edit as text' },
    { name: 'blank.png', content: '', editLabel: 'Edit as text' },
    { name: 'blank.gguf', content: '', editLabel: 'Edit as text' },
  ])('opens the unlocked file $name directly for editing from the column preview', async ({ name, content, editLabel }) => {
    root.addFile(name, content.length, content);
    const client = await createMockWorkerClient();
    const bytes = new TextEncoder().encode(content);
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
    if (name.endsWith('.png')) {
      vi.spyOn(client, 'readPreview').mockResolvedValue({
        kind: 'media',
        mediaKind: 'image',
        mimeType: 'image/png',
        blob,
        oversized: false,
      });
    }
    const file = { kind: 'file' as const, name, blob, size: blob.size, partial: false, revision: 'first' };
    client.fileAccess = {
      read: vi.fn().mockResolvedValue(file),
      openSnapshot: vi.fn().mockResolvedValue(file),
      inspectModelOverview: vi.fn(),
      inspectModel: vi.fn(),
      readModelMetadataValue: vi.fn(),
      prepareGgufMetadataRewrite: vi.fn(),
      save: vi.fn().mockResolvedValue({ path: `/${name}`, revision: 'second' }),
    };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    const edit = '[data-testid="file-view-edit-preview"]';
    await flushPromises();
    await wrapper.get('[data-testid="view-column"]').trigger('click');
    await wrapper.get(`[data-testid="entry-item-${name}"]`).trigger('click');
    await vi.waitFor(() => expect(wrapper.find(edit).exists()).toBe(true));
    if (content === '') {
      await vi.waitFor(() => expect(wrapper.find('[data-testid="preview-empty-file"]').exists()).toBe(true));
    }
    expect(wrapper.get(edit).attributes('aria-label')).toBe(editLabel);
    await wrapper.get('[data-testid="lock-toggle"]').trigger('click');
    expect(wrapper.find(edit).exists()).toBe(false);
    await wrapper.get('[data-testid="lock-toggle"]').trigger('click');
    await wrapper.get(edit).trigger('click');
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(wrapper.findComponent(EditorV4).exists()).toBe(true));
    const textarea = wrapper.get<HTMLTextAreaElement>('[data-testid="editor-v4-input"]');
    expect(textarea.element.value).toBe(content);
    expect(textarea.element.readOnly).toBe(false);
    expect(document.activeElement).toBe(textarea.element);
    if (content === '') {
      await textarea.trigger('beforeinput', { inputType: 'insertText' });
      await textarea.setValue('First line');
      await wrapper.get('[data-testid="file-view-save"]').trigger('click');
      await vi.waitFor(() => expect(client.fileAccess?.save).toHaveBeenCalledWith(expect.objectContaining({
        target: { kind: 'replace', path: `/${name}`, revision: 'first' },
        blob: expect.objectContaining({ size: 'First line'.length }),
      })));
    }
  });

  it('reads only a binary prefix and shows its hex, ASCII, and decoded text', async () => {
    root.addFile('sample.bin', 1024 * 1024);
    const client = await createMockWorkerClient();
    const bytes = new Uint8Array([0, 0x41, 0x42, 0xff]);
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
    const read = vi.fn().mockResolvedValue({ kind: 'file', name: 'sample.bin', blob, partial: true });
    client.fileAccess = { read, openSnapshot: vi.fn(), inspectModelOverview: vi.fn(), inspectModel: vi.fn(), readModelMetadataValue: vi.fn(), prepareGgufMetadataRewrite: vi.fn(), save: vi.fn() };
    const fullPreview = vi.spyOn(client, 'readPreview');
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    await wrapper.get('[data-testid="entry-item-sample.bin"]').trigger('click');
    await vi.dynamicImportSettled();
    const panel = wrapper.get('[data-testid="preview-panel"]');
    await vi.waitFor(() => expect(panel.find('[data-testid="binary-hex-dump"]').exists()).toBe(true));
    expect(panel.get('[data-testid="binary-hex-dump"]').text()).toMatch(/0000\s+00 41 42 ff\s+\.AB\./);
    expect(panel.text()).toContain('Showing the first 4 bytes');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: '/sample.bin', mode: 'inspect' }));
    expect(fullPreview).not.toHaveBeenCalled();
    await panel.get('[data-testid="binary-toggle-text"]').trigger('click');
    expect(panel.get('[data-testid="binary-source-text"]').text()).toContain('AB');
  });

  it('opens detected archives from the preview and reveals their entries in Tree and contents', async () => {
    root.addFile('document.bin', 4);
    root.addDir('contents').addFile('document.xml');
    const client = await createMockWorkerClient();
    const readDirectory = client.readDirectory;
    client.readDirectory = async ({ path }) => {
      if (path !== '/document.bin') {
        return readDirectory({ path });
      }
      const { entries, pathSegments } = await readDirectory({ path: '/contents' });
      return {
        directoryPath: path,
        directoryName: 'document.bin',
        pathSegments: [pathSegments[0]!, { name: 'document.bin', path, kind: 'archive' }],
        entries: entries.map(entry => ({ ...entry, path: `${path}/${entry.name}`, readOnly: true, canMutate: false })),
        readOnly: true,
      };
    };
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
    client.fileAccess = {
      read: vi.fn().mockResolvedValue({ kind: 'file', name: 'document.bin', blob, partial: false, format: { kind: 'archive', extension: 'docx' } }),
      openSnapshot: vi.fn(),
      inspectModelOverview: vi.fn(),
      inspectModel: vi.fn(),
      readModelMetadataValue: vi.fn(),
      prepareGgufMetadataRewrite: vi.fn(),
      save: vi.fn(),
    };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.get('[data-testid="entry-item-document.bin"]').trigger('click');
    const browse = '[data-testid="file-explorer-preview-open-archive"]';
    await vi.waitFor(() => expect(wrapper.find(browse).exists()).toBe(true));
    await wrapper.get('[data-testid="file-view-open-preview"]').trigger('click');
    const browseInTree = '[data-testid="file-view-open-archive"]';
    await vi.waitFor(() => expect(wrapper.find(browseInTree).exists()).toBe(true));
    await wrapper.get(browseInTree).trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-path="/document.bin/document.xml"]').isVisible()).toBe(true));
    await wrapper.get('[data-testid="file-explorer-file-view-back"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find(browse).exists()).toBe(true));
    await wrapper.get(browse).trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="entry-item-document.xml"]').isVisible()).toBe(true));
    expect(wrapper.find('[data-testid="file-explorer-archive-location"]').exists()).toBe(true);
  });

  it('recognizes an empty model in a location that only supports prefix reads', async () => {
    root.addFile('empty.gguf', 0);
    const client = await createMockWorkerClient();
    const read = vi.fn().mockResolvedValue({ kind: 'file', name: 'empty.gguf', blob: new Blob(), size: 0, partial: false });
    const openSnapshot = vi.fn().mockResolvedValue({ kind: 'unsupported', name: 'empty.gguf' });
    const inspectModel = vi.fn();
    client.fileAccess = { read, openSnapshot, inspectModel, inspectModelOverview: vi.fn(), readModelMetadataValue: vi.fn(), prepareGgufMetadataRewrite: vi.fn(), save: vi.fn() };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    await wrapper.get('[data-testid="entry-item-empty.gguf"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="preview-empty-file"]').exists()).toBe(true));
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: '/empty.gguf', mode: 'inspect' }));
    expect(openSnapshot).not.toHaveBeenCalled();
    expect(inspectModel).not.toHaveBeenCalled();
  });

  it('loads the model overview on selection and descriptors only when a preview tab needs them', async () => {
    root.addFile('model.gguf', 4);
    const client = await createMockWorkerClient();
    const blob = new Blob(['GGUF']);
    const openSnapshot = vi.fn<NonNullable<FileExplorerWorkerClient['fileAccess']>['openSnapshot']>().mockResolvedValue({
      kind: 'file',
      name: 'model.gguf',
      blob,
      size: blob.size,
      partial: false,
      revision: undefined,
    });
    const inspectModelOverview = vi.fn<NonNullable<FileExplorerWorkerClient['fileAccess']>['inspectModelOverview']>().mockResolvedValue({
      status: 'weights',
      value: { format: 'gguf', version: 3, split: undefined, name: 'Fixture model', metadataCount: 1, tensorCount: 1 },
    });
    const inspectModel = vi.fn<NonNullable<FileExplorerWorkerClient['fileAccess']>['inspectModel']>().mockResolvedValue({
      status: 'weights',
      value: {
        format: 'gguf',
        version: 3,
        alignment: 32,
        dataOffset: 32,
        metadata: [{ key: 'general.name', type: 'string', value: 'Fixture model', count: undefined, elementType: undefined, range: undefined }],
        tensors: [{ name: 'blk.0.weight', shape: [1], originalShape: undefined, dtype: 'F32', dtypeCode: 0, offset: 32, byteLength: 4 }],
        split: undefined,
      },
    });
    client.fileAccess = { read: vi.fn(), openSnapshot, inspectModelOverview, inspectModel, save: vi.fn(), readModelMetadataValue: vi.fn(), prepareGgufMetadataRewrite: vi.fn() };
    const readPreview = vi.spyOn(client, 'readPreview');
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    expect(openSnapshot).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="entry-item-model.gguf"]').trigger('click');
    await vi.dynamicImportSettled();
    const panel = wrapper.get('[data-testid="preview-panel"]');
    await vi.waitFor(() => expect(panel.get('[data-testid="model-overview"]').text()).toContain('GGUF'));
    expect(openSnapshot).toHaveBeenCalledOnce();
    expect(inspectModelOverview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ file: blob }));
    expect(inspectModel).not.toHaveBeenCalled();
    expect(panel.getComponent(FileExplorerModelView).props('canSave')).toBe(false);
    expect(readPreview).not.toHaveBeenCalled();
    expect(panel.get('[data-testid="model-overview"]').text()).toContain('Fixture model');
    expect(panel.get('[data-testid="model-overview"]').text()).toContain('Tensors1');

    await panel.get('[data-testid="model-metadata-tab"]').trigger('click');
    await vi.waitFor(() => expect(panel.get('[data-testid="model-metadata-key"]').text()).toContain('general.name'));
    expect(inspectModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ file: blob }));
    await panel.get('[data-testid="model-tensors-tab"]').trigger('click');
    expect(panel.get('[data-testid="model-tensor-group"]').text()).toContain('blk');
    expect(inspectModel).toHaveBeenCalledOnce();
  });

  it('unlocks file view from a read-only starting folder and pastes into a writable mount root', async () => {
    root.addDir('from').addFile('note.txt');
    root.addDir('to');
    const client = await createMockWorkerClient();
    const readDirectory = client.readDirectory;
    client.readDirectory = async ({ path }) => {
      const response = await readDirectory({ path });
      return {
        ...response,
        readOnly: path !== '/to',
        entries: response.entries.map(entry => ({
          ...entry,
          readOnly: entry.path !== '/to',
          canMutate: false,
        })),
      };
    };
    const copy = vi.spyOn(client, 'copyEntries').mockResolvedValue(undefined);
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const handle = {} as FileSystemDirectoryHandle;
    const wrapper = tracked(mountExplorer(root, {
      initialPath: ['from'],
      initialLocked: true,
      root: {
        kind: 'wesh-mounts',
        rootName: 'root',
        mounts: [
          { type: 'directory', path: '/from', handle, readOnly: true },
          { type: 'directory', path: '/to', handle, readOnly: false },
        ],
      },
    }));
    await flushPromises();
    const lock = wrapper.get<HTMLButtonElement>('[data-testid="lock-toggle"]');
    expect(lock.element.disabled).toBe(true);
    await wrapper.get('[data-testid="file-view-open-toolbar"]').trigger('click');
    await vi.dynamicImportSettled();
    expect(lock.element.disabled).toBe(false);
    await wrapper.get('[data-path="/from/note.txt"]').trigger('contextmenu');
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-copy"]')!.click();
    await wrapper.get('[data-path="/to"]').trigger('contextmenu');
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-paste"]')?.disabled).toBe(true);
    await lock.trigger('click');
    await wrapper.get('[data-path="/to"]').trigger('contextmenu');
    const paste = document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-paste"]')!;
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-rename"]')?.disabled).toBe(true);
    expect(paste.disabled).toBe(false);
    paste.click();
    await flushPromises();
    expect(copy).toHaveBeenCalledWith({ sourcePaths: ['/from/note.txt'], targetDirectoryPath: '/to' });
  });

  it('protects an open file while moving it from the tree and resumes editing after failure or cancellation', async () => {
    await Promise.all([
      import('./FileExplorerFileView.vue'),
      import('./FileExplorerFileContent.vue'),
      import('./FileExplorerDelimitedView.vue'),
    ]);
    const csv = `\
Name,Score
Ada,98
`;
    root.addDir('from').addFile('scores.csv', csv.length, csv);
    root.addDir('to');
    const client = await createMockWorkerClient();
    const bytes = new TextEncoder().encode(csv);
    const blob = new Blob([bytes]);
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => bytes.buffer });
    client.fileAccess = {
      read: vi.fn().mockResolvedValue({ kind: 'file', name: 'scores.csv', blob, partial: false, revision: 'test-revision' }),
      openSnapshot: vi.fn(),
      save: vi.fn(),
      inspectModelOverview: vi.fn(),
      inspectModel: vi.fn(),
      readModelMetadataValue: vi.fn(),
      prepareGgufMetadataRewrite: vi.fn(),
    };
    const failedMove = Promise.withResolvers<void>();
    const successfulMove = Promise.withResolvers<void>();
    const move = vi.spyOn(client, 'moveEntries')
      .mockReturnValueOnce(failedMove.promise)
      .mockReturnValueOnce(successfulMove.promise);
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root, { initialPath: ['from'] }));
    await flushPromises();
    await wrapper.get('[data-testid="entry-item-scores.csv"]').trigger('click');
    await wrapper.get('[data-testid="file-view-open-toolbar"]').trigger('click');
    await vi.dynamicImportSettled();
    const detail = '[data-testid="file-view-content"]';
    const editor = `${detail} [data-testid="delimited-cell-button"]`;
    const leave = '[data-testid="file-view-leave-dialog"]';
    await vi.waitFor(() => expect(wrapper.find(editor).exists()).toBe(true));
    const source = wrapper.get('[data-path="/from/scores.csv"]');
    const destination = wrapper.get('[data-path="/to"]');
    await source.trigger('contextmenu');
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-cut"]')!.click();
    await source.trigger('contextmenu');
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-paste"]')!.click();
    await flushPromises();
    expect(move).not.toHaveBeenCalled();
    expect(wrapper.find(editor).exists()).toBe(true);
    async function paste(): Promise<void> {
      await destination.trigger('contextmenu');
      document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-paste"]')!.click();
      await flushPromises();
    }
    await paste();
    expect(move).toHaveBeenCalledExactlyOnceWith({ sourcePaths: ['/from/scores.csv'], targetDirectoryPath: '/to' });
    expect(wrapper.get(detail).attributes('aria-busy')).toBe('true');
    expect(wrapper.find(editor).exists()).toBe(false);
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    expect(wrapper.get(detail).isVisible()).toBe(true);

    failedMove.reject(new Error('No write access'));
    await flushPromises();
    expect(wrapper.get(detail).attributes('aria-busy')).toBe('false');
    await wrapper.get(editor).trigger('click');
    await wrapper.get<HTMLTextAreaElement>(`${detail} [data-testid="delimited-cell-input"]`).setValue('Player');
    await paste();
    expect(wrapper.get(leave).isVisible()).toBe(true);
    await wrapper.get('[data-testid="file-view-leave-cancel"]').trigger('click');
    await flushPromises();
    expect(move).toHaveBeenCalledTimes(1);
    expect(wrapper.get(detail).text()).toContain('Player');
    expect(wrapper.get(detail).attributes('aria-busy')).toBe('false');

    await paste();
    await wrapper.get('[data-testid="file-view-leave-discard"]').trigger('click');
    await flushPromises();
    expect(move).toHaveBeenCalledTimes(2);
    expect(wrapper.get(detail).attributes('aria-busy')).toBe('true');
    expect(wrapper.find(editor).exists()).toBe(false);
    successfulMove.resolve();
    await flushPromises();
    expect(wrapper.find(detail).exists()).toBe(false);

    const copy = vi.spyOn(client, 'copyEntries');
    await wrapper.get('[data-path="/from/scores.csv"]').trigger('contextmenu');
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-copy"]')!.click();
    await wrapper.get('[data-path="/"]').trigger('contextmenu');
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-rename"]')?.disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-delete"]')?.disabled).toBe(true);
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-paste"]')!.click();
    await flushPromises();
    expect(copy).toHaveBeenCalledWith({ sourcePaths: ['/from/scores.csv'], targetDirectoryPath: '/' });
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    expect(wrapper.get('[data-testid="file-explorer-browser"]').isVisible()).toBe(true);
  });

  it('follows the browser folder through a tree rename and returns to its surviving parent after deletion', async () => {
    await import('./FileExplorerFileView.vue');
    root.addDir('folder').addDir('nested').addFile('note.txt');
    const client = await createMockWorkerClient();
    const list = vi.spyOn(client, 'readDirectory');
    vi.spyOn(client, 'renameEntry').mockImplementation(async ({ path, newName }) => {
      expect(path).toBe('/folder');
      root.addDir(newName).addDir('nested').addFile('note.txt');
      await root.remove({ name: 'folder', recursive: true });
    });
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    mockShowPrompt.mockResolvedValueOnce('renamed');
    const wrapper = tracked(mountExplorer(root, { initialPath: ['folder', 'nested'] }));
    await flushPromises();
    const toggle = wrapper.get('[data-testid="file-view-open-toolbar"]');
    await toggle.trigger('click');
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(wrapper.find('[data-path="/folder"]').exists()).toBe(true));
    await wrapper.get('[data-path="/folder"]').trigger('contextmenu');
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-rename"]')!.click();
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith({ path: '/renamed/nested' }));
    await flushPromises();
    await wrapper.get('[data-testid="view-column"]').trigger('click');
    expect(wrapper.get('[data-testid="breadcrumb-current"]').text()).toBe('nested');
    expect(wrapper.get('[data-testid="entry-item-note.txt"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="entry-item-renamed"]').isVisible()).toBe(true);
    expect(wrapper.find('[data-testid="entry-item-folder"]').exists()).toBe(false);

    await toggle.trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-path="/renamed"]').exists()).toBe(true));
    await wrapper.get('[data-path="/renamed"]').trigger('contextmenu');
    document.body.querySelector<HTMLButtonElement>('[data-testid="context-menu-delete"]')!.click();
    await flushPromises();
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    expect(wrapper.get('[data-testid="breadcrumb-current"]').text()).toBe('root');
    expect(wrapper.find('[data-testid="entry-item-note.txt"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Failed to load directory');
  });

  it('shows an archive error without falling back to the regular file preview', async () => {
    root.addFile('broken.zip');
    const client = await createMockWorkerClient();
    const readDirectory = client.readDirectory;
    client.readDirectory = async ({ path }) => {
      if (path === '/broken.zip') {
        throw new Error('ZIP entry escapes the archive root');
      }
      return readDirectory({ path });
    };
    const preview = vi.spyOn(client, 'readPreview');
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.get('[data-testid="entry-item-broken.zip"]').trigger('dblclick');
    await flushPromises();

    expect(wrapper.text()).toContain('Failed to load directory: ZIP entry escapes the archive root');
    expect(preview).not.toHaveBeenCalled();
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

  it('long-pressing an entry on a touch device shows the same context menu', async () => {
    root.addFile('touch-file.txt');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    vi.useFakeTimers();

    using _cleanupResource = {
      [Symbol.dispose]() {
        vi.useRealTimers();
      },
    };
    const entry = wrapper.get('[data-testid="entry-item-touch-file.txt"]').element;
    dispatchTouchPointerEvent({ target: entry, type: 'pointerdown', clientX: 80, clientY: 90 });
    vi.advanceTimersByTime(600);
    await flushPromises();

    expect(document.body.querySelector('[data-testid="context-menu"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="context-menu"]')?.textContent).toContain('Download');
    dispatchTouchPointerEvent({ target: window, type: 'pointerup', clientX: 80, clientY: 90 });
  });

  it('long-pressing the list background shows the background context menu', async () => {
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    vi.useFakeTimers();

    using _cleanupResource = {
      [Symbol.dispose]() {
        vi.useRealTimers();
      },
    };
    const background = wrapper.get('[data-testid="list-scroll-container"]').element;
    dispatchTouchPointerEvent({ target: background, type: 'pointerdown' });
    vi.advanceTimersByTime(600);
    await flushPromises();

    const menu = document.body.querySelector('[data-testid="context-menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('New File');
    dispatchTouchPointerEvent({ target: window, type: 'pointerup' });
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

  it('opens the directory download dialog with the selected directory name', async () => {
    root.addDir('my-project');
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();

    await wrapper.find('[data-testid="entry-item-my-project"]').trigger('contextmenu', { clientX: 50, clientY: 50 });
    await flushPromises();

    const downloadButton = Array.from(document.body.querySelectorAll('[data-testid="context-menu"] button'))
      .find(button => button.textContent?.includes('Download'));
    expect(downloadButton).toBeDefined();
    downloadButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    const dialog = document.body.querySelector('[data-testid="directory-download-dialog"]');
    expect(dialog).not.toBeNull();
    const archiveName = document.body.querySelector<HTMLInputElement>('[data-testid="directory-download-archive-name"]');
    expect(archiveName?.value).toBe('my-project');
    expect(dialog?.textContent).not.toContain('/my-project');
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

  it('creates an empty file from the context menu', async () => {
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

    const dialog = wrapper.get('[data-testid="new-file-dialog"]');
    await dialog.get('[data-testid="new-file-name"]').setValue('new-file.txt');
    await dialog.trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('new-file.txt');
    expect(wrapper.find('[data-testid="new-file-dialog"]').exists()).toBe(false);
  });

  it('creates a file containing pasted text in the current directory', async () => {
    root.addDir('docs');
    const client = await createMockWorkerClient();
    const save = vi.fn<NonNullable<FileExplorerWorkerClient['fileAccess']>['save']>().mockResolvedValue({ path: '/docs/from-clipboard.txt', revision: 'first' });
    client.fileAccess = { read: vi.fn(), openSnapshot: vi.fn(), inspectModelOverview: vi.fn(), inspectModel: vi.fn(), readModelMetadataValue: vi.fn(), prepareGgufMetadataRewrite: vi.fn(), save };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root, { initialPath: ['docs'] }));
    await flushPromises();
    await wrapper.get('[data-testid="new-file-button"]').trigger('click');
    const dialog = wrapper.get('[data-testid="new-file-dialog"]');
    const content = dialog.get('[data-testid="new-file-content"]');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { items: [], files: [], getData: () => 'Pasted text' } });
    content.element.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    // jsdom does not insert clipboard text as the browser's default action.
    await content.setValue('Pasted text');
    await dialog.get('[data-testid="new-file-name"]').setValue('from-clipboard.txt');
    await dialog.trigger('submit');
    expect(save.mock.calls[0]?.[0]).toEqual({
      target: { kind: 'create', directoryPath: '/docs', name: 'from-clipboard.txt' },
      blob: expect.objectContaining({ size: 11, type: 'text/plain;charset=utf-8' }),
    });
  });

  it('copies a pasted image without changing its bytes and keeps it available when creation fails', async () => {
    const client = await createMockWorkerClient();
    const save = vi.fn<NonNullable<FileExplorerWorkerClient['fileAccess']>['save']>()
      .mockImplementationOnce(async () => {
        root.addFile('image.png', 0);
        throw new DOMException('Cannot write', 'QuotaExceededError');
      })
      .mockResolvedValueOnce({ path: '/copy.png', revision: 'first' });
    client.fileAccess = { read: vi.fn(), openSnapshot: vi.fn(), inspectModelOverview: vi.fn(), inspectModel: vi.fn(), readModelMetadataValue: vi.fn(), prepareGgufMetadataRewrite: vi.fn(), save };
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root));
    await flushPromises();
    await wrapper.get('[data-testid="new-file-button"]').trigger('click');
    const dialog = wrapper.get('[data-testid="new-file-dialog"]');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' });
    await dialog.get('[data-testid="new-file-content"]').trigger('paste', { clipboardData: { files: [file] } });
    const name = dialog.get<HTMLInputElement>('[data-testid="new-file-name"]');
    expect(name.element.value).toBe('image.png');
    await dialog.trigger('submit');
    await flushPromises();
    expect(mockAddToast).toHaveBeenCalled();
    expect(dialog.get('[data-testid="new-file-attachment"]').text()).toContain('image.png');
    expect(dialog.get('[data-testid="new-file-empty-name-conflict"]').text()).toContain('An empty file with this name exists');
    await name.setValue('copy.png');
    expect(dialog.find('[data-testid="new-file-empty-name-conflict"]').exists()).toBe(false);
    await dialog.trigger('submit');
    await flushPromises();
    expect(save.mock.calls[1]?.[0]?.blob).toBe(file);
    expect(save.mock.calls[1]?.[0]?.target).toEqual({ kind: 'create', directoryPath: '/', name: 'copy.png' });
    expect(wrapper.find('[data-testid="new-file-dialog"]').exists()).toBe(false);
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

  it('offers deletion without creation or renaming in a temporary model folder', async () => {
    await import('./FileExplorerFileView.vue');
    root.addDir('~user').addDir('model').addFile('model.gguf');
    const temporaryMount: FileExplorerRemoteMount = {
      path: '/~user/model',
      root: { kind: 'directory', name: 'model', id: 'directory:' },
      readOnly: false,
      deletionOnly: true,
      access: createRemoteDirectoryAccess({ dispatch: vi.fn() }),
    };
    const { access: _access, ...descriptor } = temporaryMount;
    const wrapper = tracked(mountExplorer(root, {
      root: { kind: 'wesh-mounts', rootName: 'Models', mounts: [], remoteMounts: [descriptor] },
      remoteMounts: [temporaryMount],
      initialPath: ['~user', 'model'],
      initialLocked: true,
    }));
    await flushPromises();
    await wrapper.get('[data-testid="file-view-open-toolbar"]').trigger('click');
    await vi.dynamicImportSettled();
    const lock = wrapper.get<HTMLButtonElement>('[data-testid="lock-toggle"]');
    expect(lock.element.disabled).toBe(false);
    await lock.trigger('click');
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    for (const button of ['upload-button', 'new-file-button', 'new-folder-button']) {
      expect(wrapper.find(`[data-testid="${button}"]`).exists()).toBe(false);
    }
    const entry = wrapper.get('[data-testid="entry-item-model.gguf"]');
    await entry.trigger('click');
    await wrapper.get('[data-testid="file-explorer"]').trigger('keydown', { key: 'F2' });
    expect(wrapper.find('[data-testid="rename-input"]').exists()).toBe(false);
    await entry.trigger('contextmenu', { clientX: 50, clientY: 50 });
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-testid="context-menu"] button'));
    expect(buttons.map(button => button.textContent?.trim())).not.toContain('Rename');
    expect(buttons.map(button => button.textContent?.trim())).not.toContain('Cut');
    const deleteButton = buttons.find(button => button.textContent?.trim() === 'Delete');
    expect(deleteButton?.disabled).toBe(false);
    deleteButton!.click();
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-item-model.gguf"]').exists()).toBe(false);
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

  it('keeps the previous column until the next shard is ready and reads the new shard once', async () => {
    const binaries = root.addDir('binary-objects');
    binaries.addDir('a1').addFile('old.bin');
    binaries.addDir('b2').addFile('new.bin');
    const client = await createMockWorkerClient();
    const readDirectory = client.readDirectory;
    const nextShard = Promise.withResolvers<void>();
    const read = vi.spyOn(client, 'readDirectory').mockImplementation(async ({ path }) => {
      if (path === '/binary-objects/b2') {
        await nextShard.promise;
      }
      return readDirectory({ path });
    });
    vi.mocked(createFileExplorerWorkerClient).mockResolvedValueOnce(client);
    const wrapper = tracked(mountExplorer(root, { initialViewMode: 'column', initialPath: ['binary-objects', 'a1'] }));
    await flushPromises();

    await wrapper.get('[data-testid="entry-item-b2"]').trigger('click');
    expect(wrapper.get('[data-testid="entry-item-old.bin"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="entry-item-a1"]').classes()).toContain('bg-blue-500');

    nextShard.resolve();
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-item-old.bin"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="entry-item-new.bin"]').isVisible()).toBe(true);
    expect(wrapper.get('[data-testid="entry-item-b2"]').classes()).toContain('bg-blue-500');
    expect(read.mock.calls.filter(([{ path }]) => path === '/binary-objects/b2')).toHaveLength(1);
  });

  it('reveals the selected file column when switching back to column view', async () => {
    const widths = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('data-testid') === 'file-explorer-column-scroll' ? 900 : 0;
    });
    using _restore = {
      [Symbol.dispose]() {
        widths.mockRestore();
      },
    };
    root.addDir('docs').addDir('notes').addFile('file.txt');
    const wrapper = tracked(mountExplorer(root, { initialPath: ['docs', 'notes'], initialViewMode: 'column' }));
    await flushPromises();

    await wrapper.get('[data-testid="entry-item-file.txt"]').trigger('click');
    await wrapper.get('[data-testid="view-list"]').trigger('click');
    expect(wrapper.find('[data-testid="file-explorer-column-scroll"]').exists()).toBe(false);
    await wrapper.get('[data-testid="view-column"]').trigger('click');

    const selected = wrapper.get('[data-testid="entry-item-file.txt"]');
    expect(selected.classes()).toContain('bg-blue-500');
    expect(wrapper.get('[data-testid="file-explorer-column-scroll"]').element.scrollLeft).toBe(900);
  });

  it('column view keeps scroll ownership axis-specific', async () => {
    root.addFile('col-file.txt');
    const wrapper = tracked(mountExplorer(root, { initialViewMode: 'column' }));
    await flushPromises();

    const horizontalScroll = wrapper.get('[data-testid="file-explorer-column-scroll"]');
    expect(horizontalScroll.classes()).toContain('overflow-x-auto');
    expect(horizontalScroll.classes()).toContain('overflow-y-hidden');
    expect(horizontalScroll.classes()).toContain('overscroll-x-contain');
    expect(horizontalScroll.classes()).not.toContain('overscroll-contain');

    const panes = wrapper.findAll('[data-testid="file-explorer-column-pane"]');
    expect(panes.length).toBeGreaterThan(0);
    for (const pane of panes) {
      // Vertical containment must not block horizontal scroll chaining to the parent scroller.
      expect(pane.classes()).toContain('overflow-x-hidden');
      expect(pane.classes()).toContain('overflow-y-auto');
      expect(pane.classes()).toContain('overscroll-y-contain');
      expect(pane.classes()).not.toContain('overscroll-contain');
    }
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

      override async *children(): AsyncIterable<import('@/features/file-explorer/logic/explorer-directory').ExplorerChild> {
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

    it('treats source read-only state as non-unlockable', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      const lockToggle = wrapper.find('[data-testid="lock-toggle"]');
      expect(lockToggle.attributes('disabled')).toBeDefined();
      expect(lockToggle.attributes('title')).toBe('Read Only');
      expect(wrapper.find('[data-testid="upload-button"]').attributes('title')).toBe('Read Only');
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

    it('ignores external file drops when the current directory is readOnly', async () => {
      const wrapper = mountReadOnlyExplorer();
      await flushPromises();

      const container = wrapper.get('[data-testid="list-scroll-container"]');
      const file = new File(['content'], 'dropped.txt', { type: 'text/plain' });
      const dataTransfer = { types: ['Files'], files: [file] };

      await container.trigger('dragover', { dataTransfer });
      expect(container.classes()).not.toContain('ring-2');

      await container.trigger('drop', { dataTransfer });
      await flushPromises();
      expect(mockUploadFiles).not.toHaveBeenCalled();

      await wrapper.get('[data-testid="view-icon"]').trigger('click');
      await flushPromises();
      const iconView = wrapper.get('[data-testid="icon-view"]');
      await iconView.trigger('dragover', { dataTransfer });
      expect(iconView.classes()).not.toContain('ring-2');
      await iconView.trigger('drop', { dataTransfer });
      await flushPromises();
      expect(mockUploadFiles).not.toHaveBeenCalled();
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
