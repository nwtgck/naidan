import { describe, expect, it, vi } from 'vitest';
import { createQueuedTestLockManager } from './test-lock-manager';

describe('queued HizoFS test lock manager', () => {
  it('removes an aborted queued request without cancelling the active lock', async () => {
    const manager = createQueuedTestLockManager({ onRequest: undefined });
    const release = Promise.withResolvers<void>();
    const activeStarted = Promise.withResolvers<void>();
    const active = manager.request(
      'resource',
      { mode: 'exclusive' },
      async () => {
        activeStarted.resolve();
        await release.promise;
        return 'active';
      },
    );
    await activeStarted.promise;

    const callback = vi.fn(() => 'queued');
    const abortController = new AbortController();
    const queued = manager.request(
      'resource',
      { mode: 'exclusive', signal: abortController.signal },
      callback,
    );
    abortController.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(callback).not.toHaveBeenCalled();
    release.resolve();
    await expect(active).resolves.toBe('active');
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted request before invoking its callback', async () => {
    const manager = createQueuedTestLockManager({ onRequest: undefined });
    const abortController = new AbortController();
    abortController.abort();
    const callback = vi.fn(() => undefined);

    await expect(manager.request(
      'resource',
      { mode: 'exclusive', signal: abortController.signal },
      callback,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not cancel a callback after its lock has been acquired', async () => {
    const manager = createQueuedTestLockManager({ onRequest: undefined });
    const abortController = new AbortController();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const result = manager.request(
      'resource',
      { mode: 'exclusive', signal: abortController.signal },
      async () => {
        started.resolve();
        await release.promise;
        return 'completed';
      },
    );
    await started.promise;
    abortController.abort();
    release.resolve();

    await expect(result).resolves.toBe('completed');
  });
});
