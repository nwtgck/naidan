import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useFileExplorerOperations } from './useFileExplorerOperations';
import type { FileExplorerEntry } from './types';
import type { ExplorerDirectory } from './explorer-directory';

// --- Module-level mock instances (shared across all calls to useConfirm/useToast) ---
const mockShowConfirm = vi.fn().mockResolvedValue(true);
const mockAddToast = vi.fn();

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ showConfirm: mockShowConfirm }),
}));
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

// --- Helpers ---

function makeEntry(name: string, kind: 'file' | 'directory' = 'file'): FileExplorerEntry {
  return {
    name,
    kind,
    handle: {} as FileSystemHandle,
    directory: undefined,
    size: 100,
    lastModified: Date.now(),
    extension: kind === 'file' ? name.split('.').pop() ?? '' : '',
    mimeCategory: 'binary',
    readOnly: false,
  };
}

function makeWritable() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFileHandle(name: string, content: ArrayBuffer = new ArrayBuffer(0)): FileSystemFileHandle {
  const writable = makeWritable();
  return {
    kind: 'file',
    name,
    getFile: vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(content),
      name,
    }),
    createWritable: vi.fn().mockResolvedValue(writable),
  } as unknown as FileSystemFileHandle;
}

type MockDir = ExplorerDirectory & {
  _files: Map<string, FileSystemFileHandle>;
  fileCreate: ReturnType<typeof vi.fn>;
  subdirCreate: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function makeDirHandle(name: string): MockDir {
  const files = new Map<string, FileSystemFileHandle>();
  const dirs = new Map<string, ExplorerDirectory>();

  const mock: MockDir = {
    name,
    readOnly: false,
    _files: files,
    async *children() {
      for (const [fname, fh] of files) yield { kind: 'file' as const, name: fname, readOnly: false, fileHandle: fh };
    },
    subdir: vi.fn(async ({ name: n }: { name: string }) => dirs.get(n) ?? null),
    subdirCreate: vi.fn(async ({ name: n }: { name: string }) => {
      if (!dirs.has(n)) dirs.set(n, makeDirHandle(n));
      return dirs.get(n)!;
    }),
    file: vi.fn(async ({ name: n }: { name: string }) => files.get(n) ?? null),
    fileCreate: vi.fn(async ({ name: n }: { name: string }) => {
      if (!files.has(n)) files.set(n, makeFileHandle(n));
      return files.get(n)!;
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    isSameAs: vi.fn().mockResolvedValue(false),
  };
  return mock;
}

// --- Tests ---

describe('useFileExplorerOperations', () => {
  let currentDirectory: { readonly value: ExplorerDirectory };
  let refresh: () => Promise<void>;
  let dir: MockDir;

  beforeEach(() => {
    dir = makeDirHandle('root');
    currentDirectory = ref(dir) as unknown as { readonly value: ExplorerDirectory };
    refresh = vi.fn().mockResolvedValue(undefined);
    mockShowConfirm.mockReset();
    mockShowConfirm.mockResolvedValue(true);
    mockAddToast.mockReset();
  });

  function makeOps() {
    return useFileExplorerOperations({ currentDirectory, refresh });
  }

  // ---- createFile ----

  it('createFile creates a file handle and refreshes', async () => {
    const ops = makeOps();
    await ops.createFile({ name: 'hello.txt' });
    expect(dir.fileCreate).toHaveBeenCalledWith({ name: 'hello.txt' });
    expect(refresh).toHaveBeenCalled();
  });

  it('createFile shows toast on error', async () => {
    dir.fileCreate.mockRejectedValueOnce(new Error('no permission'));
    const ops = makeOps();
    await ops.createFile({ name: 'fail.txt' });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('no permission') }));
  });

  // ---- createFolder ----

  it('createFolder creates a directory handle and refreshes', async () => {
    const ops = makeOps();
    await ops.createFolder({ name: 'subdir' });
    expect(dir.subdirCreate).toHaveBeenCalledWith({ name: 'subdir' });
    expect(refresh).toHaveBeenCalled();
  });

  // ---- deleteEntries ----

  it('deleteEntries calls remove and refreshes', async () => {
    const ops = makeOps();
    const entry = makeEntry('a.txt', 'file');
    await ops.deleteEntries({ entries: [entry] });
    expect(dir.remove).toHaveBeenCalledWith({ name: 'a.txt', recursive: true });
    expect(refresh).toHaveBeenCalled();
  });

  it('deleteEntries does nothing for empty array', async () => {
    const ops = makeOps();
    await ops.deleteEntries({ entries: [] });
    expect(dir.remove).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('deleteEntries bails if confirm is rejected', async () => {
    mockShowConfirm.mockResolvedValueOnce(false);
    const ops = makeOps();
    await ops.deleteEntries({ entries: [makeEntry('a.txt')] });
    expect(dir.remove).not.toHaveBeenCalled();
  });

  it('deleteEntries shows toast when removal fails', async () => {
    dir.remove.mockRejectedValueOnce(new Error('locked'));
    const ops = makeOps();
    await ops.deleteEntries({ entries: [makeEntry('a.txt')] });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to delete') }));
  });

  // ---- rename ----

  it('startRename sets renamingEntryName', () => {
    const ops = makeOps();
    ops.startRename({ entry: makeEntry('foo.txt') });
    expect(ops.renamingEntryName.value).toBe('foo.txt');
  });

  it('cancelRename clears renamingEntryName', () => {
    const ops = makeOps();
    ops.startRename({ entry: makeEntry('foo.txt') });
    ops.cancelRename();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  it('renameEntry is no-op when newName is same as entry.name', async () => {
    const ops = makeOps();
    ops.startRename({ entry: makeEntry('foo.txt') });
    await ops.renameEntry({ entry: makeEntry('foo.txt'), newName: 'foo.txt' });
    expect(dir.fileCreate).not.toHaveBeenCalled();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  it('renameEntry is no-op when newName is blank', async () => {
    const ops = makeOps();
    ops.startRename({ entry: makeEntry('foo.txt') });
    await ops.renameEntry({ entry: makeEntry('foo.txt'), newName: '   ' });
    expect(dir.fileCreate).not.toHaveBeenCalled();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  it('renameEntry for a file copies content then removes original', async () => {
    const content = new ArrayBuffer(4);
    const fh = makeFileHandle('foo.txt', content);
    dir._files.set('foo.txt', fh);
    const destFh = makeFileHandle('bar.txt');
    dir._files.set('bar.txt', destFh);

    const ops = makeOps();
    ops.startRename({ entry: makeEntry('foo.txt') });
    const entry: FileExplorerEntry = { ...makeEntry('foo.txt'), handle: fh as FileSystemHandle };
    await ops.renameEntry({ entry, newName: 'bar.txt' });

    expect(dir.fileCreate).toHaveBeenCalledWith({ name: 'bar.txt' });
    expect(dir.remove).toHaveBeenCalledWith({ name: 'foo.txt', recursive: false });
    expect(refresh).toHaveBeenCalled();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  // ---- moveEntries ----

  it('moveEntries copies then removes source entry', async () => {
    const fh = makeFileHandle('a.txt');
    dir._files.set('a.txt', fh);
    const targetDir = makeDirHandle('target');

    const ops = makeOps();
    const entry: FileExplorerEntry = { ...makeEntry('a.txt'), handle: fh as FileSystemHandle };
    await ops.moveEntries({ entries: [entry], targetDir });

    expect(targetDir.fileCreate).toHaveBeenCalledWith({ name: 'a.txt' });
    expect(dir.remove).toHaveBeenCalledWith({ name: 'a.txt', recursive: false });
    expect(refresh).toHaveBeenCalled();
  });

  it('moveEntries shows toast when a move fails', async () => {
    const fh = makeFileHandle('a.txt');
    dir._files.set('a.txt', fh);
    const targetDir = makeDirHandle('target');
    targetDir.fileCreate.mockRejectedValueOnce(new Error('fail'));

    const ops = makeOps();
    const entry: FileExplorerEntry = { ...makeEntry('a.txt'), handle: fh as FileSystemHandle };
    await ops.moveEntries({ entries: [entry], targetDir });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to move') }));
  });

  // ---- copyEntriesToDir ----

  it('copyEntriesToDir copies without removing source', async () => {
    const fh = makeFileHandle('a.txt');
    dir._files.set('a.txt', fh);
    const targetDir = makeDirHandle('target');

    const ops = makeOps();
    const entry: FileExplorerEntry = { ...makeEntry('a.txt'), handle: fh as FileSystemHandle };
    await ops.copyEntriesToDir({ entries: [entry], targetDir });

    expect(targetDir.fileCreate).toHaveBeenCalledWith({ name: 'a.txt' });
    expect(dir.remove).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  // ---- downloadEntry ----

  it('downloadEntry does nothing for directories', async () => {
    const ops = makeOps();
    const entry = makeEntry('subdir', 'directory');
    // Should complete without throwing
    await expect(ops.downloadEntry({ entry })).resolves.toBeUndefined();
  });

  it('downloadEntry creates and clicks a download anchor for files', async () => {
    const fh = makeFileHandle('photo.png');
    const mockFile = new File([], 'photo.png');
    vi.mocked(fh.getFile).mockResolvedValue(mockFile as unknown as File & { name: string });

    const anchor = { href: '', download: '', click: vi.fn() };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor as unknown as HTMLElement);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const ops = makeOps();
    const entry: FileExplorerEntry = { ...makeEntry('photo.png'), handle: fh as FileSystemHandle };
    await ops.downloadEntry({ entry });

    expect(anchor.download).toBe('photo.png');
    expect(anchor.click).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake');
  });

  // ---- uploadFiles ----

  it('uploadFiles writes each file to currentDirectory and refreshes', async () => {
    const ops = makeOps();
    const file = new File(['hello'], 'upload.txt', { type: 'text/plain' });
    await ops.uploadFiles({ files: [file] });

    expect(dir.fileCreate).toHaveBeenCalledWith({ name: 'upload.txt' });
    expect(refresh).toHaveBeenCalled();
  });

  it('uploadFiles does nothing for empty array', async () => {
    const ops = makeOps();
    await ops.uploadFiles({ files: [] });
    expect(dir.fileCreate).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('uploadFiles shows toast when a file write fails', async () => {
    dir.fileCreate.mockRejectedValueOnce(new Error('quota exceeded'));
    const ops = makeOps();
    const file = new File(['x'], 'fail.txt');
    await ops.uploadFiles({ files: [file] });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to upload') }));
  });
});
