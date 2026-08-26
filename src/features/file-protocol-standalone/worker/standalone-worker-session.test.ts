import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
} from './standalone-worker-session';

vi.mock('comlink', async (importOriginal) => {
  const original = await importOriginal<typeof import('comlink')>();
  return {
    ...original,
    wrap: vi.fn(),
  };
});

function createWorkerMock(): Worker {
  return {
    terminate: vi.fn(),
  } as unknown as Worker;
}

function createRemoteMock({ release }: {
  release: () => Promise<unknown> | unknown,
}): Record<PropertyKey, unknown> {
  return {
    [Comlink.releaseProxy]: vi.fn(release),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('standalone Worker session', () => {
  it('terminates the physical Worker when Comlink wrapping fails', async () => {
    const worker = createWorkerMock();
    vi.mocked(Comlink.wrap).mockImplementation(() => {
      throw new Error('wrap failed');
    });

    await expect(createStandaloneWorkerSession({
      createWorker: async () => worker,
    })).rejects.toThrow('wrap failed');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('releases Comlink and terminates the Worker', async () => {
    const worker = createWorkerMock();
    const remote = createRemoteMock({ release: async () => undefined });
    vi.mocked(Comlink.wrap).mockReturnValue(remote as never);
    const session = await createStandaloneWorkerSession<Record<string, never>>({
      createWorker: async () => worker,
    });

    await disposeStandaloneWorkerSession({
      session,
      beforeRelease: undefined,
      cleanupTimeoutMs: 100,
    });

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the Worker when Comlink release never settles', async () => {
    vi.useFakeTimers();
    const worker = createWorkerMock();
    const remote = createRemoteMock({ release: () => new Promise(() => undefined) });
    vi.mocked(Comlink.wrap).mockReturnValue(remote as never);
    const session = await createStandaloneWorkerSession<Record<string, never>>({
      createWorker: async () => worker,
    });

    const disposal = disposeStandaloneWorkerSession({
      session,
      beforeRelease: undefined,
      cleanupTimeoutMs: 25,
    });
    const rejection = expect(disposal).rejects.toThrow('Comlink release timed out');
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });


  it('makes repeated disposal idempotent', async () => {
    const worker = createWorkerMock();
    const remote = createRemoteMock({ release: async () => undefined });
    vi.mocked(Comlink.wrap).mockReturnValue(remote as never);
    const session = await createStandaloneWorkerSession<Record<string, never>>({
      createWorker: async () => worker,
    });
    const beforeRelease = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      disposeStandaloneWorkerSession({
        session,
        beforeRelease,
        cleanupTimeoutMs: 100,
      }),
      disposeStandaloneWorkerSession({
        session,
        beforeRelease,
        cleanupTimeoutMs: 100,
      }),
    ]);

    expect(beforeRelease).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('attempts release even when logical cleanup fails', async () => {
    const worker = createWorkerMock();
    const remote = createRemoteMock({ release: async () => {
      throw new Error('release failed');
    } });
    vi.mocked(Comlink.wrap).mockReturnValue(remote as never);
    const session = await createStandaloneWorkerSession<Record<string, never>>({
      createWorker: async () => worker,
    });

    await expect(disposeStandaloneWorkerSession({
      session,
      beforeRelease: async () => {
        throw new Error('logical cleanup failed');
      },
      cleanupTimeoutMs: 100,
    })).rejects.toBeInstanceOf(AggregateError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
