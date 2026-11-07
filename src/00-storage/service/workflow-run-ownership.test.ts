import { describe, expect, it, vi } from 'vitest';
import { toWorkflowRunId } from '@/01-models/ids';
import { createWorkflowTestLocks } from './workflow-locks.test-support';
import { acquireWorkflowRunLease } from './workflow-run-ownership';

const id = toWorkflowRunId({ raw: 'run' });

describe('Workflow lifetime lock adapter', () => {
  it('holds only the per-run exclusive lock and returns unavailable rather than waiting', async () => {
    const manager = createWorkflowTestLocks();
    const request = vi.spyOn(manager.locks, 'request');
    const lease = await acquireWorkflowRunLease({ locks: manager.locks, id });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await lease?.release();
      },
    };
    expect(lease).toBeDefined();
    expect(manager.held).toEqual(new Set(['naidan-workflow-run-owner:run']));
    expect(request.mock.calls[0]?.[1]).toEqual({ mode: 'exclusive', ifAvailable: true });
    expect(await acquireWorkflowRunLease({ locks: manager.locks, id })).toBeUndefined();
    expect(manager.queued).toHaveLength(0);
    expect(await manager.locks.request('unrelated', () => 'ready')).toBe('ready');
    await lease!.release();
    // Releasing the hold promise alone is insufficient: the outer request must
    // also settle before a caller can safely start a recovery acquisition.
    expect(manager.held.size).toBe(0);
    const again = await acquireWorkflowRunLease({ locks: manager.locks, id });
    await using cleanupAgain = {
      async [Symbol.asyncDispose]() {
        await again?.release();
      },
    };
    expect(again).toBeDefined();
    await lease!.release();
    expect(manager.held.size).toBe(1);
    void cleanup;
    void cleanupAgain;
  });

  it('waits for the lock manager to release ownership, not merely the callback hold', async () => {
    const manager = createWorkflowTestLocks();
    const lease = await acquireWorkflowRunLease({ locks: manager.locks, id });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await lease?.release();
      },
    };
    const gate = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve();
      },
    };
    manager.beforeRelease({
      hook: async () => {
        closing.resolve();
        await gate.promise;
      },
    });
    let done = false;
    const release = lease!.release().then(() => {
      done = true;
    });
    await closing.promise;
    expect(done).toBe(false);
    expect(manager.held.has('naidan-workflow-run-owner:run')).toBe(true);
    expect(await acquireWorkflowRunLease({ locks: manager.locks, id })).toBeUndefined();
    gate.resolve();
    await release;
    expect(manager.held.size).toBe(0);
    void cleanup;
    void unblock;
  });

  it('validates the raw run identity before touching the lock service', async () => {
    const { locks } = createWorkflowTestLocks();
    const request = vi.spyOn(locks, 'request');
    await expect(acquireWorkflowRunLease({ locks, id: toWorkflowRunId({ raw: '../settings' }) })).rejects.toThrow('Invalid');
    expect(request).not.toHaveBeenCalled();
  });

  it('propagates an asynchronous lock service rejection instead of waiting forever', async () => {
    const { locks } = createWorkflowTestLocks();
    vi.spyOn(locks, 'request').mockRejectedValueOnce(new Error('request rejected'));
    await expect(acquireWorkflowRunLease({ locks, id })).rejects.toThrow('request rejected');
  });

  it('returns synchronous platform failures as a rejected acquisition promise', async () => {
    const { locks } = createWorkflowTestLocks();
    vi.spyOn(locks, 'request').mockImplementationOnce(() => {
      throw new Error('platform failure');
    });
    await expect(acquireWorkflowRunLease({ locks, id })).rejects.toThrow('platform failure');
  });
});
