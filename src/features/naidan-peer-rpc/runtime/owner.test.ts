import { afterEach, expect, it, vi } from 'vitest';
import { acquireRpcOwner } from './owner';

import { createWebLocksFixture as locks } from './test-support/web-locks';

afterEach(() => vi.unstubAllGlobals());

it('uses a valid conditional Web Locks request and holds the lease until explicit release', async () => {
  const native = locks();
  const acquisition = acquireRpcOwner({ signal: new AbortController().signal });
  native.dispatch();
  const lease = await acquisition;
  expect(native.request).toHaveBeenCalledWith('naidan-peer-rpc-owner/v1', { ifAvailable: true }, expect.any(Function));
  expect(native.held()).toBe(true);
  lease.release(); lease.release();
  await vi.waitFor(() => expect(native.held()).toBe(false));
});

it('rejects an already aborted acquisition without requesting a lock', () => {
  const native = locks(), stop = new AbortController();
  stop.abort(new Error('Stopped before request'));
  expect(() => acquireRpcOwner({ signal: stop.signal })).toThrow('Stopped before request');
  expect(native.request).not.toHaveBeenCalled();
});

it('abandons a conditional grant arriving after cancellation and does not publish a lease', async () => {
  const native = locks(), stop = new AbortController();
  const acquisition = acquireRpcOwner({ signal: stop.signal });
  const rejected = expect(acquisition).rejects.toThrow('Stopped before grant');
  stop.abort(new Error('Stopped before grant'));
  native.dispatch();
  await rejected;
  await vi.waitFor(() => expect(native.held()).toBe(false));
});

it('does not release an acquired lock merely because its parent signal aborts', async () => {
  const native = locks(), stop = new AbortController();
  const acquisition = acquireRpcOwner({ signal: stop.signal }); native.dispatch();
  const lease = await acquisition;
  stop.abort();
  await Promise.resolve();
  expect(native.held()).toBe(true);
  // The manager must first retire its real work, then explicitly release.
  lease.release();
  await vi.waitFor(() => expect(native.held()).toBe(false));
});

it('fails without queueing or stealing when another owner is active', async () => {
  const native = locks();
  const first = acquireRpcOwner({ signal: new AbortController().signal }); native.dispatch();
  const lease = await first;
  const second = acquireRpcOwner({ signal: new AbortController().signal });
  const rejected = expect(second).rejects.toThrow('another tab'); native.dispatch();
  await rejected;
  expect(native.held()).toBe(true);
  lease.release(); await vi.waitFor(() => expect(native.held()).toBe(false));
  const next = acquireRpcOwner({ signal: new AbortController().signal }); native.dispatch();
  const nextLease = await next;
  expect(native.held()).toBe(true); nextLease.release();
  await vi.waitFor(() => expect(native.held()).toBe(false));
});

it('reports an unavailable lock API without a process-local fallback', async () => {
  vi.stubGlobal('navigator', {});
  await expect(acquireRpcOwner({ signal: new AbortController().signal })).rejects.toThrow('unavailable');
});

it('preserves browser request failures and allows the next explicit attempt', async () => {
  const request = vi.fn().mockRejectedValue(new DOMException('Storage unavailable', 'SecurityError'));
  vi.stubGlobal('navigator', { locks: { request } });
  await expect(acquireRpcOwner({ signal: new AbortController().signal })).rejects.toMatchObject({ name: 'SecurityError' });
  expect(request).toHaveBeenCalledOnce();
  const native = locks();
  const next = acquireRpcOwner({ signal: new AbortController().signal }); native.dispatch();
  const lease = await next; lease.release();
  await vi.waitFor(() => expect(native.held()).toBe(false));
});
