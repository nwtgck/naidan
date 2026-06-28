import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useFileExplorerOperations } from './useFileExplorerOperations';
import type { FileExplorerEntry } from '../logic/types';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';

const mockShowConfirm = vi.fn().mockResolvedValue(true);
const mockAddToast = vi.fn();

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ showConfirm: mockShowConfirm }),
}));
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

function makeEntry(name: string, kind: 'file' | 'directory' = 'file'): FileExplorerEntry {
  return {
    path: `/workspace/${name}`,
    name,
    kind,
    size: 100,
    lastModified: Date.now(),
    extension: kind === 'file' ? `.${name.split('.').pop() ?? ''}` : '',
    mimeCategory: 'binary',
    readOnly: false,
    canNavigate: kind === 'directory',
    canMutate: true,
  };
}

describe('useFileExplorerOperations', () => {
  let client: FileExplorerWorkerClient;
  let currentDirectoryPath: { value: string };
  let refresh: () => Promise<void>;

  beforeEach(() => {
    currentDirectoryPath = ref('/workspace');
    refresh = vi.fn().mockResolvedValue(undefined);
    mockShowConfirm.mockReset();
    mockShowConfirm.mockResolvedValue(true);
    mockAddToast.mockReset();
    client = {
      readDirectory: vi.fn(),
      readPreview: vi.fn(),
      readFile: vi.fn().mockResolvedValue({ blob: new File([], 'download.txt') }),
      createFile: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn().mockResolvedValue(undefined),
      deleteEntries: vi.fn().mockResolvedValue(undefined),
      renameEntry: vi.fn().mockResolvedValue(undefined),
      copyEntries: vi.fn().mockResolvedValue(undefined),
      moveEntries: vi.fn().mockResolvedValue(undefined),
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeOps() {
    return useFileExplorerOperations({ client, currentDirectoryPath, refresh });
  }

  it('createFile creates a file handle and refreshes', async () => {
    const ops = makeOps();
    await ops.createFile({ name: 'hello.txt' });
    expect(client.createFile).toHaveBeenCalledWith({ parentPath: '/workspace', name: 'hello.txt' });
    expect(refresh).toHaveBeenCalled();
  });

  it('createFile shows toast on error', async () => {
    client.createFile = vi.fn().mockRejectedValueOnce(new Error('no permission'));
    const ops = makeOps();
    await ops.createFile({ name: 'fail.txt' });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('no permission') }));
  });

  it('createFolder creates a directory handle and refreshes', async () => {
    const ops = makeOps();
    await ops.createFolder({ name: 'subdir' });
    expect(client.createFolder).toHaveBeenCalledWith({ parentPath: '/workspace', name: 'subdir' });
    expect(refresh).toHaveBeenCalled();
  });

  it('deleteEntries calls remove and refreshes', async () => {
    const ops = makeOps();
    const entry = makeEntry('a.txt', 'file');
    await ops.deleteEntries({ entries: [entry] });
    expect(client.deleteEntries).toHaveBeenCalledWith({ paths: ['/workspace/a.txt'] });
    expect(refresh).toHaveBeenCalled();
  });

  it('deleteEntries does nothing for empty array', async () => {
    const ops = makeOps();
    await ops.deleteEntries({ entries: [] });
    expect(client.deleteEntries).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('deleteEntries bails if confirm is rejected', async () => {
    mockShowConfirm.mockResolvedValueOnce(false);
    const ops = makeOps();
    await ops.deleteEntries({ entries: [makeEntry('a.txt')] });
    expect(client.deleteEntries).not.toHaveBeenCalled();
  });

  it('deleteEntries shows toast when removal fails', async () => {
    client.deleteEntries = vi.fn().mockRejectedValueOnce(new Error('locked'));
    const ops = makeOps();
    await ops.deleteEntries({ entries: [makeEntry('a.txt')] });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to delete') }));
  });

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
    expect(client.renameEntry).not.toHaveBeenCalled();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  it('renameEntry is no-op when newName is blank', async () => {
    const ops = makeOps();
    ops.startRename({ entry: makeEntry('foo.txt') });
    await ops.renameEntry({ entry: makeEntry('foo.txt'), newName: '   ' });
    expect(client.renameEntry).not.toHaveBeenCalled();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  it('renameEntry for a file renames and refreshes', async () => {
    const ops = makeOps();
    const entry = makeEntry('foo.txt');
    ops.startRename({ entry });
    await ops.renameEntry({ entry, newName: 'bar.txt' });
    expect(client.renameEntry).toHaveBeenCalledWith({ path: '/workspace/foo.txt', newName: 'bar.txt' });
    expect(refresh).toHaveBeenCalled();
    expect(ops.renamingEntryName.value).toBeUndefined();
  });

  it('moveEntries copies then removes source entry', async () => {
    const ops = makeOps();
    const entry = makeEntry('a.txt');
    await ops.moveEntries({ entries: [entry], targetPath: '/workspace/target' });
    expect(client.moveEntries).toHaveBeenCalledWith({
      sourcePaths: ['/workspace/a.txt'],
      targetDirectoryPath: '/workspace/target',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('moveEntries shows toast when a move fails', async () => {
    client.moveEntries = vi.fn().mockRejectedValueOnce(new Error('fail'));
    const ops = makeOps();
    const entry = makeEntry('a.txt');
    await ops.moveEntries({ entries: [entry], targetPath: '/workspace/target' });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to move') }));
  });

  it('copyEntriesToDir copies without removing source', async () => {
    const ops = makeOps();
    const entry = makeEntry('a.txt');
    await ops.copyEntriesToDir({ entries: [entry], targetPath: '/workspace/target' });
    expect(client.copyEntries).toHaveBeenCalledWith({
      sourcePaths: ['/workspace/a.txt'],
      targetDirectoryPath: '/workspace/target',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('downloadEntry does nothing for directories', async () => {
    const ops = makeOps();
    const entry = makeEntry('subdir', 'directory');
    await expect(ops.downloadEntry({ entry })).resolves.toBeUndefined();
  });

  it('downloadEntry creates and clicks a download anchor for files', async () => {
    const anchor = { href: '', download: '', click: vi.fn() };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(anchor as unknown as HTMLElement);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const ops = makeOps();
    const entry = makeEntry('photo.png');
    await ops.downloadEntry({ entry });

    expect(client.readFile).toHaveBeenCalledWith({ path: '/workspace/photo.png' });
    expect(anchor.download).toBe('photo.png');
    expect(anchor.click).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake');
  });

  it('uploadFiles writes each file to currentDirectory and refreshes', async () => {
    const ops = makeOps();
    const file = new File(['hello'], 'upload.txt', { type: 'text/plain' });
    await ops.uploadFiles({ files: [file] });

    expect(client.uploadFiles).toHaveBeenCalledWith({
      targetDirectoryPath: '/workspace',
      files: [{ name: 'upload.txt', blob: file }],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('uploadFiles does nothing for empty array', async () => {
    const ops = makeOps();
    await ops.uploadFiles({ files: [] });
    expect(client.uploadFiles).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('uploadFiles shows toast when a file write fails', async () => {
    client.uploadFiles = vi.fn().mockRejectedValueOnce(new Error('quota exceeded'));
    const ops = makeOps();
    const file = new File(['x'], 'fail.txt');
    await ops.uploadFiles({ files: [file] });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Failed to upload') }));
  });
});
