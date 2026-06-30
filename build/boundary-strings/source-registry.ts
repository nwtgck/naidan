import path from 'node:path';

import type { BoundaryStringSourceAnalysis } from './analyze';
import {
  createBoundaryId,
  createBoundaryVersion,
  type BoundaryStringBoundaryDefinition,
} from './virtual-modules';

export type BoundaryStringSourceRecord = {
  analysis: BoundaryStringSourceAnalysis;
  boundary: BoundaryStringBoundaryDefinition | undefined;
  moduleId: string;
};

export type BoundaryStringSourceRegistry = {
  getAnalysis({ moduleId }: { moduleId: string }): BoundaryStringSourceAnalysis | undefined;
  getBoundary({ boundaryId, version }: {
    boundaryId: string;
    version: string;
  }): BoundaryStringBoundaryDefinition | undefined;
  getCurrentBoundary({ moduleId }: {
    moduleId: string;
  }): BoundaryStringBoundaryDefinition | undefined;
  removeSource({ moduleId }: {
    moduleId: string;
  }): BoundaryStringSourceRecord | undefined;
  removeSourcesUnder({ directoryPath }: {
    directoryPath: string;
  }): readonly BoundaryStringSourceRecord[];
  replaceSource({ analysis, boundaryRelativeModulePath, moduleId }: {
    analysis: BoundaryStringSourceAnalysis;
    boundaryRelativeModulePath: string | undefined;
    moduleId: string;
  }): BoundaryStringSourceRecord;
  reset(): void;
};

function boundaryIdentity({ boundaryId, version }: {
  boundaryId: string;
  version: string;
}): string {
  return `${boundaryId}/${version}`;
}

function isPathWithinOrEqual({ directoryPath, filePath }: {
  directoryPath: string;
  filePath: string;
}): boolean {
  const relativePath = path.relative(directoryPath, filePath);
  return relativePath === ''
    || (
      relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
    );
}

export function createBoundaryStringSourceRegistry(): BoundaryStringSourceRegistry {
  const recordsByModuleId = new Map<string, BoundaryStringSourceRecord>();
  const currentModuleIdByBoundaryId = new Map<string, string>();
  const boundariesByIdentity = new Map<string, BoundaryStringBoundaryDefinition>();
  const boundaryIdentitiesByModuleId = new Map<string, Set<string>>();

  function createBoundary({ analysis, moduleId, relativeModulePath }: {
    analysis: BoundaryStringSourceAnalysis;
    moduleId: string;
    relativeModulePath: string;
  }): BoundaryStringBoundaryDefinition {
    const id = createBoundaryId({ moduleId: relativeModulePath });
    const existingModuleId = currentModuleIdByBoundaryId.get(id);
    if (existingModuleId !== undefined && existingModuleId !== moduleId) {
      throw new Error(
        `[naidan-boundary-strings] Boundary ID collision between ${existingModuleId} and ${moduleId}.`,
      );
    }
    return {
      id,
      keys: analysis.keys,
      moduleId,
      version: createBoundaryVersion({
        keys: analysis.keys,
        moduleId: relativeModulePath,
      }),
    };
  }

  function replaceSource({ analysis, boundaryRelativeModulePath, moduleId }: {
    analysis: BoundaryStringSourceAnalysis;
    boundaryRelativeModulePath: string | undefined;
    moduleId: string;
  }): BoundaryStringSourceRecord {
    const previous = recordsByModuleId.get(moduleId);
    const boundary = boundaryRelativeModulePath === undefined || analysis.keys.length === 0
      ? undefined
      : createBoundary({
        analysis,
        moduleId,
        relativeModulePath: boundaryRelativeModulePath,
      });

    if (previous?.boundary !== undefined && previous.boundary.id !== boundary?.id) {
      currentModuleIdByBoundaryId.delete(previous.boundary.id);
    }
    if (boundary !== undefined) {
      currentModuleIdByBoundaryId.set(boundary.id, moduleId);
      const identity = boundaryIdentity({
        boundaryId: boundary.id,
        version: boundary.version,
      });
      boundariesByIdentity.set(identity, boundary);
      const identities = boundaryIdentitiesByModuleId.get(moduleId) ?? new Set<string>();
      identities.add(identity);
      boundaryIdentitiesByModuleId.set(moduleId, identities);
    }

    const record = {
      analysis,
      boundary,
      moduleId,
    };
    recordsByModuleId.set(moduleId, record);
    return record;
  }

  function removeSource({ moduleId }: {
    moduleId: string;
  }): BoundaryStringSourceRecord | undefined {
    const record = recordsByModuleId.get(moduleId);
    if (record === undefined) {
      return undefined;
    }
    recordsByModuleId.delete(moduleId);
    if (record.boundary !== undefined) {
      currentModuleIdByBoundaryId.delete(record.boundary.id);
    }
    const identities = boundaryIdentitiesByModuleId.get(moduleId);
    if (identities !== undefined) {
      for (const identity of identities) {
        boundariesByIdentity.delete(identity);
      }
      boundaryIdentitiesByModuleId.delete(moduleId);
    }
    return record;
  }

  function removeSourcesUnder({ directoryPath }: {
    directoryPath: string;
  }): readonly BoundaryStringSourceRecord[] {
    const removed: BoundaryStringSourceRecord[] = [];
    for (const moduleId of [...recordsByModuleId.keys()]) {
      if (!isPathWithinOrEqual({ directoryPath, filePath: moduleId })) {
        continue;
      }
      const record = removeSource({ moduleId });
      if (record !== undefined) {
        removed.push(record);
      }
    }
    return removed;
  }

  function reset(): void {
    recordsByModuleId.clear();
    currentModuleIdByBoundaryId.clear();
    boundariesByIdentity.clear();
    boundaryIdentitiesByModuleId.clear();
  }

  return {
    getAnalysis({ moduleId }) {
      return recordsByModuleId.get(moduleId)?.analysis;
    },
    getBoundary({ boundaryId, version }) {
      return boundariesByIdentity.get(boundaryIdentity({ boundaryId, version }));
    },
    getCurrentBoundary({ moduleId }) {
      return recordsByModuleId.get(moduleId)?.boundary;
    },
    removeSource,
    removeSourcesUnder,
    replaceSource,
    reset,
  };
}
