import { describe, expect, it, vi } from 'vitest';

import type { BoundaryStringMessageCatalog } from './message-catalog';
import { createBoundaryStringMessageCatalogCache } from './message-catalog-cache';

function catalog({ key }: {
  key: string;
}): BoundaryStringMessageCatalog {
  const message = {
    key,
    modulesByLocale: {
      en: {
        filePath: `/messages/${key}/en.ts`,
        sourceModuleId: `/messages/${key}/en.ts`,
      },
      ja: {
        filePath: `/messages/${key}/ja.ts`,
        sourceModuleId: `/messages/${key}/ja.ts`,
      },
    },
  };
  return {
    messages: [message],
    messagesByKey: new Map([[key, message]]),
  };
}

describe('Boundary Strings message catalog cache', () => {
  it('returns the initial catalog without reading while current', () => {
    const initialCatalog = catalog({ key: 'Example__initial' });
    const readCatalog = vi.fn(() => catalog({ key: 'Example__next' }));
    const cache = createBoundaryStringMessageCatalogCache({ initialCatalog, readCatalog });

    expect(cache.read({ refresh: 'if-stale' })).toEqual({
      catalog: initialCatalog,
      refreshResult: 'not-needed',
    });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('coalesces repeated stale marks into one refresh', () => {
    const initialCatalog = catalog({ key: 'Example__initial' });
    const nextCatalog = catalog({ key: 'Example__next' });
    const readCatalog = vi.fn(() => nextCatalog);
    const cache = createBoundaryStringMessageCatalogCache({ initialCatalog, readCatalog });

    cache.markStale();
    cache.markStale();

    expect(cache.read({ refresh: 'if-stale' })).toEqual({
      catalog: nextCatalog,
      refreshResult: 'performed',
    });
    expect(cache.read({ refresh: 'if-stale' })).toEqual({
      catalog: nextCatalog,
      refreshResult: 'not-needed',
    });
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it('forces a refresh while current', () => {
    const nextCatalog = catalog({ key: 'Example__next' });
    const readCatalog = vi.fn(() => nextCatalog);
    const cache = createBoundaryStringMessageCatalogCache({
      initialCatalog: catalog({ key: 'Example__initial' }),
      readCatalog,
    });

    expect(cache.read({ refresh: 'force' })).toEqual({
      catalog: nextCatalog,
      refreshResult: 'performed',
    });
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it('remains stale after a failed refresh and retries later', () => {
    const initialCatalog = catalog({ key: 'Example__initial' });
    const nextCatalog = catalog({ key: 'Example__next' });
    const readCatalog = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('incomplete patch');
      })
      .mockReturnValueOnce(nextCatalog);
    const cache = createBoundaryStringMessageCatalogCache({ initialCatalog, readCatalog });

    cache.markStale();
    expect(() => cache.read({ refresh: 'if-stale' })).toThrow('incomplete patch');
    expect(cache.read({ refresh: 'if-stale' })).toEqual({
      catalog: nextCatalog,
      refreshResult: 'performed',
    });
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });
});
