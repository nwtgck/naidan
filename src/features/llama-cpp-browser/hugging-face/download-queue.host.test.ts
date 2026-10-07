// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { createDownloadQueue, downloadJobKey } from './download-queue';
import { downloadRepository } from './download';
import type { DownloadSelection } from './types';
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
const selection: DownloadSelection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] };
let root: MemoryDirectory;

beforeEach(() => {
  root = new MemoryDirectory('models'); vi.mocked(hostModelHandles.get).mockReset().mockResolvedValue(root as unknown as HostModelDirectoryHandle);
});

afterEach(() => vi.restoreAllMocks());

describe('destination-bound download queue', () => {
  it('separates identical intents in OPFS and two linked roots', async () => {
    const download = vi.fn<typeof downloadRepository>().mockResolvedValue(undefined); const queue = createDownloadQueue({ download });
    const first = queue.enqueue({ key: 'same', repository: selection.repository, source: 'repository', prepare: async () => selection });
    const second = queue.enqueue({ key: 'same', repository: selection.repository, source: 'repository', destination: { kind: 'host', directoryId: 'a' }, prepare: async () => selection });
    const third = queue.enqueue({ key: 'same', repository: selection.repository, source: 'repository', destination: { kind: 'host', directoryId: 'b' }, prepare: async () => selection });
    await Promise.all([first.done, second.done, third.done]);
    expect(queue.jobs.value.map(job => job.key)).toEqual(['same', 'same:destination:host/a', 'same:destination:host/b']);
    expect(download).toHaveBeenCalledTimes(3);
    expect(downloadJobKey({ key: 'same:destination:host/a', destination: { kind: 'host', directoryId: 'a' } })).toBe('same:destination:host/a');
  });

  it('captures mutable destination input and physical root at enqueue', async () => {
    const download = vi.fn<typeof downloadRepository>().mockResolvedValue(undefined); const queue = createDownloadQueue({ download });
    const destination = { kind: 'host' as const, directoryId: 'a' };
    const job = queue.enqueue({ key: 'same', repository: selection.repository, source: 'repository', destination, prepare: async () => selection });
    destination.directoryId = 'b'; await job.done;
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ destination: { kind: 'host', directoryId: 'a' }, expectedRoot: root }));
  });

  it('refuses a root replaced during the permission prompt before metadata discovery', async () => {
    const download = vi.fn<typeof downloadRepository>().mockResolvedValue(undefined); const prepare = vi.fn(async () => selection); const queue = createDownloadQueue({ download });
    const approved = new MemoryDirectory('old-models');
    const job = queue.enqueue({ key: 'same', repository: selection.repository, source: 'repository', destination: { kind: 'host', directoryId: 'a' }, expectedRoot: approved as unknown as FileSystemDirectoryHandle, prepare });
    expect((await job.done).status).toBe('failed'); expect(prepare).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  });

  it('cancels every queued job for an unlinked root and waits for the active writer to clean up', async () => {
    const started = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>();
    const download = vi.fn<typeof downloadRepository>().mockImplementation(async ({ signal }) => {
      started.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleanup.promise; signal.throwIfAborted();
    });
    const queue = createDownloadQueue({ download }); const destination = { kind: 'host' as const, directoryId: 'a' };
    const first = queue.enqueue({ key: 'first', repository: selection.repository, source: 'repository', destination, prepare: async () => selection });
    const prepare = vi.fn(async () => selection); const second = queue.enqueue({ key: 'second', repository: selection.repository, source: 'repository', destination, prepare });
    await started.promise; let stopped = false; const stopping = queue.stopDirectory({ directoryId: 'a' }).then(() => {
      stopped = true;
    });
    await Promise.resolve(); expect(stopped).toBe(false); expect((await second.done).status).toBe('cancelled'); expect(prepare).not.toHaveBeenCalled();
    cleanup.resolve(); await stopping; expect((await first.done).status).toBe('paused'); expect(download).toHaveBeenCalledOnce();
  });
});
