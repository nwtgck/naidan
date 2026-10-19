// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createDownloadManager, type DownloadExecution } from './index';
import { downloadTotals } from './progress';
import type { DownloadFile } from '@/01-models/download';

const file: DownloadFile = { name: 'weights.gguf', url: 'https://huggingface.co/owner/repo/resolve/rev/weights.gguf', destination: 'models/weights.gguf', size: 100, completed: 0, state: 'queued' };

function parameters({ key }: { key: string }) {
  return { key, title: key, category: 'file' as const, destination: { kind: 'opfs' as const }, files: [{ ...file }] };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('one session-wide download lane', () => {
  it('queues complete intents and does not invoke a removed request', async () => {
    const manager = createDownloadManager(), gate = Promise.withResolvers<void>();
    const firstRun = vi.fn(() => gate.promise), secondRun = vi.fn(async () => undefined);
    const first = manager.enqueue({ ...parameters({ key: 'first' }), run: firstRun });
    const second = manager.enqueue({ ...parameters({ key: 'second' }), run: secondRun });
    expect(manager.position({ id: second.id })).toBe(2);
    await tick();
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).not.toHaveBeenCalled();
    expect(manager.position({ id: second.id })).toBe(1);
    await manager.remove({ id: second.id });
    expect((await second.done).status).toBe('cancelled');
    gate.resolve();
    expect((await first.done).status).toBe('complete');
    expect(secondRun).not.toHaveBeenCalled();
  });

  it('waits for writer cleanup and puts resumed work behind other requests', async () => {
    const manager = createDownloadManager(), cleanup = Promise.withResolvers<void>();
    const nextGate = Promise.withResolvers<void>(), order: string[] = [];
    let attempt = 0;
    const first = manager.enqueue({
      ...parameters({ key: 'first' }),
      run: async ({ execution }) => {
        order.push(`first-${++attempt}`);
        if (attempt === 1) {
          await new Promise<void>(resolve => execution.signal.addEventListener('abort', () => resolve(), { once: true }));
          await cleanup.promise;
          execution.signal.throwIfAborted();
        }
      },
    });
    const next = manager.enqueue({
      ...parameters({ key: 'next' }),
      run: async () => {
        order.push('next');
        await nextGate.promise;
      },
    });
    await tick();
    manager.pause({ id: first.id });
    await tick();
    expect(manager.snapshot()[0]?.status).toBe('pausing');
    expect(order).toEqual(['first-1']);
    expect(manager.resume({ id: first.id })).toBeUndefined();
    cleanup.resolve();
    expect((await first.done).status).toBe('paused');
    const resumed = manager.resume({ id: first.id });
    await tick();
    expect(order).toEqual(['first-1', 'next']);
    nextGate.resolve();
    await next.done;
    expect((await resumed)?.status).toBe('complete');
    expect(order).toEqual(['first-1', 'next', 'first-2']);
  });

  it('keeps committed success when a pause races with the successful return', async () => {
    const manager = createDownloadManager();
    let id = 0;
    const pending = manager.enqueue({
      ...parameters({ key: 'committed' }),
      run: async () => {
        manager.pause({ id });
      },
    });
    id = pending.id;
    expect((await pending.done).status).toBe('complete');
    expect(manager.resume({ id })).toBeUndefined();
  });

  it('survives an immediate retry from a failed-state subscriber', async () => {
    const manager = createDownloadManager();
    let count = 0;
    let retried: ReturnType<typeof manager.resume>;
    const unsubscribe = manager.subscribe({
      listener: () => {
        const failed = manager.snapshot().find(job => job.status === 'failed');
        if (failed) {
          retried = manager.resume({ id: failed.id });
        }
      },
    });
    using _subscription = { [Symbol.dispose]: unsubscribe };
    const job = manager.enqueue({
      ...parameters({ key: 'retry' }),
      run: async () => {
        if (++count === 1) {
          throw new Error('offline');
        }
      },
    });
    expect((await job.done).status).toBe('failed');
    expect((await retried)?.status).toBe('complete');
    expect(manager.snapshot()[0]?.status).toBe('complete');
    expect(count).toBe(2);
  });

  it('isolates subscriber exceptions and does not let observers mutate internal state', async () => {
    const manager = createDownloadManager();
    using _subscription = {
      [Symbol.dispose]: manager.subscribe({
        listener: () => {
          throw new Error('view unmounted');
        },
      }),
    };
    const input = parameters({ key: 'immutable' });
    const job = manager.enqueue({ ...input, run: async () => undefined });
    input.files[0]!.completed = 50;
    const observed = manager.snapshot()[0]!;
    observed.files[0]!.completed = 99;
    observed.destination.kind = 'opfs';
    expect(manager.snapshot()[0]?.files[0]?.completed).toBe(0);
    expect((await job.done).status).toBe('complete');
  });

  it('ignores callbacks from an already stopped attempt after it is resumed', async () => {
    const manager = createDownloadManager();
    let previous: DownloadExecution | undefined, attempt = 0;
    const job = manager.enqueue({
      ...parameters({ key: 'callbacks' }),
      run: async ({ execution }) => {
        execution.setFiles({ files: [{ ...file }] });
        if (++attempt === 1) {
          previous = execution;
          throw new Error('network failed');
        }
        previous?.reportFile({ index: 0, patch: { completed: 90 } });
        expect(manager.snapshot()[0]?.files[0]?.completed).toBe(0);
        execution.reportFile({ index: 0, patch: { completed: 100, state: 'verifying' } });
        expect(manager.snapshot()[0]?.status).toBe('downloading');
      },
    });
    await job.done;
    expect((await manager.resume({ id: job.id }))?.status).toBe('complete');
  });

  it('quiesces a linked folder without deleting failed intent if unlink subsequently fails', async () => {
    const manager = createDownloadManager(), cleanup = Promise.withResolvers<void>();
    const first = manager.enqueue({
      ...parameters({ key: 'host' }),
      destination: { kind: 'host', directoryId: 'root' },
      run: async ({ execution }) => {
        await new Promise<void>(resolve => execution.signal.addEventListener('abort', () => resolve(), { once: true }));
        await cleanup.promise;
        execution.signal.throwIfAborted();
      },
    });
    const queued = manager.enqueue({ ...parameters({ key: 'host-queued' }), destination: { kind: 'host', directoryId: 'root' }, run: async () => undefined });
    await tick();
    const stopping = manager.stopDirectory({ directoryId: 'root' });
    await tick();
    expect(manager.snapshot().map(job => job.status)).toEqual(['pausing', 'paused']);
    cleanup.resolve();
    await stopping;
    expect((await first.done).status).toBe('paused');
    expect((await queued.done).status).toBe('paused');
    expect((await manager.resume({ id: queued.id }))?.status).toBe('complete');
  });

  it('deduplicates pending keys but admits a new explicit request after completion', async () => {
    const manager = createDownloadManager();
    const run = vi.fn(async () => undefined);
    const a = manager.enqueue({ ...parameters({ key: 'same' }), run });
    expect(manager.enqueue({ ...parameters({ key: 'same' }), run }).id).toBe(a.id);
    await a.done;
    const b = manager.enqueue({ ...parameters({ key: 'same' }), run });
    expect(b.id).not.toBe(a.id);
    await b.done;
    manager.clearCompleted();
    expect(manager.snapshot()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('replaces a failed or paused request when a new owner explicitly enqueues the same key', async () => {
    const manager = createDownloadManager();
    const failed = manager.enqueue({
      ...parameters({ key: 'replace-failed' }),
      run: async () => {
        throw new Error('offline');
      },
    });
    expect((await failed.done).status).toBe('failed');
    const fresh = vi.fn(async () => undefined);
    const replacement = manager.enqueue({ ...parameters({ key: 'replace-failed' }), run: fresh });
    expect(replacement.id).not.toBe(failed.id);
    expect((await replacement.done).status).toBe('complete');
    expect(fresh).toHaveBeenCalledOnce();

    const queued = manager.enqueue({ ...parameters({ key: 'replace-paused' }), run: async () => undefined });
    manager.pause({ id: queued.id });
    expect((await queued.done).status).toBe('paused');
    const newer = manager.enqueue({ ...parameters({ key: 'replace-paused' }), run: fresh });
    expect(newer.id).not.toBe(queued.id);
    expect((await newer.done).status).toBe('complete');
    expect(fresh).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid progress without letting the error stop subsequent requests', async () => {
    const manager = createDownloadManager();
    const invalid = manager.enqueue({
      ...parameters({ key: 'invalid' }),
      run: async ({ execution }) => {
        execution.reportFile({ index: 0, patch: { completed: 101 } });
      },
    });
    const valid = manager.enqueue({ ...parameters({ key: 'valid' }), run: async () => undefined });
    expect((await invalid.done).status).toBe('failed');
    expect((await valid.done).status).toBe('complete');
  });
});

it('reports unknown aggregate size without inventing per-file progress', () => {
  expect(downloadTotals({ files: [{ ...file, completed: 40 }, { ...file, size: undefined, completed: 20 }] })).toEqual({ completed: 60, size: undefined, percent: undefined });
  expect(downloadTotals({ files: [{ ...file, completed: 40 }, { ...file, size: 300, completed: 20 }] })).toEqual({ completed: 60, size: 400, percent: 15 });
});

it('starts retry authorization synchronously in the gesture and releases it after completion', async () => {
  const manager = createDownloadManager();
  let authorized = false;
  const authorize = vi.fn(() => {
    authorized = true;
  });
  const job = manager.enqueue({
    ...parameters({ key: 'permission' }),
    onResume: authorize,
    run: async () => {
      if (!authorized) {
        throw new Error('permission denied');
      }
    },
  });
  expect((await job.done).status).toBe('failed');
  const next = manager.resume({ id: job.id });
  expect(authorize).toHaveBeenCalledOnce();
  expect((await next)?.status).toBe('complete');
  expect(manager.resume({ id: job.id })).toBeUndefined();
  expect(authorize).toHaveBeenCalledOnce();
});

it('isolates synchronous retry authorization failure without blocking unrelated requests', async () => {
  const manager = createDownloadManager();
  const job = manager.enqueue({
    ...parameters({ key: 'failure' }),
    onResume() {
      throw new Error('unavailable');
    },
    run: async () => {
      throw new Error('offline');
    },
  });
  await job.done;
  expect(await manager.resume({ id: job.id })).toMatchObject({ status: 'failed', error: 'unavailable' });
  const next = manager.enqueue({ ...parameters({ key: 'next' }), run: async () => undefined });
  expect((await next.done).status).toBe('complete');
});
