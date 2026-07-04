import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useFileExplorerDirectoryDownload } from './useFileExplorerDirectoryDownload';

const mockAddToast = vi.fn();
const clickedDownloadNames: string[] = [];
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

function deferred<T>(): {
  promise: Promise<T>,
  resolve(value: T): void,
  reject(reason: unknown): void,
  } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createClient({
  archiveResult = Promise.resolve({
    status: 'completed' as const,
    blob: new Blob(['zip']),
    skippedEntryCount: 0,
  }),
}: {
  archiveResult?: ReturnType<typeof deferred<
    | { status: 'completed', blob: Blob, skippedEntryCount: number }
    | { status: 'cancelled' }
  >>['promise'] | Promise<{ status: 'completed', blob: Blob, skippedEntryCount: number }>,
} = {}): FileExplorerWorkerClient & {
  suggestArchiveExclusions: ReturnType<typeof vi.fn>,
  startDirectoryArchive: ReturnType<typeof vi.fn>,
  cancelArchive: ReturnType<typeof vi.fn>,
} {
  const cancelArchive = vi.fn().mockResolvedValue(undefined);
  const suggestArchiveExclusions = vi.fn().mockResolvedValue({
    suggestions: [{ relativePath: 'src', name: 'src', kind: 'directory' }],
    resultState: 'complete',
  });
  const startDirectoryArchive = vi.fn(() => ({
    result: archiveResult,
    cancel: cancelArchive,
  }));
  return {
    readDirectory: vi.fn(),
    readPreview: vi.fn(),
    readFile: vi.fn(),
    suggestArchiveExclusions,
    startDirectoryArchive,
    createFile: vi.fn(),
    createFolder: vi.fn(),
    deleteEntries: vi.fn(),
    renameEntry: vi.fn(),
    copyEntries: vi.fn(),
    moveEntries: vi.fn(),
    uploadFiles: vi.fn(),
    dispose: vi.fn(),
    cancelArchive,
  } as unknown as FileExplorerWorkerClient & {
    suggestArchiveExclusions: ReturnType<typeof vi.fn>,
    startDirectoryArchive: ReturnType<typeof vi.fn>,
    cancelArchive: ReturnType<typeof vi.fn>,
  };
}

