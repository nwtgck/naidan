import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadHuggingFaceFiles } from './client';
import { createFileDownloadSession } from './worker/factory';
import { acquireHuggingFaceFiles } from './acquire';
import { privacyFetchStream } from '@/features/privacy-fetch';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type { FileDownloadWorker } from './worker/types';
import { TEST_ONLY as transportTest } from '@/utils/worker-transport';
import { installHandleCloneProbe } from '@/utils/worker-capability-probe.test-support';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';

vi.mock('./worker/factory', () => ({ createFileDownloadSession: vi.fn() }));
vi.mock('./acquire', () => ({ acquireHuggingFaceFiles: vi.fn(async () => {}) }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
const state = vi.hoisted(() => ({ download: vi.fn<WorkerServerApi<FileDownloadWorker>['download']>(async () => {}), cancel: vi.fn(), dispose: vi.fn(async () => {}) }));

beforeEach(() => {
  transportTest.resetCapabilitySupport();
  vi.clearAllMocks();
  vi.mocked(createFileDownloadSession).mockResolvedValue({ worker: new EventTarget() as Worker, remote: { download: state.download, cancel: state.cancel } as unknown as Awaited<ReturnType<typeof createFileDownloadSession>>['remote'], dispose: state.dispose });
});

function request() {
  return { files: [{ repository: 'owner/model', path: 'model.gguf', revision: 'a'.repeat(40), expectedSize: 24 }], signal: new AbortController().signal, onProgress: vi.fn(), validation: 'model-weight' as const, expectedRoot: new MockFileSystemDirectoryHandle({ name: 'Models' }) as FileSystemDirectoryHandle, destination: { kind: 'host' as const, directoryId: 'accepted-directory' } };
}

describe('download capability admission', () => {
  it('keeps unsupported linked-folder writes on the original root without creating a Worker', async () => {
    using probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const input = request();
    await downloadHuggingFaceFiles(input);
    expect(acquireHuggingFaceFiles).toHaveBeenCalledExactlyOnceWith({ ...input, onProgress: expect.any(Function), fetch: privacyFetchStream });
    expect(createFileDownloadSession).not.toHaveBeenCalled();
    expect(state.download).not.toHaveBeenCalled();
    expect(probe.probes).toEqual([input.expectedRoot]);
  });

  it('keeps fallback progress validated, non-controlling and silent after cancellation', async () => {
    using _probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const input = request(), control = new AbortController();
    input.onProgress.mockImplementation(() => {
      throw new Error('presentation failed');
    });
    await downloadHuggingFaceFiles({ ...input, signal: control.signal });
    const report = vi.mocked(acquireHuggingFaceFiles).mock.calls[0]![0].onProgress;
    const progress = { phase: 'checking' as const, index: 0, count: 1, path: 'model.gguf', repository: 'owner/model', revision: 'a'.repeat(40), completed: 0, total: 24, processed: 0, fileCompleted: 0, fileTotal: 24 };
    expect(() => report({ progress })).not.toThrow();
    expect(input.onProgress).toHaveBeenCalledExactlyOnceWith({ progress });
    report({ progress: { ...progress, completed: -1 } });
    expect(input.onProgress).toHaveBeenCalledOnce();
    control.abort();
    report({ progress });
    expect(input.onProgress).toHaveBeenCalledOnce();
  });

  it('does not send an unnecessary OPFS handle, keeping the worker sync-writer path', async () => {
    using probe = installHandleCloneProbe({ mode: () => 'unsupported' });
    const input = request();
    await downloadHuggingFaceFiles({ ...input, destination: { kind: 'opfs' } });
    expect(state.download).toHaveBeenCalledOnce();
    expect(state.download.mock.calls[0]?.[0]).toMatchObject({ destination: { kind: 'opfs' }, expectedRoot: undefined });
    expect(acquireHuggingFaceFiles).not.toHaveBeenCalled();
    expect(probe.probes).toEqual([]);
    expect(state.dispose).toHaveBeenCalledOnce();
  });

  it('retains a supported linked root and does not replay a remote clone error as a download', async () => {
    using probe = installHandleCloneProbe();
    const input = request(), failure = new DOMException('Cannot clone worker result', 'DataCloneError');
    state.download.mockRejectedValueOnce(failure);
    await expect(downloadHuggingFaceFiles(input)).rejects.toBe(failure);
    expect(probe.probes).toEqual([input.expectedRoot]);
    expect(state.download).toHaveBeenCalledOnce();
    expect(acquireHuggingFaceFiles).not.toHaveBeenCalled();
    expect(state.dispose).toHaveBeenCalledOnce();
  });

  it('does not start a download when cancelled while checking the root', async () => {
    using probe = installHandleCloneProbe();
    const input = request(), control = new AbortController(), gate = Promise.withResolvers<boolean>();
    input.expectedRoot.isSameEntry = () => gate.promise;
    const pending = downloadHuggingFaceFiles({ ...input, signal: control.signal });
    await vi.waitFor(() => expect(probe.probes).toHaveLength(1));
    control.abort();
    gate.resolve(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(createFileDownloadSession).not.toHaveBeenCalled();
    expect(acquireHuggingFaceFiles).not.toHaveBeenCalled();
  });
});
