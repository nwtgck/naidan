// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createLockQueue } from './opfs-lock-test-platform';

it('shares readers, queues writers in order, and holds each callback until settlement', async () => {
  const platform = createLockQueue();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const reader = platform.locks.request('file', { mode: 'shared' }, async () => {
    order.push('reader'); entered.resolve(); await release.promise;
  });
  await entered.promise;
  await platform.locks.request('file', { mode: 'shared', ifAvailable: true }, () => {
    order.push('shared');
  });
  const writer = platform.locks.request('file', { mode: 'exclusive' }, () => {
    order.push('writer');
  });
  const laterReader = platform.locks.request('file', { mode: 'shared' }, () => {
    order.push('later-reader');
  });
  const available: Array<Lock | null> = [];
  await platform.locks.request('file', { mode: 'shared', ifAvailable: true }, lock => {
    available.push(lock);
  });
  await platform.locks.request('other-file', { mode: 'exclusive' }, () => {
    order.push('independent');
  });
  expect(order).toEqual(['reader', 'shared', 'independent']);
  expect(available).toEqual([null]);
  expect(platform.held.get('file')).toHaveLength(1);
  expect(platform.queued).toHaveLength(2);
  release.resolve();
  await Promise.all([reader, writer, laterReader]);
  expect(order).toEqual(['reader', 'shared', 'independent', 'writer', 'later-reader']);
  expect(platform.held.size).toBe(0);
  expect(platform.queued).toEqual([]);
});

it('cancels only a waiting request and removes its queue reservation', async () => {
  const platform = createLockQueue();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = platform.locks.request('file', { mode: 'exclusive' }, async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  const canceled = vi.fn();
  const waiting = platform.locks.request('file', { mode: 'exclusive', signal: controller.signal }, canceled);
  const observed = waiting.catch(error => error);
  const next = vi.fn();
  const succeeding = platform.locks.request('file', { mode: 'exclusive' }, next);
  const failure = new Error('Synthetic waiting cancellation');
  controller.abort(failure);
  expect(await observed).toBe(failure);
  expect(canceled).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  expect(platform.held.get('file')).toHaveLength(1);
  expect(platform.queued).toHaveLength(1);
  release.resolve();
  await Promise.all([holder, succeeding]);
  expect(next).toHaveBeenCalledOnce();
  expect(platform.held.size).toBe(0);
  expect(platform.queued).toEqual([]);
});

it('does not release a granted lock when its admission signal is later aborted', async () => {
  const platform = createLockQueue();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const holder = platform.locks.request('file', { mode: 'exclusive', signal: controller.signal }, async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  controller.abort();
  const next = vi.fn();
  const waiting = platform.locks.request('file', { mode: 'exclusive' }, next);
  await Promise.resolve();
  expect(next).not.toHaveBeenCalled();
  expect(platform.held.get('file')).toHaveLength(1);
  release.resolve();
  await Promise.all([holder, waiting]);
  expect(next).toHaveBeenCalledOnce();
  expect(platform.held.size).toBe(0);
});

it('releases after callback rejection and rejects pre-aborted requests without granting them', async () => {
  const platform = createLockQueue();
  const failure = new Error('Synthetic callback failure');
  await expect(platform.locks.request('file', { mode: 'exclusive' }, () => {
    throw failure;
  })).rejects.toBe(failure);
  expect(platform.held.size).toBe(0);
  const controller = new AbortController();
  controller.abort(failure);
  const callback = vi.fn();
  await expect(platform.locks.request('file', { mode: 'exclusive', signal: controller.signal }, callback)).rejects.toBe(failure);
  expect(callback).not.toHaveBeenCalled();
  expect(platform.queued).toEqual([]);
  expect(platform.events).toEqual(['grant:file:exclusive', 'release:file:exclusive']);
});
