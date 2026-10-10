import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createMetadataSession } from './metadata-session';
import type { discoverRepository, RepositoryCatalog } from './catalog';
const catalog: RepositoryCatalog = { repository: 'owner/model', revision: 'a'.repeat(40), models: [], projectors: [] };

describe('explicit-only repository metadata session', () => {
  it('does nothing until requested, caches across option changes and refreshes only on an explicit action', async () => {
    let now = 0;
    const discover = vi.fn<typeof discoverRepository>().mockResolvedValue(catalog);
    const session = createMetadataSession({ discover, now: () => now });
    await flushPromises(); expect(discover).not.toHaveBeenCalled();
    const request = { input: 'owner/model', signal: new AbortController().signal, freshness: 'reuse' as const };
    await session.inspect(request); await session.inspect(request);
    expect(discover).toHaveBeenCalledOnce();
    now = 60_001; await flushPromises(); expect(discover).toHaveBeenCalledOnce();
    await session.inspect(request); expect(discover).toHaveBeenCalledTimes(2);
    await session.inspect({ ...request, freshness: 'refresh' }); expect(discover).toHaveBeenCalledTimes(3);
  });

  it('serializes requests, shares a cached repository and skips cancelled waiting metadata', async () => {
    const gate = Promise.withResolvers<RepositoryCatalog>();
    const discover = vi.fn<typeof discoverRepository>().mockReturnValueOnce(gate.promise).mockResolvedValue(catalog);
    const session = createMetadataSession({ discover, now: () => 0 });
    const signal = new AbortController().signal;
    const first = session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    const second = session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    const abort = new AbortController();
    const cancelled = session.inspect({ input: 'owner/other', signal: abort.signal, freshness: 'reuse' });
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await flushPromises(); expect(discover).toHaveBeenCalledOnce(); abort.abort();
    gate.resolve(catalog); await first; await second; await rejection;
    expect(discover).toHaveBeenCalledOnce();
  });

  it('does not cache aborted responses and a failed request does not block the next explicit request', async () => {
    const controller = new AbortController();
    const discover = vi.fn<typeof discoverRepository>().mockImplementationOnce(async () => {
      controller.abort(); return catalog;
    }).mockResolvedValue(catalog);
    const session = createMetadataSession({ discover, now: () => 0 });
    await expect(session.inspect({ input: 'owner/model', signal: controller.signal, freshness: 'reuse' })).rejects.toMatchObject({ name: 'AbortError' });
    await session.inspect({ input: 'owner/model', signal: new AbortController().signal, freshness: 'reuse' });
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

describe('metadata cache latency without relaxed ordering', () => {
  it('returns a fresh cached repository without waiting for an unrelated network request', async () => {
    const gate = Promise.withResolvers<RepositoryCatalog>();
    const discover = vi.fn<typeof discoverRepository>().mockResolvedValueOnce(catalog).mockReturnValueOnce(gate.promise);
    const session = createMetadataSession({ discover, now: () => 0 });
    const signal = new AbortController().signal;
    await session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    const slow = session.inspect({ input: 'owner/other', signal, freshness: 'reuse' });
    await flushPromises();
    let reused = false;
    const cached = session.inspect({ input: 'owner/model:Q8_0', signal, freshness: 'reuse' }).then(value => {
      reused = true; return value;
    });
    await flushPromises(); expect(reused).toBe(true); expect(await cached).toBe(catalog);
    expect(discover).toHaveBeenCalledTimes(2);
    gate.resolve({ ...catalog, repository: 'owner/other' }); await slow;
  });

  it('does not jump over a pending explicit refresh of the same repository', async () => {
    const gate = Promise.withResolvers<RepositoryCatalog>();
    const discover = vi.fn<typeof discoverRepository>().mockResolvedValueOnce(catalog).mockReturnValueOnce(gate.promise);
    const session = createMetadataSession({ discover, now: () => 0 }); const signal = new AbortController().signal;
    await session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    const refresh = session.inspect({ input: 'owner/model', signal, freshness: 'refresh' });
    let resolved = false;
    const reuse = session.inspect({ input: 'OWNER/model:Q4_K_M', signal, freshness: 'reuse' }).then(value => {
      resolved = true; return value;
    });
    await flushPromises(); expect(resolved).toBe(false);
    const updated = { ...catalog, revision: 'b'.repeat(40) }; gate.resolve(updated);
    await refresh; expect(await reuse).toBe(updated); expect(discover).toHaveBeenCalledTimes(2);
  });

  it('checks cancellation even on a cache hit and does not extend the cache lifetime', async () => {
    let now = 0;
    const discover = vi.fn<typeof discoverRepository>().mockResolvedValue(catalog);
    const session = createMetadataSession({ discover, now: () => now }); const signal = new AbortController().signal;
    await session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    const abort = new AbortController();
    const cached = session.inspect({ input: 'owner/model', signal: abort.signal, freshness: 'reuse' });
    abort.abort(); await expect(cached).rejects.toMatchObject({ name: 'AbortError' });
    await expect(session.inspect({ input: 'owner/model', signal: abort.signal, freshness: 'reuse' })).rejects.toMatchObject({ name: 'AbortError' });
    now = 59000; await session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    now = 60000; await session.inspect({ input: 'owner/model', signal, freshness: 'reuse' });
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
