import {
  isBoundaryStringDiagnosticError,
  unknownMessageKeyDiagnostic,
  type BoundaryStringDiagnostic,
} from './diagnostics';
import type { BoundaryStringMessageCatalog } from './message-catalog';

export type BoundaryStringCatalogResolution =
  | {
      catalog: BoundaryStringMessageCatalog;
      status: 'valid';
    }
  | {
      diagnostic: BoundaryStringDiagnostic;
      status: 'invalid';
    };

export type BoundaryStringCatalogState = {
  markDirty(): void;
  resolve(): BoundaryStringCatalogResolution;
  resolveForBoundary({ keys, moduleId }: {
    keys: readonly string[];
    moduleId: string;
  }): BoundaryStringCatalogResolution;
};

export function createBoundaryStringCatalogState({ readCatalog }: {
  readCatalog: () => BoundaryStringMessageCatalog;
}): BoundaryStringCatalogState {
  let generation = 0;
  let resolvedGeneration: number | undefined;
  let resolution: BoundaryStringCatalogResolution | undefined;
  let unknownProbeGeneration: number | undefined;

  function markDirty(): void {
    generation += 1;
    resolvedGeneration = undefined;
    unknownProbeGeneration = undefined;
  }

  function readAndCache(): BoundaryStringCatalogResolution {
    try {
      resolution = {
        catalog: readCatalog(),
        status: 'valid',
      };
    } catch (error) {
      if (!isBoundaryStringDiagnosticError(error)) {
        throw error;
      }
      resolution = {
        diagnostic: error.diagnostic,
        status: 'invalid',
      };
    }
    resolvedGeneration = generation;
    return resolution;
  }

  function resolve(): BoundaryStringCatalogResolution {
    if (resolvedGeneration === generation && resolution !== undefined) {
      return resolution;
    }
    return readAndCache();
  }

  function firstUnknownKey({ catalog, keys }: {
    catalog: BoundaryStringMessageCatalog;
    keys: readonly string[];
  }): string | undefined {
    return keys.find((key) => !catalog.messagesByKey.has(key));
  }

  function resolveForBoundary({ keys, moduleId }: {
    keys: readonly string[];
    moduleId: string;
  }): BoundaryStringCatalogResolution {
    let current = resolve();
    switch (current.status) {
    case 'invalid':
      return current;
    case 'valid':
      break;
    default: {
      const _exhaustive: never = current;
      throw new Error(
        `Unsupported Boundary Strings catalog resolution: ${String(_exhaustive)}`,
      );
    }
    }

    let unknownKey = firstUnknownKey({
      catalog: current.catalog,
      keys,
    });
    if (unknownKey === undefined) {
      return current;
    }

    if (unknownProbeGeneration !== generation) {
      current = readAndCache();
      unknownProbeGeneration = generation;
      switch (current.status) {
      case 'invalid':
        return current;
      case 'valid':
        break;
      default: {
        const _exhaustive: never = current;
        throw new Error(
          `Unsupported Boundary Strings catalog resolution: ${String(_exhaustive)}`,
        );
      }
      }
      unknownKey = firstUnknownKey({
        catalog: current.catalog,
        keys,
      });
      if (unknownKey === undefined) {
        return current;
      }
    }

    return {
      diagnostic: unknownMessageKeyDiagnostic({
        key: unknownKey,
        moduleId,
      }),
      status: 'invalid',
    };
  }

  return {
    markDirty,
    resolve,
    resolveForBoundary,
  };
}
