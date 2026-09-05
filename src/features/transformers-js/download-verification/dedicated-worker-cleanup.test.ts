import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRemote } from '@/utils/worker-transport';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
}));

vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  releaseWorkerRemote: mocks.release,
}));

describe('disposeDedicatedWorkerBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('terminates immediately when remote release never settles', async () => {
    const remote = {} as WorkerRemote<{ ping(): Promise<void> }>;
    const terminate = vi.fn();
    mocks.release.mockReturnValue(new Promise<never>(() => undefined));

    const { disposeDedicatedWorkerBestEffort } = await import('./dedicated-worker-cleanup');
    disposeDedicatedWorkerBestEffort({
      remote,
      worker: { terminate } as unknown as Worker,
    });

    expect(mocks.release).toHaveBeenCalledWith({ remote });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates and consumes asynchronous remote release rejection', async () => {
    const remote = {} as WorkerRemote<{ ping(): Promise<void> }>;
    const terminate = vi.fn();
    mocks.release.mockRejectedValue(new Error('release failed'));

    const { disposeDedicatedWorkerBestEffort } = await import('./dedicated-worker-cleanup');
    disposeDedicatedWorkerBestEffort({
      remote,
      worker: { terminate } as unknown as Worker,
    });
    await Promise.resolve();

    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('still terminates when remote release throws synchronously', async () => {
    const remote = {} as WorkerRemote<{ ping(): Promise<void> }>;
    const terminate = vi.fn();
    mocks.release.mockImplementation(() => {
      throw new Error('release threw');
    });

    const { disposeDedicatedWorkerBestEffort } = await import('./dedicated-worker-cleanup');
    disposeDedicatedWorkerBestEffort({
      remote,
      worker: { terminate } as unknown as Worker,
    });

    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
