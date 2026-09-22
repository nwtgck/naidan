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
