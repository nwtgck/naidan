import { discoverRepository, parseRepository, type RepositoryCatalog } from './catalog';

/**
 * Explicit-action-only, serialized metadata access. Constructing this session
 * does no I/O. Expiration is checked on request, never by a background timer.
 */
export function createMetadataSession({ discover, now }: { discover: typeof discoverRepository, now: () => number }) {
  const cache = new Map<string, { catalog: RepositoryCatalog, checkedAt: number }>();
  let tail: Promise<void> = Promise.resolve();
  const pending = new Map<string, number>();
  const maxAgeMs = 60_000;
  function inspect({ input, signal, freshness }: { input: string, signal: AbortSignal, freshness: 'reuse' | 'refresh' }): Promise<RepositoryCatalog> {
    const repository = parseRepository({ input }).repository.toLowerCase();
    if (signal.aborted) return Promise.reject(signal.reason);
    const cached = cache.get(repository);
    // A valid local hit needs no network lane. Preserve ordering for a pending
    // refresh of THIS repository, without waiting behind unrelated discovery.
    if (freshness === 'reuse' && !pending.has(repository) && cached && now() - cached.checkedAt < maxAgeMs) {
      return Promise.resolve().then(() => {
        signal.throwIfAborted(); return cached.catalog;
      });
    }
    pending.set(repository, (pending.get(repository) ?? 0) + 1);
    const result = tail.then(async () => {
      signal.throwIfAborted();
      const cached = cache.get(repository);
      if (freshness === 'reuse' && cached && now() - cached.checkedAt < maxAgeMs) return cached.catalog;
      const catalog = await discover({ input, signal });
      signal.throwIfAborted();
      cache.delete(repository);
      cache.set(repository, { catalog, checkedAt: now() });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
      return catalog;
    });
    const settled = result.finally(() => {
      const remaining = (pending.get(repository) ?? 1) - 1;
      if (remaining === 0) pending.delete(repository); else pending.set(repository, remaining);
    });
    tail = settled.then(() => {}, () => {});
    return settled;
  }
  return { inspect };
}

let session: ReturnType<typeof createMetadataSession> | undefined;
export function getMetadataSession(): ReturnType<typeof createMetadataSession> {
  session ??= createMetadataSession({ discover: discoverRepository, now: () => Date.now() });
  return session;
}
export const TEST_ONLY = {
  reset: () => {
    session = undefined;
  },
};
