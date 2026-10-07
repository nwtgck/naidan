import { downloadFile, downloadStream } from '@/utils/stream-download';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { ref } from 'vue';
import { useFileExplorerOperations } from './useFileExplorerOperations';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';

const mockShowConfirm = vi.fn().mockResolvedValue(true);
const mockAddToast = vi.fn();

vi.mock('@/utils/stream-download', () => ({ downloadStream: vi.fn().mockResolvedValue(undefined), downloadFile: vi.fn().mockResolvedValue(undefined) }));
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

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

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
    vi.mocked(downloadFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(downloadStream).mockReset().mockResolvedValue(undefined);
    client = {
      readDirectory: vi.fn(),
      readPreview: vi.fn(),
      prepareFileDownload: vi.fn().mockResolvedValue({ kind: 'stream' }),
      openFileStream: vi.fn(),
      readFile: vi.fn().mockResolvedValue({ blob: new File([], 'download.txt') }),
      createFile: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn().mockResolvedValue(undefined),
      deleteEntries: vi.fn().mockResolvedValue(undefined),
      renameEntry: vi.fn().mockResolvedValue(undefined),
      copyEntries: vi.fn().mockResolvedValue(undefined),
      moveEntries: vi.fn().mockResolvedValue(undefined),
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
      uploadFiles: vi.fn().mockResolvedValue(undefined),
      suggestArchiveExclusions: vi.fn().mockResolvedValue({
        suggestions: [],
        resultState: 'complete',
      }),
      startDirectoryArchive: vi.fn(() => ({
        stream: new ReadableStream<Uint8Array>(),
        result: Promise.resolve({ status: 'cancelled' as const }),
        cancel: vi.fn().mockResolvedValue(undefined),
      })),
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
    expect(client.prepareFileDownload).not.toHaveBeenCalled();
  });

  it('downloadEntry opens a lazy streaming download for files', async () => {
    const ops = makeOps();
    const entry = makeEntry('file.txt');
    await ops.downloadEntry({ entry });
    expect(downloadStream).toHaveBeenCalledWith({
      filename: 'file.txt',
      size: undefined,
      signal: expect.any(AbortSignal),
      openStream: expect.any(Function),
    });
    expect(client.prepareFileDownload).toHaveBeenCalledWith({ path: entry.path });
    expect(client.readFile).not.toHaveBeenCalled();
    expect(client.openFileStream).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    const options = vi.mocked(downloadStream).mock.calls[0]![0];
    await options.openStream();
    expect(client.openFileStream).toHaveBeenCalledWith({ path: entry.path });

  });

  it('sends a native snapshot to downloadFile instead of a listing-sized stream', async () => {
    const file = new File(['new contents'], 'file.txt');
    const stream = vi.fn();
    Object.defineProperty(file, 'stream', { value: stream });
    vi.mocked(client.prepareFileDownload).mockResolvedValue({ kind: 'file', blob: file });
    const entry = makeEntry('file.txt'); // listing size=100 is intentionally stale
    await makeOps().downloadEntry({ entry });
    expect(downloadFile).toHaveBeenCalledExactlyOnceWith({ file, filename: 'file.txt', signal: expect.any(AbortSignal) });
    expect(downloadStream).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
    expect(client.openFileStream).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('surfaces a failed native lookup instead of retrying via a different source', async () => {
    vi.mocked(client.prepareFileDownload).mockRejectedValue(new Error('file removed'));
    await makeOps().downloadEntry({ entry: makeEntry('file.txt') });
    expect(mockAddToast).toHaveBeenCalledOnce();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(downloadStream).not.toHaveBeenCalled();
  });

  it('does not start a delayed File save after the page was hidden', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<FileExplorerWorkerClient['prepareFileDownload']>>>();
    vi.mocked(client.prepareFileDownload).mockReturnValue(pending.promise);
    const operation = makeOps().downloadEntry({ entry: makeEntry('file.txt') });
    window.dispatchEvent(new Event('pagehide'));
    pending.resolve({ kind: 'file', blob: new File(['late'], 'file.txt') });
    await operation;
    expect(downloadFile).not.toHaveBeenCalled();
    expect(downloadStream).not.toHaveBeenCalled();
    expect(mockAddToast).not.toHaveBeenCalled();
  });

});
