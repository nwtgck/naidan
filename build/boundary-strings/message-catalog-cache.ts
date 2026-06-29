import type { BoundaryStringMessageCatalog } from './message-catalog';

type BoundaryStringMessageCatalogCacheState =
  | {
      catalog: BoundaryStringMessageCatalog;
      freshness: 'current';
    }
  | {
      catalog: BoundaryStringMessageCatalog;
      freshness: 'stale';
    };

export type BoundaryStringMessageCatalogCache = {
  markStale(): void;
  read({ refresh }: {
    refresh: 'if-stale' | 'force';
  }): {
    catalog: BoundaryStringMessageCatalog;
    refreshResult: 'performed' | 'not-needed';
  };
};

export function createBoundaryStringMessageCatalogCache({ initialCatalog, readCatalog }: {
  initialCatalog: BoundaryStringMessageCatalog;
  readCatalog: () => BoundaryStringMessageCatalog;
}): BoundaryStringMessageCatalogCache {
  let state: BoundaryStringMessageCatalogCacheState = {
    catalog: initialCatalog,
    freshness: 'current',
  };

  function markStale(): void {
    state = {
      catalog: state.catalog,
      freshness: 'stale',
    };
  }

  function refreshCatalog(): BoundaryStringMessageCatalog {
    state = {
      catalog: state.catalog,
      freshness: 'stale',
    };
    const catalog = readCatalog();
    state = {
      catalog,
      freshness: 'current',
    };
    return catalog;
  }

  function read({ refresh }: {
    refresh: 'if-stale' | 'force';
  }): {
    catalog: BoundaryStringMessageCatalog;
    refreshResult: 'performed' | 'not-needed';
  } {
    switch (refresh) {
    case 'force':
      return {
        catalog: refreshCatalog(),
        refreshResult: 'performed',
      };
    case 'if-stale':
      switch (state.freshness) {
      case 'current':
        return {
          catalog: state.catalog,
          refreshResult: 'not-needed',
        };
      case 'stale':
        return {
          catalog: refreshCatalog(),
          refreshResult: 'performed',
        };
      default: {
        const _exhaustive: never = state;
        throw new Error(
          `Unsupported Boundary Strings catalog freshness: ${String(_exhaustive)}`,
        );
      }
      }
    default: {
      const _exhaustive: never = refresh;
      throw new Error(`Unsupported Boundary Strings catalog refresh mode: ${_exhaustive}`);
    }
    }
  }

  return {
    markStale,
    read,
  };
}
