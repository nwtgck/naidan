import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import type {
  FileExplorerAnalyzeZipUploadResponse,
  FileExplorerWorkerClient,
  FileExplorerReadZipUploadPreviewDirectoryResponse,
} from '@/features/file-explorer/worker/types';
import { useFileExplorerUpload } from './useFileExplorerUpload';

const mockAddToast = vi.fn();

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

function createPreviewResponse(): FileExplorerReadZipUploadPreviewDirectoryResponse {
  return {
    relativePath: '',
    pathSegments: [],
    entries: [
      {
        path: 'workspace',
        name: 'workspace',
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        action: 'add',
        canNavigate: true,
      },
    ],
    summary: {
      addedCount: 1,
      mergedCount: 0,
      replacedCount: 0,
      blockedCount: 0,
    },
  };
}

function createClient(): FileExplorerWorkerClient {
  return {
    analyzeZipUpload: vi.fn().mockResolvedValue({
      status: 'extractable',
      analysisId: 'analysis-1',
      entryCount: 2,
      totalUncompressedSize: 10,
      singleRootDirectoryName: 'workspace',
    }),
    readZipUploadPreviewDirectory: vi.fn().mockResolvedValue(createPreviewResponse()),
    startZipUpload: vi.fn(() => ({
      result: Promise.resolve({ status: 'completed' as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })),
    disposeZipUploadAnalysis: vi.fn().mockResolvedValue(undefined),
    uploadFiles: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileExplorerWorkerClient;
}

function createEntry({ name, kind }: { name: string, kind: 'file' | 'directory' }): FileExplorerEntry {
  return {
    path: `/uploads/${name}`,
    name,
    kind,
    size: kind === 'file' ? 4 : undefined,
    lastModified: 1,
    extension: kind === 'file' ? '.zip' : '',
    mimeCategory: 'binary',
    readOnly: false,
    canNavigate: kind === 'directory',
    canMutate: true,
  };
}

describe('useFileExplorerUpload', () => {
  beforeEach(async () => {
    mockAddToast.mockReset();
    await ensureAllStringsForTest({ locale: 'en' });
  });

  function createController({
    client = createClient(),
    entries = [],
  }: {
    client?: FileExplorerWorkerClient,
    entries?: FileExplorerEntry[],
  } = {}) {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const currentDirectoryPath = ref('/uploads');
    const currentEntries = ref(entries);
    const controller = useFileExplorerUpload({
      client,
      currentDirectoryPath,
      currentEntries,
      refresh,
    });
    return { controller, client, refresh, currentDirectoryPath, currentEntries };
  }

  it('uploads non-ZIP files directly without opening the dialog', async () => {
    const { controller, client, refresh } = createController();
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

    await controller.begin({ files: [file] });

    expect(client.uploadFiles).toHaveBeenCalledWith({
      targetDirectoryPath: '/uploads',
      files: [{ name: 'note.txt', blob: file }],
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(controller.state.visibility).toBe('hidden');
  });

  it('analyzes ZIP files and defaults to keeping the archive', async () => {
    const { controller, client } = createController();
    const file = new File(['zip'], 'backup.zip', { type: 'application/zip' });

    await controller.begin({ files: [file] });

    expect(client.analyzeZipUpload).toHaveBeenCalledWith(expect.objectContaining({
      targetDirectoryPath: '/uploads',
      fileName: 'backup.zip',
      blob: file,
    }));
    expect(controller.state.phase).toBe('configuring');
    expect(controller.state.visibility).toBe('visible');
    expect(controller.state.placement).toEqual({ kind: 'keep_archive' });
    expect(controller.state.targetDirectoryPath).toBe('/uploads');
    expect(controller.state.singleRootDirectoryName).toBe('workspace');
    expect(client.readZipUploadPreviewDirectory).toHaveBeenCalledWith(expect.objectContaining({
      placement: { kind: 'keep_archive' },
      relativePath: '',
    }));
  });

  it('switches between preserving and stripping a single root directory', async () => {
    const { controller, client } = createController();
    await controller.begin({ files: [new File(['zip'], 'backup.zip')] });

    await controller.setPlacement({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    });
    expect(controller.state.placement).toEqual({
      kind: 'extract',
      rootHandling: 'preserve',
    });

    await controller.setPlacement({
      placement: { kind: 'extract', rootHandling: 'strip' },
    });
    expect(controller.state.placement).toEqual({
      kind: 'extract',
      rootHandling: 'strip',
    });
    expect(client.readZipUploadPreviewDirectory).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: { kind: 'extract', rootHandling: 'strip' },
    }));
  });

  it('keeps an invalid ZIP uploadable but blocks a file-directory collision', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn().mockResolvedValue({
      status: 'not_extractable',
      analysisId: 'analysis-1',
      reason: 'invalid_or_unsupported_archive',
    });
    const { controller } = createController({
      client,
      entries: [createEntry({ name: 'backup.zip', kind: 'directory' })],
    });

    await controller.begin({ files: [new File(['not zip'], 'backup.zip')] });

    expect(controller.state.extractability).toBe('not_extractable');
    expect(controller.state.placement).toEqual({ kind: 'keep_archive' });
    expect(controller.state.previewSummary.blockedCount).toBe(1);
    expect(controller.state.previewEntries.filter(entry => entry.name === 'backup.zip')).toHaveLength(1);

    await controller.confirm();
    expect(client.uploadFiles).not.toHaveBeenCalled();
  });

  it('falls back to keeping the archive when ZIP analysis fails', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn().mockRejectedValue(new Error('analysis unavailable'));
    const { controller } = createController({ client });

    await controller.begin({ files: [new File(['zip'], 'backup.zip')] });

    expect(controller.state.visibility).toBe('visible');
    expect(controller.state.phase).toBe('configuring');
    expect(controller.state.extractability).toBe('not_extractable');
    expect(controller.state.placement).toEqual({ kind: 'keep_archive' });
    expect(controller.state.errorMessage).toBe('analysis unavailable');
    expect(client.disposeZipUploadAnalysis).toHaveBeenCalledOnce();
  });

  it('falls back to keeping the archive when placement preview fails', async () => {
    const client = createClient();
    client.readZipUploadPreviewDirectory = vi.fn().mockRejectedValue(new Error('preview unavailable'));
    const { controller } = createController({ client });

    await controller.begin({ files: [new File(['zip'], 'backup.zip')] });

    expect(controller.state.phase).toBe('configuring');
    expect(controller.state.extractability).toBe('not_extractable');
    expect(controller.state.placement).toEqual({ kind: 'keep_archive' });
    expect(controller.state.errorMessage).toBe('preview unavailable');
    expect(client.disposeZipUploadAnalysis).toHaveBeenCalledOnce();
  });


  it('keeps local fallback preview tied to the directory selected when the dialog opened', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn().mockResolvedValue({
      status: 'not_extractable',
      analysisId: 'analysis-1',
      reason: 'invalid_or_unsupported_archive',
    });
    const { controller, currentDirectoryPath, currentEntries } = createController({
      client,
      entries: [createEntry({ name: 'existing.txt', kind: 'file' })],
    });

    const beginPromise = controller.begin({ files: [new File(['not zip'], 'backup.zip')] });
    currentDirectoryPath.value = '/other';
    currentEntries.value = [createEntry({ name: 'other.txt', kind: 'file' })];
    await beginPromise;

    expect(controller.state.targetDirectoryPath).toBe('/uploads');
    expect(controller.state.previewEntries.map(entry => entry.name)).toEqual([
      'backup.zip',
      'existing.txt',
    ]);
  });

  it('executes an analyzed ZIP through the ZIP job when keep archive is confirmed', async () => {
    const { controller, client, refresh } = createController();
    const file = new File(['zip'], 'backup.zip');
    await controller.begin({ files: [file] });

    await controller.confirm();

    expect(client.startZipUpload).toHaveBeenCalledWith(expect.objectContaining({
      placement: { kind: 'keep_archive' },
    }));
    expect(client.uploadFiles).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(controller.state.visibility).toBe('hidden');
    expect(client.disposeZipUploadAnalysis).toHaveBeenCalled();
  });

  it('uploads an unextractable ZIP as a regular file when keep archive is confirmed', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn().mockResolvedValue({
      status: 'not_extractable',
      analysisId: 'analysis-1',
      reason: 'invalid_or_unsupported_archive',
    });
    const { controller, refresh } = createController({ client });
    const file = new File(['not zip'], 'backup.zip');
    await controller.begin({ files: [file] });

    await controller.confirm();

    expect(client.startZipUpload).not.toHaveBeenCalled();
    expect(client.uploadFiles).toHaveBeenCalledWith({
      targetDirectoryPath: '/uploads',
      files: [{ name: 'backup.zip', blob: file }],
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not duplicate an unextractable ZIP when a regular upload is retried', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn().mockResolvedValue({
      status: 'not_extractable',
      analysisId: 'analysis-1',
      reason: 'invalid_or_unsupported_archive',
    });
    vi.mocked(client.uploadFiles)
      .mockRejectedValueOnce(new Error('temporary write failure'))
      .mockResolvedValueOnce(undefined);
    const { controller } = createController({ client });
    const file = new File(['not zip'], 'backup.zip');
    await controller.begin({ files: [file] });

    await controller.confirm();
    expect(controller.state.phase).toBe('configuring');
    await controller.confirm();

    expect(client.uploadFiles).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.uploadFiles).mock.calls[1]?.[0].files).toEqual([
      { name: 'backup.zip', blob: file },
    ]);
    expect(controller.state.visibility).toBe('hidden');
  });

  it('keeps mixed-upload files in the directory selected when the dialog opened', async () => {
    const { controller, client, currentDirectoryPath } = createController();
    const zip = new File(['zip'], 'backup.zip');
    const note = new File(['note'], 'note.txt');
    await controller.begin({ files: [zip, note] });

    currentDirectoryPath.value = '/other';
    await controller.confirm();

    expect(client.uploadFiles).toHaveBeenCalledWith({
      targetDirectoryPath: '/uploads',
      files: [{ name: 'note.txt', blob: note }],
    });
  });

  it('executes extraction without uploading the original ZIP file', async () => {
    const { controller, client, refresh } = createController();
    await controller.begin({ files: [new File(['zip'], 'backup.zip')] });
    await controller.setPlacement({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    });

    await controller.confirm();

    expect(client.startZipUpload).toHaveBeenCalledWith(expect.objectContaining({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    }));
    expect(client.uploadFiles).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(controller.state.visibility).toBe('hidden');
  });


  it('returns to the affected ZIP when an earlier multi-ZIP preview becomes outdated', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn(async ({ analysisId, fileName }) => ({
      status: 'extractable' as const,
      analysisId,
      entryCount: 1,
      totalUncompressedSize: 1,
      singleRootDirectoryName: fileName.startsWith('first') ? 'first-root' : 'second-root',
    }));
    client.startZipUpload = vi.fn(() => ({
      result: Promise.resolve({ status: 'preview_outdated' as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    }));
    const { controller } = createController({ client });
    const first = new File(['one'], 'first.zip');
    const second = new File(['two'], 'second.zip');

    await controller.begin({ files: [first, second] });
    await controller.setPlacement({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    });
    await controller.confirm();

    expect(controller.state.currentZipIndex).toBe(1);
    expect(controller.state.currentFileName).toBe('second.zip');

    await controller.setPlacement({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    });
    await controller.confirm();

    expect(controller.state.currentZipIndex).toBe(0);
    expect(controller.state.currentFileName).toBe('first.zip');
    expect(controller.state.singleRootDirectoryName).toBe('first-root');
    expect(controller.state.placement).toEqual({
      kind: 'extract',
      rootHandling: 'preserve',
    });
    expect(controller.state.errorMessage).toContain('changed');
  });

  it('does not rerun completed ZIPs when a later ZIP preview becomes outdated', async () => {
    const client = createClient();
    client.analyzeZipUpload = vi.fn(async ({ analysisId, fileName }) => ({
      status: 'extractable' as const,
      analysisId,
      entryCount: 1,
      totalUncompressedSize: 1,
      singleRootDirectoryName: fileName.replace('.zip', ''),
    }));
    const responses = [
      { status: 'completed' as const },
      { status: 'preview_outdated' as const },
      { status: 'completed' as const },
    ];
    client.startZipUpload = vi.fn(() => ({
      result: Promise.resolve(responses.shift()!),
      cancel: vi.fn().mockResolvedValue(undefined),
    }));
    const { controller } = createController({ client });

    await controller.begin({
      files: [
        new File(['one'], 'first.zip'),
        new File(['two'], 'second.zip'),
      ],
    });
    await controller.confirm();
    await controller.confirm();

    expect(controller.state.currentZipIndex).toBe(1);
    expect(controller.state.phase).toBe('configuring');

    await controller.confirm();

    const analysisIds = vi.mocked(client.startZipUpload).mock.calls.map(
      ([request]) => request.analysisId,
    );
    expect(analysisIds).toHaveLength(3);
    expect(analysisIds[0]).not.toBe(analysisIds[1]);
    expect(analysisIds[2]).toBe(analysisIds[1]);
    expect(controller.state.visibility).toBe('hidden');
  });

  it('ignores and disposes ZIP analysis that completes after the dialog closes', async () => {
    const client = createClient();
    let completeAnalysis: (() => void) | undefined;
    let requestedAnalysisId: string | undefined;
    client.analyzeZipUpload = vi.fn(({ analysisId }) => new Promise<FileExplorerAnalyzeZipUploadResponse>(resolve => {
      requestedAnalysisId = analysisId;
      completeAnalysis = () => resolve({
        status: 'extractable' as const,
        analysisId,
        entryCount: 1,
        totalUncompressedSize: 1,
        singleRootDirectoryName: 'workspace',
      });
    }));
    const { controller } = createController({ client });

    const beginPromise = controller.begin({
      files: [new File(['zip'], 'backup.zip')],
    });
    await vi.waitFor(() => {
      expect(controller.state.phase).toBe('analyzing');
      expect(completeAnalysis).toBeDefined();
    });

    await controller.close();
    completeAnalysis?.();
    await beginPromise;

    expect(controller.state.visibility).toBe('hidden');
    expect(controller.state.phase).toBe('idle');
    expect(client.readZipUploadPreviewDirectory).not.toHaveBeenCalled();
    expect(client.disposeZipUploadAnalysis).toHaveBeenCalledWith({
      analysisId: requestedAnalysisId,
    });
  });

  it('keeps the dialog open and reloads preview when the target changed', async () => {
    const client = createClient();
    client.startZipUpload = vi.fn(() => ({
      result: Promise.resolve({ status: 'preview_outdated' as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    }));
    const { controller } = createController({ client });
    await controller.begin({ files: [new File(['zip'], 'backup.zip')] });
    await controller.setPlacement({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    });

    await controller.confirm();

    expect(controller.state.visibility).toBe('visible');
    expect(controller.state.phase).toBe('configuring');
    expect(controller.state.errorMessage).toContain('changed');
    expect(client.readZipUploadPreviewDirectory).toHaveBeenCalledTimes(3);
  });
});