describe('useFileExplorerDirectoryDownload', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mockAddToast.mockReset();
    await ensureAllStringsForTest({ locale: 'en' });
    // Preserve the URL constructor because Vite needs it to resolve dynamic imports.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:directory-archive');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    clickedDownloadNames.length = 0;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownloadNames.push(this.download);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads hierarchical exclusion suggestions, applies one, and adds it explicitly', async () => {
    const client = createClient();
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/hoge/my-project', name: 'my-project' } });
    controller.setQuery({ value: 'sr' });
    await vi.advanceTimersByTimeAsync(150);

    expect(client.suggestArchiveExclusions).toHaveBeenCalledWith({
      directoryPath: '/hoge/my-project',
      query: 'sr',
      excludedRelativePaths: [],
    });
    expect(controller.state.suggestions[0]?.relativePath).toBe('src');

    controller.applySelectedSuggestion();
    expect(controller.state.query).toBe('src');
    expect(controller.state.querySuggestion).toEqual({
      relativePath: 'src',
      name: 'src',
      kind: 'directory',
    });
    expect(controller.state.exclusions).toEqual([]);
    expect(controller.state.suggestionStatus).toBe('idle');

    controller.addQueryExclusion();
    expect(controller.state.exclusions).toEqual([
      { relativePath: 'src', name: 'src', kind: 'directory' },
    ]);
    expect(controller.state.query).toBe('');
    controller.dispose();
  });

  it('clears the applied suggestion when a slash is entered to browse deeper', async () => {
    const client = createClient();
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/project', name: 'project' } });
    controller.state.suggestions = [
      { relativePath: 'src', name: 'src', kind: 'directory' },
    ];
    controller.state.selectedSuggestionIndex = 0;

    controller.applySelectedSuggestion();
    controller.setQuery({ value: 'src/' });

    expect(controller.state.querySuggestion).toBeUndefined();
    expect(controller.state.suggestionStatus).toBe('loading');
    await vi.advanceTimersByTimeAsync(150);
    expect(client.suggestArchiveExclusions).toHaveBeenLastCalledWith({
      directoryPath: '/project',
      query: 'src/',
      excludedRelativePaths: [],
    });
    controller.dispose();
  });

  it('starts an archive with relative exclusions and downloads a sanitized ZIP filename', async () => {
    const client = createClient();
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/hoge/my-project', name: 'my-project' } });
    controller.setArchiveName({ value: ' backup.zip ' });
    controller.addExclusion({
      suggestion: { relativePath: 'dist/cache', name: 'cache', kind: 'directory' },
    });

    await controller.confirm();

    expect(client.startDirectoryArchive).toHaveBeenCalledWith({
      directoryPath: '/hoge/my-project',
      excludedRelativePaths: ['dist/cache'],
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickedDownloadNames).toEqual(['backup.zip']);
    expect(client.cancelArchive).not.toHaveBeenCalled();
    const anchor = document.querySelector('a');
    expect(anchor).toBeNull();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(controller.state.visibility).toBe('hidden');
  });

  it('clears stale suggestions as soon as a new query is scheduled', () => {
    const client = createClient();
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/project', name: 'project' } });
    controller.state.suggestions = [
      { relativePath: 'old', name: 'old', kind: 'directory' },
    ];
    controller.state.querySuggestion = { relativePath: 'old', name: 'old', kind: 'directory' };
    controller.state.suggestionStatus = 'ready';
    controller.state.selectedSuggestionIndex = 0;

    controller.setQuery({ value: 'new' });

    expect(controller.state.suggestions).toEqual([]);
    expect(controller.state.querySuggestion).toBeUndefined();
    expect(controller.state.suggestionStatus).toBe('loading');
    expect(controller.state.selectedSuggestionIndex).toBeUndefined();
    controller.dispose();
  });

  it('cancels the active worker job when the dialog closes', async () => {
    const pending = deferred<{ status: 'cancelled' }>();
    const client = createClient({ archiveResult: pending.promise });
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/project', name: 'project' } });
    const confirming = controller.confirm();

    await controller.close();
    pending.resolve({ status: 'cancelled' });
    await confirming;

    expect(client.cancelArchive).toHaveBeenCalledOnce();
    expect(controller.state.visibility).toBe('hidden');
  });

  it('ignores a completed job from a previously closed dialog', async () => {
    const pending = deferred<{ status: 'completed', blob: Blob, skippedEntryCount: number }>();
    const client = createClient({ archiveResult: pending.promise });
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/old', name: 'old' } });
    const confirming = controller.confirm();
    await controller.close();
    controller.open({ target: { path: '/new', name: 'new' } });

    pending.resolve({ status: 'completed', blob: new Blob(), skippedEntryCount: 0 });
    await confirming;

    expect(controller.state.visibility).toBe('visible');
    expect(controller.state.target?.name).toBe('new');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('recovers when starting the worker archive job throws synchronously', async () => {
    const client = createClient();
    client.startDirectoryArchive.mockImplementationOnce(() => {
      throw new Error('Worker is unavailable');
    });
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/project', name: 'project' } });

    await controller.confirm();

    expect(controller.state.creationStatus).toBe('idle');
    expect(controller.state.visibility).toBe('visible');
    expect(mockAddToast).toHaveBeenCalledWith({
      message: 'Failed to download: Worker is unavailable',
    });
    controller.dispose();
  });

  it('reports unsupported skipped entries after a successful download', async () => {
    const client = createClient({
      archiveResult: Promise.resolve({
        status: 'completed',
        blob: new Blob(),
        skippedEntryCount: 2,
      }),
    });
    const controller = useFileExplorerDirectoryDownload({ client });
    controller.open({ target: { path: '/project', name: 'project' } });

    await controller.confirm();

    expect(mockAddToast).toHaveBeenCalledWith({
      message: '2 unsupported item(s) were skipped.',
    });
  });
});
